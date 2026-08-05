const fs = require("fs");
const os = require("os");
const path = require("path");

describe("fast-publish", () => {
  let workspaceElement, mainModule;

  beforeEach(async () => {
    workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);
    ({ mainModule } = await atom.packages.activatePackage("fast-publish"));
  });

  it("registers its commands", () => {
    const workspaceCommands = atom.commands
      .findCommands({ target: workspaceElement })
      .map((command) => command.name);
    expect(workspaceCommands).toContain("fast-publish:stop");

    const treeView = document.createElement("div");
    treeView.classList.add("tree-view");
    workspaceElement.appendChild(treeView);
    const treeViewCommands = atom.commands
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
      atom.commands.dispatch(treeView, "fast-publish:git-patch");

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
      atom.commands.dispatch(treeView, "fast-publish:git-minor");

      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(mainModule.publish).toHaveBeenCalledTimes(1);
      expect(mainModule.publish).toHaveBeenCalledWith(__dirname, "minor");
    });
  });

  describe("publish", () => {
    let tempDir;

    const manifest = () => JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf8"));

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-publish-spec-"));
      fs.writeFileSync(
        path.join(tempDir, "package.json"),
        `${JSON.stringify({ name: "sample", version: "1.2.3" }, null, 2)}\n`,
      );
      spyOn(mainModule, "gitPrepare");
      // The guards run real git; the repository they would inspect is not what
      // these specs are about, so answer "nothing blocking" unless a spec says
      // otherwise.
      spyOn(mainModule, "blockingReason").and.resolveTo(null);
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("bumps package.json and hands off to gitPrepare", async () => {
      await mainModule.publish(tempDir, "minor");

      expect(manifest().version).toBe("1.3.0");
      expect(mainModule.gitPrepare).toHaveBeenCalledWith(tempDir, "1.3.0");
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
      expect(mainModule.gitPrepare).toHaveBeenCalledWith(tempDir, "1.2.4");
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
        atom.commands.dispatch(workspaceElement, "fast-publish:stop");
      });
      mainModule.consumeTreeViewSelection({
        selectedPaths: () => [__dirname, path.dirname(__dirname)],
      });

      const treeView = document.createElement("div");
      treeView.classList.add("tree-view");
      workspaceElement.appendChild(treeView);
      atom.commands.dispatch(treeView, "fast-publish:git-patch");

      await firstStarted;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(mainModule.publish).toHaveBeenCalledTimes(1);
    });
  });
});
