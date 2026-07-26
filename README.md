# fast-publish

Publish packages via git tags with a single command.

Bump version, commit, tag, and push to origin from the tree view.

## Features

- **Git publish**: bump version, commit, tag, and push to origin.
- **Conditional publish**: only publish if changes exist since last tag.
- **Batch publish**: run over every selected tree-view directory, with a stop command.
- **Context menu**: available from tree-view directories.

## Installation

To install `fast-publish` search for _fast-publish_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/fast-publish`.

## Commands

Commands available in `.tree-view`:

- `fast-publish:git-major`: publish a major update via git,
- `fast-publish:git-minor`: publish a minor update via git,
- `fast-publish:git-patch`: publish a patch update via git,
- `fast-publish:git-major-if`: publish a major update via git (if changed since last tag),
- `fast-publish:git-minor-if`: publish a minor update via git (if changed since last tag),
- `fast-publish:git-patch-if`: publish a patch update via git (if changed since last tag).

Commands available in `atom-workspace`:

- `fast-publish:stop`: stop the batch publish loop after the current item.

## Services

- **[tree-view.selection](https://lumine-code.github.io/docs.html#services/tree-view.selection)** (`^1.0.0`): consumed to read the selected directories that publishing commands operate on.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
