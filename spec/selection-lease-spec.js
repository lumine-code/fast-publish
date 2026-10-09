describe("Fast Publish selection service leases", () => {
  let main, hub, consumer, providers, tree;
  const paths = [__dirname, require("node:path").dirname(__dirname)];
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("fast-publish")).mainModule;
    hub = new lumine.packages.serviceHub.constructor();
    consumer = hub.consume("tree-view.selection", "^1.0.0", (provider) =>
      main.consumeTreeViewSelection(provider),
    );
    providers = [];
    tree = document.createElement("div");
    tree.className = "tree-view";
    lumine.workspace.getElement().appendChild(tree);
    // Mock the complete release boundary before dispatch: no write/tag/push runs.
    spyOn(main, "publish").and.resolveTo();
  });
  afterEach(async () => {
    consumer.dispose();
    providers.forEach((provider) => provider.dispose());
    await lumine.packages.deactivatePackage("fast-publish");
  });
  function provide(value) {
    const registration = hub.provide("tree-view.selection", "1.0.0", value);
    providers.push(registration);
    return registration;
  }

  it("keeps batch selection when one of two shared payload leases ends", async () => {
    const service = { selectedPaths: () => paths };
    const first = provide(service);
    provide(service);
    first.dispose();

    await lumine.commands.dispatch(tree, "fast-publish:git-patch");

    expect(main.publish.calls.allArgs()).toEqual(paths.map((selected) => [selected, "patch"]));
  });

  it("restores a previous live distinct selector when the latest provider ends", async () => {
    provide({ selectedPaths: () => paths });
    const latest = provide({ selectedPaths: () => [__dirname] });
    latest.dispose();

    await lumine.commands.dispatch(tree, "fast-publish:git-minor");

    expect(main.publish.calls.allArgs()).toEqual(paths.map((selected) => [selected, "minor"]));
  });

  it("does not let a retained old lease remove the same payload in a later activation", async () => {
    const service = { selectedPaths: () => paths };
    const old = provide(service);
    await lumine.packages.deactivatePackage("fast-publish");
    main = (await lumine.packages.activatePackage("fast-publish")).mainModule;
    spyOn(main, "publish").and.resolveTo();
    provide(service);
    old.dispose();

    await lumine.commands.dispatch(tree, "fast-publish:git-patch");

    expect(main.publish.calls.allArgs()).toEqual(paths.map((selected) => [selected, "patch"]));
  });

  it("selects exact surviving A-B-A edge order for actual release dispatch", async () => {
    const first = { selectedPaths: () => paths };
    provide(first);
    const middle = provide({ selectedPaths: () => [__dirname] });
    const newest = provide(first);
    await lumine.commands.dispatch(tree, "fast-publish:git-patch");
    expect(main.publish.calls.allArgs()).toEqual(paths.map((selected) => [selected, "patch"]));
    main.publish.calls.reset();

    newest.dispose();
    await lumine.commands.dispatch(tree, "fast-publish:git-patch");
    expect(main.publish.calls.allArgs()).toEqual([[__dirname, "patch"]]);
    main.publish.calls.reset();

    middle.dispose();
    await lumine.commands.dispatch(tree, "fast-publish:git-patch");
    expect(main.publish.calls.allArgs()).toEqual(paths.map((selected) => [selected, "patch"]));
  });
});
