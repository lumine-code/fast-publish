const { CompositeDisposable, Disposable } = require("lumine");
const fs = require("fs");
const path = require("path");

// A published version is always a plain `major.minor.patch`. The manifest names
// what the tree publishes as and a tag is what makes it published, so there is
// no suffix to strip and nothing to interpret — anything else is a mistake this
// package refuses to build a release on top of.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

async function readGit(operations, args, { allowedExitCodes = [0] } = {}) {
  const result = await operations.executeGit(args, { readOnly: true, allowedExitCodes });
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw Object.assign(
      new Error(result.stderr || result.stdout || `Git exited with ${result.exitCode}`),
      {
        code: "ERR_GIT_COMMAND_FAILED",
        operation: args[0],
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    );
  }
  return result;
}

// Rewrite a JSON file in place, preserving the trailing newline every manifest
// in the fleet carries. Without it the released commit fails its own
// `format:check`, and the tag would point at a commit whose CI is red.
async function writeJson(filePath, data) {
  await fs.promises.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

/**
 * Fast Publish
 * Releases a package by bumping its version, tagging that commit, and pushing.
 * The weight of the release — major, minor or patch — is chosen at the moment
 * it is cut, which is the first time it is actually known.
 */
module.exports = {
  /**
   * Activates the package and registers publishing commands.
   */
  activate() {
    this.activationGeneration = (this.activationGeneration || 0) + 1;
    this.active = true;
    this.treeView = null;
    this.stopRequested = false;
    this.disposables = new CompositeDisposable(
      lumine.commands.add("lumine-workspace", {
        "fast-publish:stop": {
          description: "Stop after the package now publishing, not part-way through it.",
          didDispatch: () => {
            this.stopRequested = true;
            lumine.notifications.addInfo("Fast Publish: stop requested after current item");
          },
        },
      }),
      lumine.commands.add(".tree-view", {
        "fast-publish:git-major": {
          description: "Release the selected packages with the major bumped.",
          didDispatch: this.forSelected((p) => this.publish(p, "major")),
        },
        "fast-publish:git-minor": {
          description: "Release the selected packages with the minor bumped.",
          didDispatch: this.forSelected((p) => this.publish(p, "minor")),
        },
        "fast-publish:git-patch": {
          description: "Release the selected packages with the patch bumped.",
          didDispatch: this.forSelected((p) => this.publish(p, "patch")),
        },
        "fast-publish:git-major-if": {
          description: "Bump the major only where there is something unreleased.",
          didDispatch: this.forSelected((p) => this.publish(p, "major-if")),
        },
        "fast-publish:git-minor-if": {
          description: "Bump the minor only where there is something unreleased.",
          didDispatch: this.forSelected((p) => this.publish(p, "minor-if")),
        },
        "fast-publish:git-patch-if": {
          description: "Bump the patch only where there is something unreleased.",
          didDispatch: this.forSelected((p) => this.publish(p, "patch-if")),
        },
      }),
    );
  },

  consumeTreeViewSelection(treeView) {
    this.treeView = treeView;
    return new Disposable(() => {
      if (this.treeView === treeView) this.treeView = null;
    });
  },

  forSelected(fn) {
    return async (e) => {
      const generation = this.activationGeneration;
      this.stopRequested = false;
      let paths = this.treeView ? this.treeView.selectedPaths() : [];
      if (!paths.length) {
        const entry = e.target.closest(".entry");
        if (entry && typeof entry.getPath === "function") {
          paths = [entry.getPath()];
        }
      }
      for (const selectedPath of paths) {
        if (!this.active || generation !== this.activationGeneration) break;
        if (this.stopRequested) {
          lumine.notifications.addHint("Fast Publish: loop stopped");
          break;
        }
        try {
          if (fs.statSync(selectedPath).isDirectory()) {
            await fn(selectedPath);
          }
        } catch {
          // Ignore stat errors
        }
      }
    };
  },

  /**
   * Deactivates the package and disposes resources.
   */
  deactivate() {
    this.active = false;
    this.stopRequested = true;
    this.disposables.dispose();
  },

  /**
   * Increments a semantic version number based on the specified mode.
   * @param {string} version - The current version string (e.g., "1.2.3")
   * @param {string} mode - The increment mode: 'major', 'minor', or 'patch'
   * @returns {string} The incremented version string
   */
  increaseVersionNumber(version, mode) {
    const match = VERSION_PATTERN.exec(String(version).trim());
    if (!match) {
      throw new Error(`"${version}" is not a plain major.minor.patch version`);
    }
    const [major, minor, patch] = match.slice(1).map(Number);
    if (mode === "major") return `${major + 1}.0.0`;
    if (mode === "minor") return `${major}.${minor + 1}.0`;
    if (mode === "patch") return `${major}.${minor}.${patch + 1}`;
    throw new Error(`Unknown release mode "${mode}"`);
  },

  /**
   * Checks if there are commits since the last git tag.
   * @param {Object} operations - The direct facade supplied to the release workflow.
   * @returns {Promise<boolean>} True if there are changes, false otherwise
   */
  async hasChangesSinceLastTag(operations) {
    const result = await readGit(operations, ["describe", "--tags", "--abbrev=0"], {
      allowedExitCodes: [0, 128],
    });
    if (result.exitCode !== 0) {
      if (/No names found|No tags can describe|cannot describe/i.test(result.stderr)) return true;
      throw new Error(result.stderr || "Unable to inspect the last release tag");
    }
    const { stdout: count } = await readGit(operations, [
      "rev-list",
      "--count",
      `${result.stdout.trim()}..HEAD`,
    ]);
    return Number(count.trim()) > 0;
  },

  /**
   * Everything that must hold before a release is cut, checked before any file
   * is touched so a refusal leaves the working tree exactly as it was.
   * @param {Object} operations - The direct facade supplied to the release workflow.
   * @param {string} tag - The tag this release would create
   * @returns {Promise<string|null>} The reason to refuse, or null to proceed
   */
  async blockingReason(operations, tag) {
    const { stdout: status } = await readGit(operations, ["status", "--porcelain"]);
    if (status.trim()) {
      return "the working tree has uncommitted changes — commit or stash them first";
    }

    const { stdout: branch } = await readGit(operations, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.trim() !== "master") {
      return `HEAD is on "${branch.trim()}" — releases are cut from master`;
    }

    const result = await readGit(operations, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
      allowedExitCodes: [0, 1],
    });
    if (result.exitCode === 0) return `tag ${tag} already exists`;

    return null;
  },

  /**
   * Commits the version bump, tags that commit, and pushes both.
   * @param {string} cwd - The working directory path
   * @param {string} version - The version string for the release
   */
  async gitPrepare(operations, cwd, version) {
    const pkgName = path.basename(cwd);
    const message = `Release version ${version}`;
    const tag = `v${version}`;

    // Stage only the files this release rewrote. Sweeping the whole tree
    // would fold unrelated work into the commit the tag points at.
    const staged = ["package.json"];
    if (fs.existsSync(path.join(cwd, "package-lock.json"))) staged.push("package-lock.json");

    await operations.stageFiles(staged);
    await operations.commit(message);
    await operations.createTag(tag, { annotated: true, message });
    await operations.push("origin", undefined, { followTags: true });
    lumine.notifications.addSuccess(`Fast Publish: ${pkgName} ${tag} published`);
  },

  /**
   * Publishes a package by updating version and triggering git release.
   * @param {string} dirPath - The directory path of the package
   * @param {string} mode - The version increment mode
   */
  async publish(dirPath, mode) {
    const pkgName = path.basename(dirPath);
    const jsonPath = path.join(dirPath, "package.json");
    try {
      const repository = await lumine.repositories.resolveForPath(dirPath);
      const roots = repository
        ? await Promise.all([
            fs.promises.realpath(repository.getWorkingDirectory()),
            fs.promises.realpath(dirPath),
          ])
        : [];
      const sameRoot =
        roots.length === 2 &&
        (process.platform === "win32"
          ? roots[0].toLowerCase() === roots[1].toLowerCase()
          : roots[0] === roots[1]);
      if (!sameRoot) {
        lumine.notifications.addWarning(`Fast Publish: ${pkgName} not released`, {
          detail: "Select the Git repository's root directory to release its package.",
          dismissable: true,
        });
        return;
      }
      await repository.getOperations().runWorkflow(
        "release",
        async (operations) => {
          if (mode.endsWith("-if")) {
            if (!(await this.hasChangesSinceLastTag(operations))) {
              lumine.notifications.addInfo(
                `Fast Publish: ${pkgName} has no changes since last tag`,
              );
              return;
            }
            mode = mode.slice(0, -3);
          }
          const manifest = await readJson(jsonPath);
          const oldVersion = manifest.version;
          const newVersion = this.increaseVersionNumber(oldVersion, mode);

          const reason = await this.blockingReason(operations, `v${newVersion}`);
          if (reason) {
            lumine.notifications.addWarning(`Fast Publish: ${pkgName} not released`, {
              detail: `Refusing because ${reason}.`,
              dismissable: true,
            });
            return;
          }

          manifest.version = newVersion;
          await writeJson(jsonPath, manifest);

          // npm records the version in the lockfile too, in both the root object
          // and the entry for the package itself; leaving them behind makes every
          // later install report a mismatch.
          const lockPath = path.join(dirPath, "package-lock.json");
          if (fs.existsSync(lockPath)) {
            const lock = await readJson(lockPath);
            if (lock.version) lock.version = newVersion;
            if (lock.packages && lock.packages[""]) lock.packages[""].version = newVersion;
            await writeJson(lockPath, lock);
          }

          lumine.notifications.addInfo(
            `Fast Publish: version updated from v${oldVersion} to v${newVersion}`,
          );
          await this.gitPrepare(operations, dirPath, newVersion);
        },
        { refresh: "both" },
      );
    } catch (err) {
      lumine.notifications.addError(`Fast Publish: ${pkgName} failed`, {
        detail: err.message,
        dismissable: true,
      });
    }
  },
};
