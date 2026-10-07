const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const exec = promisify(execFile);

describe("fast-publish", () => {
  let workspaceElement, mainModule;

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    ({ mainModule } = await lumine.packages.activatePackage("fast-publish"));
  });

  it("registers its commands", () => {
    const workspaceCommands = lumine.commands
      .findCommands({ target: workspaceElement })
      .map((command) => command.name);
    expect(workspaceCommands).toContain("fast-publish:stop");

    const treeView = document.createElement("div");
    treeView.classList.add("tree-view");
    workspaceElement.appendChild(treeView);
    const treeViewCommands = lumine.commands
      .findCommands({ target: treeView })
      .map((command) => command.name);
    for (const mode of ["major", "minor", "patch"]) {
      expect(treeViewCommands).toContain(`fast-publish:git-${mode}`);
      expect(treeViewCommands).toContain(`fast-publish:git-${mode}-if`);
    }
  });

  describe("increaseVersionNumber", () => {
    it("bumps the major version and resets minor and patch", () => {
      expect(mainModule.increaseVersionNumber("1.2.3", "major")).toBe("2.0.0");
    });

    it("bumps the minor version and resets patch", () => {
      expect(mainModule.increaseVersionNumber("1.2.3", "minor")).toBe("1.3.0");
    });

    it("bumps the patch version", () => {
      expect(mainModule.increaseVersionNumber("1.2.3", "patch")).toBe("1.2.4");
    });

    // A published version is always plain major.minor.patch, so anything
    // carrying a suffix is a mistake rather than something to interpret.
    it("refuses a version that is not plain major.minor.patch", () => {
      expect(() => mainModule.increaseVersionNumber("1.2.3-dev", "patch")).toThrow();
      expect(() => mainModule.increaseVersionNumber("1.2", "patch")).toThrow();
      expect(() => mainModule.increaseVersionNumber("1.2.3", "sideways")).toThrow();
    });
  });

  describe("the consumed tree-view service", () => {
    it("publishes every selected directory", async () => {
      const disposable = mainModule.consumeTreeViewSelection({ selectedPaths: () => [__dirname] });
      spyOn(mainModule, "publish");

      const treeView = document.createElement("div");
      treeView.classList.add("tree-view");
      workspaceElement.appendChild(treeView);
      lumine.commands.dispatch(treeView, "fast-publish:git-patch");

      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(mainModule.publish).toHaveBeenCalledWith(__dirname, "patch");

      disposable.dispose();
      expect(mainModule.treeView).toBeNull();
    });

    it("skips selected files, publishing directories only", async () => {
      mainModule.consumeTreeViewSelection({ selectedPaths: () => [__filename, __dirname] });
      spyOn(mainModule, "publish");

      const treeView = document.createElement("div");
      treeView.classList.add("tree-view");
      workspaceElement.appendChild(treeView);
      lumine.commands.dispatch(treeView, "fast-publish:git-minor");

      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(mainModule.publish).toHaveBeenCalledTimes(1);
      expect(mainModule.publish).toHaveBeenCalledWith(__dirname, "minor");
    });
  });

  describe("publish", () => {
    let tempDir;
    let operations, runWorkflow;

    const manifest = () => JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf8"));

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-publish-spec-"));
      fs.writeFileSync(
        path.join(tempDir, "package.json"),
        `${JSON.stringify({ name: "sample", version: "1.2.3" }, null, 2)}\n`,
      );
      spyOn(mainModule, "gitPrepare");
      operations = {};
      runWorkflow = jasmine
        .createSpy("runWorkflow")
        .and.callFake(async (name, callback) => callback(operations));
      spyOn(lumine.repositories, "resolveForPath").and.resolveTo({
        getWorkingDirectory: () => tempDir,
        getOperations: () => ({ runWorkflow }),
      });
      // The guards run real git; the repository they would inspect is not what
      // these specs are about, so answer "nothing blocking" unless a spec says
      // otherwise.
      spyOn(mainModule, "blockingReason").and.resolveTo(null);
    });

    afterEach(() => {
      // Retries because Windows keeps a directory non-empty until the last handle on a
      // child closes, and `force` swallows only ENOENT.
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("bumps package.json and hands off to gitPrepare", async () => {
      await mainModule.publish(tempDir, "minor");

      expect(manifest().version).toBe("1.3.0");
      expect(mainModule.gitPrepare).toHaveBeenCalledWith(operations, tempDir, "1.3.0");
      const workflow = runWorkflow.calls.mostRecent().args;
      expect(workflow[0]).toBe("release");
      expect(typeof workflow[1]).toBe("function");
      expect(workflow[2]).toEqual({ refresh: "both" });
    });

    // Every manifest in the fleet ends with a newline. Writing one without it
    // makes the released commit fail its own format check, so the tag would
    // point at a commit whose CI is red.
    it("keeps the trailing newline on the manifest it rewrites", async () => {
      await mainModule.publish(tempDir, "patch");
      expect(fs.readFileSync(path.join(tempDir, "package.json"), "utf8").endsWith("}\n")).toBe(
        true,
      );
    });

    it("carries the new version into the lockfile", async () => {
      const lockPath = path.join(tempDir, "package-lock.json");
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ name: "sample", version: "1.2.3", packages: { "": { version: "1.2.3" } } }, null, 2)}\n`,
      );

      await mainModule.publish(tempDir, "major");

      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      expect(lock.version).toBe("2.0.0");
      expect(lock.packages[""].version).toBe("2.0.0");
    });

    it("leaves the manifest untouched when something blocks the release", async () => {
      mainModule.blockingReason.and.resolveTo("the working tree has uncommitted changes");

      await mainModule.publish(tempDir, "minor");

      expect(manifest().version).toBe("1.2.3");
      expect(mainModule.gitPrepare).not.toHaveBeenCalled();
    });

    it("skips -if modes when nothing changed since the last tag", async () => {
      spyOn(mainModule, "hasChangesSinceLastTag").and.resolveTo(false);
      await mainModule.publish(tempDir, "patch-if");

      expect(manifest().version).toBe("1.2.3");
      expect(mainModule.gitPrepare).not.toHaveBeenCalled();
    });

    it("publishes -if modes when changes exist since the last tag", async () => {
      spyOn(mainModule, "hasChangesSinceLastTag").and.resolveTo(true);
      await mainModule.publish(tempDir, "patch-if");

      expect(manifest().version).toBe("1.2.4");
      expect(mainModule.gitPrepare).toHaveBeenCalledWith(operations, tempDir, "1.2.4");
    });
  });

  describe("fast-publish:stop", () => {
    it("stops the batch loop after the current item", async () => {
      let resolveFirst;
      const firstStarted = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      spyOn(mainModule, "publish").and.callFake(async () => {
        resolveFirst();
        lumine.commands.dispatch(workspaceElement, "fast-publish:stop");
      });
      mainModule.consumeTreeViewSelection({
        selectedPaths: () => [__dirname, path.dirname(__dirname)],
      });

      const treeView = document.createElement("div");
      treeView.classList.add("tree-view");
      workspaceElement.appendChild(treeView);
      lumine.commands.dispatch(treeView, "fast-publish:git-patch");

      await firstStarted;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(mainModule.publish).toHaveBeenCalledTimes(1);
    });
  });

  it("serializes complete releases and pushes their matching commits and annotated tags", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fast-publish-workflow-"));
    const workingDirectory = path.join(directory, "package");
    const remoteDirectory = path.join(directory, "remote.git");
    const git = async (args, cwd = workingDirectory) =>
      (await exec(lumine.config.get("git.path") || "git", args, { cwd })).stdout.trim();
    fs.mkdirSync(workingDirectory);
    try {
      await git(["init", "--bare", remoteDirectory], directory);
      await git(["init", "--initial-branch=master"]);
      await git(["config", "user.name", "Test Author"]);
      await git(["config", "user.email", "test@example.test"]);
      await git(["config", "commit.gpgSign", "false"]);
      await git(["config", "tag.gpgSign", "false"]);
      fs.writeFileSync(
        path.join(workingDirectory, "package.json"),
        '{"name":"sample","version":"1.2.3"}\n',
      );
      await git(["add", "package.json"]);
      await git(["commit", "-m", "Create a test package"]);
      await git(["remote", "add", "origin", remoteDirectory]);
      await git(["push", "--set-upstream", "origin", "master"]);
      const errors = spyOn(lumine.notifications, "addError");
      const warnings = spyOn(lumine.notifications, "addWarning");

      await Promise.all([
        mainModule.publish(workingDirectory, "patch"),
        mainModule.publish(workingDirectory, "minor"),
      ]);

      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
      const tags = (await git(["tag", "--list", "v*"])).split("\n");
      expect(tags.length).toBe(2);
      const taggedVersions = await Promise.all(
        tags.map(async (tag) => {
          expect(await git(["cat-file", "-t", tag])).toBe("tag");
          return JSON.parse(await git(["show", `${tag}:package.json`])).version;
        }),
      );
      // Discovery can finish in either order; both releases must read the
      // manifest after the previous release, rather than overwrite the same version.
      expect(["1.2.4,1.3.0", "1.3.0,1.3.1"]).toContain(taggedVersions.join(","));
      expect(
        JSON.parse(fs.readFileSync(path.join(workingDirectory, "package.json"), "utf8")).version,
      ).toBe(taggedVersions.at(-1));
      expect(await git(["rev-parse", "HEAD"])).toBe(
        await git(["rev-parse", "refs/heads/master"], remoteDirectory),
      );
      expect(await git(["status", "--porcelain"])).toBe("");
    } finally {
      const repository = lumine.repositories.getForPath(workingDirectory);
      repository?.destroy();
      await lumine.fileWatchClient.settlePendingTeardown();
      // Git makes object files read-only; clear that bit before Windows cleanup.
      for (const relativePath of fs.readdirSync(directory, { recursive: true })) {
        fs.chmodSync(path.join(directory, relativePath), 0o700);
      }
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
