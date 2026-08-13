const { CompositeDisposable, Disposable, BufferedProcess } = require("lumine");
const fs = require("fs");
const path = require("path");

// A published version is always a plain `major.minor.patch`. The manifest names
// what the tree publishes as and a tag is what makes it published, so there is
// no suffix to strip and nothing to interpret — anything else is a mistake this
// package refuses to build a release on top of.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function execBuffered(command, args, options) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const proc = new BufferedProcess({
      command,
      args,
      options,
      stdout: (data) => {
        stdout += data;
      },
      stderr: (data) => {
        stderr += data;
      },
      exit: (code) => {
        if (code === 0) resolve({ stdout });
        else {
          const err = new Error(stderr || stdout || `Exit code ${code}`);
          err.stderr = stderr;
          reject(err);
        }
      },
    });
    proc.onWillThrowError(({ error, handle }) => {
      handle();
      reject(error);
    });
  });
}

// The system git binary, honoring the core `git.path` setting.
function gitBinary() {
  return lumine.config.get("git.path") || "git";
}

function execGit(args, cwd) {
  return execBuffered(gitBinary(), args, { cwd });
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
    this.treeView = null;
    this.stopRequested = false;
    this.disposables = new CompositeDisposable(
      lumine.commands.add("lumine-workspace", {
        "fast-publish:stop": () => {
          this.stopRequested = true;
          lumine.notifications.addInfo("Fast Publish: stop requested after current item");
        },
      }),
      lumine.commands.add(".tree-view", {
        "fast-publish:git-major": this.forSelected((p) => this.publish(p, "major")),
        "fast-publish:git-minor": this.forSelected((p) => this.publish(p, "minor")),
        "fast-publish:git-patch": this.forSelected((p) => this.publish(p, "patch")),
        "fast-publish:git-major-if": this.forSelected((p) => this.publish(p, "major-if")),
        "fast-publish:git-minor-if": this.forSelected((p) => this.publish(p, "minor-if")),
        "fast-publish:git-patch-if": this.forSelected((p) => this.publish(p, "patch-if")),
      }),
    );
  },

  consumeTreeViewSelection(treeView) {
    this.treeView = treeView;
    return new Disposable(() => {
      this.treeView = null;
    });
  },

  forSelected(fn) {
    return async (e) => {
      this.stopRequested = false;
      let paths = this.treeView ? this.treeView.selectedPaths() : [];
      if (!paths.length) {
        const entry = e.target.closest(".entry");
        if (entry && typeof entry.getPath === "function") {
          paths = [entry.getPath()];
        }
      }
      for (const selectedPath of paths) {
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
   * @param {string} cwd - The working directory path
   * @returns {Promise<boolean>} True if there are changes, false otherwise
   */
  async hasChangesSinceLastTag(cwd) {
    try {
      const { stdout: lastTag } = await execGit(["describe", "--tags", "--abbrev=0"], cwd);
      const { stdout: count } = await execGit(
        ["rev-list", "--count", `${lastTag.trim()}..HEAD`],
        cwd,
      );
      return Number(count.trim()) > 0;
    } catch {
      // Never released, so everything in the repository is unreleased work.
      return true;
    }
  },

  /**
   * Everything that must hold before a release is cut, checked before any file
   * is touched so a refusal leaves the working tree exactly as it was.
   * @param {string} cwd - The working directory path
   * @param {string} tag - The tag this release would create
   * @returns {Promise<string|null>} The reason to refuse, or null to proceed
   */
  async blockingReason(cwd, tag) {
    const { stdout: status } = await execGit(["status", "--porcelain"], cwd);
    if (status.trim()) {
      return "the working tree has uncommitted changes — commit or stash them first";
    }

    const { stdout: branch } = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (branch.trim() !== "master") {
      return `HEAD is on "${branch.trim()}" — releases are cut from master`;
    }

    try {
      await execGit(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], cwd);
      return `tag ${tag} already exists`;
    } catch {
      // The tag is free, which is what we want.
    }

    return null;
  },

  /**
   * Commits the version bump, tags that commit, and pushes both.
   * @param {string} cwd - The working directory path
   * @param {string} version - The version string for the release
   */
  async gitPrepare(cwd, version) {
    const pkgName = path.basename(cwd);
    const message = `Release version ${version}`;
    const tag = `v${version}`;

    try {
      // Stage only the files this release rewrote. Sweeping the whole tree
      // would fold unrelated work into the commit the tag points at.
      const staged = ["package.json"];
      if (fs.existsSync(path.join(cwd, "package-lock.json"))) staged.push("package-lock.json");

      await execGit(["add", "--", ...staged], cwd);
      await execGit(["commit", "-m", message], cwd);
      await execGit(["tag", "-a", tag, "-m", message], cwd);
      await execGit(["push", "origin", "--follow-tags"], cwd);
      lumine.notifications.addSuccess(`Fast Publish: ${pkgName} ${tag} published`);
    } catch (err) {
      lumine.notifications.addError(`Fast Publish: ${pkgName} failed`, {
        detail: err.stderr || err.message,
        dismissable: true,
      });
    }
  },

  /**
   * Publishes a package by updating version and triggering git release.
   * @param {string} dirPath - The directory path of the package
   * @param {string} mode - The version increment mode
   */
  async publish(dirPath, mode) {
    const pkgName = path.basename(dirPath);
    if (mode.endsWith("-if")) {
      const hasChanges = await this.hasChangesSinceLastTag(dirPath);
      if (!hasChanges) {
        lumine.notifications.addInfo(`Fast Publish: ${pkgName} has no changes since last tag`);
        return;
      }
      mode = mode.slice(0, -3);
    }

    const jsonPath = path.join(dirPath, "package.json");
    try {
      const manifest = await readJson(jsonPath);
      const oldVersion = manifest.version;
      const newVersion = this.increaseVersionNumber(oldVersion, mode);

      const reason = await this.blockingReason(dirPath, `v${newVersion}`);
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
      await this.gitPrepare(dirPath, newVersion);
    } catch (err) {
      lumine.notifications.addError(`Fast Publish: ${pkgName} failed`, {
        detail: err.message,
        dismissable: true,
      });
    }
  },
};
