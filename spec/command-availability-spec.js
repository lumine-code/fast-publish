const { CompositeDisposable } = require("lumine");
describe("Fast Publish command availability", () => {
  let main, target, leases, snapshot, paths;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("fast-publish")).mainModule;
    target = document.createElement("div");
    target.className = "tree-view";
    lumine.workspace.getElement().appendChild(target);
    leases = new CompositeDisposable();
    snapshot = { count: 0, directoryCount: 0, paths: [] };
    paths = jasmine.createSpy("materialize selection").and.returnValue([__dirname]);
    leases.add(
      main.consumeTreeViewSelection({ getSelectionSnapshot: () => snapshot, selectedPaths: paths }),
    );
  });
  afterEach(() => {
    leases.dispose();
    target.remove();
  });
  it("uses cached folders and disables competing releases while permitting Stop", async () => {
    const has = (id) => lumine.commands.canDispatch(target, "fast-publish:" + id);
    expect(has("git-patch")).toBe(false);
    expect(has("stop")).toBe(false);
    snapshot = { count: 1, directoryCount: 1 };
    expect(has("git-patch")).toBe(true);
    expect(paths).not.toHaveBeenCalled();
    let finish;
    const pending = new Promise((resolve) => (finish = resolve)),
      publish = jasmine.createSpy("release stub").and.returnValue(pending);
    const running = main.forSelected(publish)({ target });
    expect(has("git-patch")).toBe(false);
    expect(has("stop")).toBe(true);
    await main.forSelected(publish)({ target });
    expect(publish).toHaveBeenCalledTimes(1);
    finish();
    await running;
    expect(has("git-patch")).toBe(true);
    expect(has("stop")).toBe(false);
  });
});
