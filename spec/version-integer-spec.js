const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("Fast Publish version integer preservation", () => {
  let main;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("fast-publish")).mainModule;
  });

  it("increments plain decimal components without Number precision loss", () => {
    expect(main.increaseVersionNumber("1.2.9007199254740992", "patch")).toBe(
      "1.2.9007199254740993",
    );
    expect(main.increaseVersionNumber("9007199254740992.2.3", "major")).toBe(
      "9007199254740993.0.0",
    );
    expect(main.increaseVersionNumber("1." + "9".repeat(309) + ".3", "minor")).toBe(
      "1.1" + "0".repeat(309) + ".0",
    );
  });

  it("writes the exact bumped string through a real manifest release workflow", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fast-version-control-"));
    const manifestPath = path.join(directory, "package.json");
    fs.writeFileSync(manifestPath, '{"name":"sample","version":"1.2.9007199254740992"}\n');
    // Replace every Git/remote boundary before starting; only this owned fixture is written.
    const operations = {};
    spyOn(lumine.repositories, "resolveForPath").and.resolveTo({
      getWorkingDirectory: () => directory,
      getOperations: () => ({ runWorkflow: async (_name, callback) => callback(operations) }),
    });
    spyOn(main, "blockingReason").and.resolveTo(null);
    spyOn(main, "gitPrepare").and.resolveTo();
    try {
      await main.publish(directory, "patch");
      expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).version).toBe(
        "1.2.9007199254740993",
      );
      expect(main.gitPrepare).toHaveBeenCalledWith(operations, directory, "1.2.9007199254740993");
    } finally {
      fs.unlinkSync(manifestPath);
      fs.rmdirSync(directory);
    }
  });
});
