# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## Portable Windows build

The portable package keeps the desktop profile, OpenCode data, configuration,
cache, state, and temporary files in a `home` directory beside the extracted
application. It does not replace the host user's `APPDATA` or `USERPROFILE`.

```bash
OPENCODE_CHANNEL=prod bun run build
OPENCODE_CHANNEL=prod bun run package:win:portable
```

The resulting `*-portable.zip` contains a `portable.flag` marker. Moving the
folder to another Windows drive automatically updates persisted project and
session drive roots on the next launch. Portable builds disable the installer
auto-updater and are updated by replacing the application files while retaining
the `home` directory.
