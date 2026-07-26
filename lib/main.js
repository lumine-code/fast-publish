const { CompositeDisposable, Disposable, BufferedProcess } = require("atom");
const fs = require("fs");
const path = require("path");

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
  return atom.config.get("git.path") || "git";
}

function execGit(args, cwd) {
  return execBuffered(gitBinary(), args, { cwd });
}

// Remove stale git index.lock file if it exists
function removeGitLockFile(repoPath) {
  const lockFile = path.join(repoPath, ".git", "index.lock");
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      return true;
    }
  } catch {
    // Ignore errors
  }
  return false;
}

/**
 * Fast Publish
 * Provides automated version bumping and git tagging for package releases.
 * Supports major, minor, and patch version increments.
 */
module.exports = {
  /**
   * Activates the package and registers publishing commands.
   */
  activate() {
    this.treeView = null;
    this.stopRequested = false;
    this.disposables = new CompositeDisposable(
      atom.commands.add("atom-workspace", {
        "fast-publish:stop": () => {
          this.stopRequested = true;
          atom.notifications.addInfo("Fast Publish: stop requested after current item");
        },
      }),
      atom.commands.add(".tree-view", {
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
          atom.notifications.addInfo("Fast Publish: loop stopped");
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
    version = version.split(".");
    if (mode === "major") {
      version[0] = parseInt(version[0]) + 1;
      version[1] = "0";
      version[2] = "0";
    } else if (mode === "minor") {
      version[1] = parseInt(version[1]) + 1;
      version[2] = "0";
    } else if (mode === "patch") {
      version[2] = parseInt(version[2]) + 1;
    }
    return version.join(".");
  },

  /**
   * Checks if there are changes since the last git tag.
   * @param {string} cwd - The working directory path
   * @returns {Promise<boolean>} True if there are changes, false otherwise
   */
  async hasChangesSinceLastTag(cwd) {
    removeGitLockFile(cwd);
    try {
      const { stdout: lastTag } = await execGit(["describe", "--tags", "--abbrev=0"], cwd);
      const { stdout: diff } = await execGit(["diff", `${lastTag.trim()}..HEAD`, "--stat"], cwd);
      return diff.trim().length > 0;
    } catch {
      // No tags exist or other error - assume there are changes
      return true;
    }
  },

  /**
   * Prepares and executes git commands for version release.
   * Adds all files, commits, tags, and pushes to origin.
   * @param {string} cwd - The working directory path
   * @param {string} version - The version string for the release
   */
  async gitPrepare(cwd, version) {
    const pkgName = path.basename(cwd);
    const commitMessage = `Prepare v${version} release`;
    const tag = `v${version}`;

    // Remove stale lock file before git operations
    removeGitLockFile(cwd);

    try {
      await execGit(["add", "--all"], cwd);
      await execGit(["commit", "--all", "-m", commitMessage], cwd);
      await execGit(["tag", "-a", tag, "-m", commitMessage], cwd);
      await execGit(["push", "origin", "--follow-tags"], cwd);
      atom.notifications.addSuccess(`Fast Publish: ${pkgName} v${version} published`);
    } catch (err) {
      atom.notifications.addError(`Fast Publish: failed`, {
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
        atom.notifications.addInfo(`Fast Publish: ${pkgName} has no changes since last tag`);
        return;
      }
      mode = mode.slice(0, -3);
    }
    const jsonPath = path.join(dirPath, "package.json");
    try {
      const content = await fs.promises.readFile(jsonPath, "utf8");
      const data = JSON.parse(content);
      const oldVersion = data.version;
      const newVersion = this.increaseVersionNumber(oldVersion, mode);
      data.version = newVersion;
      await fs.promises.writeFile(jsonPath, JSON.stringify(data, null, 2), "utf8");
      atom.notifications.addInfo(
        `Fast Publish: version updated from v${oldVersion} to v${newVersion}`,
      );
      await this.gitPrepare(dirPath, newVersion);
    } catch (err) {
      atom.notifications.addError("Fast Publish: failed", {
        detail: err.message,
        dismissable: true,
      });
    }
  },
};
