# Cursor Atelier

Cursor Atelier is a quiet, local cursor manager for macOS and Linux. Its
Electron interface provides search, real cursor previews, light/dark cursor
assignments, and Restore. macOS uses the signed Objective-C cursor engine;
Linux installs Xcursor themes and applies them through the desktop's settings.

Build the app locally from this repository. Prebuilt releases are not provided
yet. Distribution signing, notarization, update delivery, and the Remus, Drop,
and Moga licensing review described in
[CURSOR_PACK_NOTICES.md](CURSOR_PACK_NOTICES.md) remain release concerns.

## What is included

- No `.cursor` resources or bulk preview corpus in the packaged app. The native
  bridge starts with an empty library and discovers packs from the private
  per-user application store.
- A first-run chooser for 15 curated families. It embeds only three small
  static previews per family (45 PNGs total). The representative artwork is
  preview-only: selecting a family obtains and converts every curated variant
  in that family.
- A locked catalogue of original upstream source inputs. The app authenticates
  pinned repository/source archives, then runs the existing source-specific,
  maximum-quality recipes locally. Cursor Atelier does not host or download
  preconverted `.cursor` derivatives.
- Local import for compiled Xcursor directories and ZIP/tar archives,
  compatible Mousecape `.cape` files, and compiled macOS `.cursor` themes.
  Low-resolution Xcursor artwork is conservatively reconstructed while genuine
  source tiers, hotspots, animation order, and timing are preserved.
- Build recipes and provenance for the full 240-variant source corpus: 19 Oreo
  themes and 221 external conversions. The released converter contains the
  recipes, not the generated cursor payloads.
- All 47 native cursor identifiers for every installed pack. Imports are
  normalized to the same 47-role contract and receive local PNG/APNG previews.
- Looping APNG previews for animated states, using source-cycle-preserving
  timing from the applied cursor (rounded to APNG milliseconds).
- A searchable two-pane workspace with independently scrolling rail/detail
  panes, restrained surfaces, and consistent squircle controls.
- A persisted Light/System/Dark appearance selector.
- An explicit, opt-in **Run in Background at Startup** setting; Command-Q
  still exits the main app without dismantling its separately managed cursor
  helper on macOS. On Linux the app supplies background appearance changes.
- Portable export/import of installed cursors and settings, plus a recoverable
  full reset to the first-run experience. Import restores the saved desktop
  cursor rather than applying the archived selection.
- Truthful selected, requested, and live-verified active states. Preview mode
  never changes system cursors or presents a selection as active.
- Atomic theme application, transactional rollback/recovery, login-item
  persistence, and complete teardown back to the saved desktop cursor.

Architecture decisions and current verification are recorded in
[ARCHITECTURE.md](ARCHITECTURE.md) and
[PROGRESS_TRACKER.md](PROGRESS_TRACKER.md). Source and license provenance is in
[CURSOR_PACK_NOTICES.md](CURSOR_PACK_NOTICES.md). Renderer conventions are in
[the typography system](docs/typography-design-system.md) and
[the shape system](docs/shape-design-system.md).

## Stack

- Electron 43, Electron Forge, and Vite
- React 19
- Tailwind CSS 4 and shadcn/Radix primitives
- Zustand for persisted appearance and TanStack Query for native data
- ESLint, Vitest, Python `unittest`, and Playwright

The app has one renderer route and does not use React Router.

## Linux: build, install, use

Linux support targets glibc distributions on x86-64 or ARM64. Omarchy/Hyprland
is the primary Linux environment (Hyprland 0.55 or newer, including its Lua
control API). GNOME and KDE Plasma use their native
settings interfaces; those desktop integrations need broader live testing.
Other compositors are not automatically treated as supported. Hyprland uses
`hyprctl` and GSettings; GNOME uses GSettings; Plasma 6 uses `kreadconfig6`,
`kwriteconfig6`, and `plasma-apply-cursortheme`. Desktop appearance is read
through `gdbus` and the standard XDG Settings portal supplied by your desktop.

Install Node.js 22 LTS (22.12 or newer in that major) with npm, Python 3.10 or newer with venv support,
binutils, and the desktop libraries used by Electron. For example:

```sh
# Omarchy / Arch
sudo pacman -S --needed python binutils gtk3 nss alsa-lib glib2 desktop-file-utils

# Ubuntu 24.04+ / Debian 13 (install a current Node.js separately if needed)
sudo apt install python3 python3-venv binutils libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libglib2.0-bin desktop-file-utils

# Fedora
sudo dnf install python3 binutils gtk3 nss alsa-lib mesa-libgbm glib2 desktop-file-utils
```

Use `.nvmrc` with your Node version manager (`nvm install && nvm use`, or
`mise install node@22` and `mise exec node@22 -- npm ...`). The pinned Forge
extractor currently [fails with newer Node stream semantics](https://github.com/max-mapper/extract-zip/issues/154);
Node 22 LTS is the verified build runtime.

Download or clone the repository, open a terminal inside it, then:

```sh
npm ci
npm run package
npm run app:install
```

The package command builds the existing frozen converter, compiles the app,
and verifies its executable architecture, native importer dependencies,
converter self-test, and complete file hashes. Python, Pillow, and the Clickgen
Xcursor encoder are bundled in the converter; the installed app does not use
xcursorgen, system Python, a global pip installation, or a separate SVG
conversion recipe. Build on the OS and CPU that will run the app:
[PyInstaller does not bundle glibc](https://pyinstaller.org/en/stable/usage.html#making-gnu-linux-apps-forward-compatible).
`CURSOR_ATELIER_PYTHON=/path/to/python3` selects another build interpreter.

The installer launches the installed app and adds **Cursor Atelier** to your
application launcher. It uses `$XDG_DATA_HOME/cursor-atelier/app` (normally
`~/.local/share/cursor-atelier/app`) and `~/.local/bin/cursor-atelier`. It runs
without sudo, preserves app data, stops the old running app during an update,
keeps its prior build recoverable, and rolls back if the new app fails its
isolated renderer check or cannot confirm its running identity. Each package
has a distinct increasing build identity in `resources/build-info.json`.

For an update, pull/download the new source, repeat the three commands above,
then verify and clear the staging artifacts using recoverable Trash:

```sh
npm run package:clean -- --dry-run
npm run package:clean
```

The installed copy remains authoritative; `out.noindex` is staging output.
`npm run make` also creates a ZIP for the current Linux architecture. There is
no installer download or automatic update service yet.

For development, `npm start` opens the same UI and prepares the frozen
converter on first use. `npm run native:build` explicitly rebuilds Linux
converter/assets; `npm run native:preflight` checks local dependencies.
The full 240-theme developer corpus is optional and is never downloaded by
`npm ci`, `npm start`, or `npm run package`.

Run in Background at Startup uses an XDG autostart entry. This is supported by
Omarchy's UWSM session, GNOME, and KDE; no root service is installed. A selected
cursor also keeps the startup registration. At login it selects the cursor
assigned to the current desktop light/dark appearance, falling back to the
selected cursor when that assignment is absent or unavailable, even when the
separate background-startup preference is off. Restore removes that
cursor-persistence requirement. Linux application data normally lives in
`~/.config/Cursor Atelier`; XDG base
directory overrides are respected. Cursor application state is stored in
`linux-cursors/state.json`, and generated themes use owned `~/.icons/cursor-atelier-*`
directories. On Omarchy an owned `theme-set.d/cursor-atelier` hook reapplies the
selected cursor after desktop theme changes and is removed by Restore. Quit stops background appearance changes;
the installed cursor theme remains selected until Restore or another desktop
setting changes it. Some already-open applications cache cursors and may need
to be reopened after a theme change.

## macOS: local build

Requirements are macOS 13 or newer, Node.js 22 LTS/npm, Xcode or the Xcode Command
Line Tools, and a stable Apple-issued development signing identity. Python,
Pillow, and librsvg are developer requirements for rebuilding/comparing the
full source corpus; the packaged app's converter is self-contained.

```sh
brew install librsvg
npm ci
python3 -m pip install -r native/oreo/ArtworkSource/requirements.txt
OREO_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" npm run native:build
npm run curated:build
npm start
```

The native build keeps the `package.json` version as the visible release
version and automatically stamps a distinct UTC numeric build identity into
the Electron app, native app, and login helper. CI may provide a monotonic
`CURSOR_ATELIER_BUILD_VERSION`; do not reuse an identity from an older build.
On the first packaged launch after replacement, Cursor Atelier reconciles its
registered login helper so code resident from the prior build is terminated
and the current helper is registered before cursor controls are used.

The older developer corpus command can still populate and verify all upstream
inputs at once for equivalence testing. The released app instead uses the
locked JavaScript acquisition layer to fetch only user-selected families:

```sh
python3 native/cursor-packs/acquire_sources.py --verify-only
```

For the personal packaged app:

```sh
npm run native:preflight
npm run curated:verify
npm run package
npm run make
```

Forge runs the native preflight for `package` and `make`. It uses the nested
native app's Apple Development identity for the outer Electron app, then
preserves the signatures on the nested native app and login helper. All three
bundles must have the same nonempty TeamIdentifier and keep their distinct
bundle identifiers. No Developer ID distribution certificate or notarization
is needed for this personal local build.

Forge writes its staging output under `out.noindex`; neither command installs
or opens the app. The `.noindex` suffix keeps the staged bundle out of Spotlight
so it cannot appear beside the real installation in app search. Install the
resulting outer `Cursor Atelier.app` at `/Applications/Cursor Atelier.app`
before assigning a cursor, because its nested `SMAppService` login item is
registered from that location. Never use the staged copy as the interactive
app; the isolated packaged smoke test is the only exception and disables
login-item registration while using temporary user state.

After the installed app and its login helper are verified on the new build,
unregister and move the staging output to Trash with:

```sh
npm run package:clean -- --dry-run
npm run package:clean
```

When adopting this workflow in a checkout that still has the former `out`
directory, include it in the same recoverable cleanup once:

```sh
npm run package:clean -- --include-legacy --dry-run
npm run package:clean -- --include-legacy
```

### Replacing the proof of concept

Do not run Cursor Atelier alongside the earlier
`io.github.mapleroyal.OreoCursor` login helper. Use that app's own `--teardown`
command before assigning a cursor in Cursor Atelier. If the old command reports
a pending same-boot recovery or a cursor-removal error, restart macOS before
running its teardown once more. Cursor Atelier intentionally does not read or
migrate the proof of concept's preferences, snapshots, or login item.

## Native availability

On macOS, the production bridge lives in the nested signed app outside
`app.asar`. On Linux, the desktop adapter is part of the Electron main process
and encodes the final theme with the bundled Clickgen runtime. If the platform
component or its required desktop interface is unavailable, cursor assignment
and Restore are unavailable and the UI does not claim a system cursor is active.

On first run, Cursor Atelier obtains only the curated families selected by the
user. It downloads their pinned original upstream inputs over HTTPS, verifies
them, runs the bundled source-specific converter locally, and transactionally
installs each completed variant. Arbitrary user imports instead use the general
compiled Xcursor pipeline described below.

See [native/README.md](native/README.md) for the build and manifest contract.

## Importing local cursor packs

Choose **Import** and select one of these local sources. Linux offers
**Import File** and **Import Folder** separately to match native file dialogs:

- an extracted compiled Xcursor theme directory;
- a ZIP, `.tar`, `.tar.gz`/`.tgz`, or `.tar.xz`/`.txz` archive containing one
  or more compiled Xcursor themes;
- a compatible Mousecape `.cape` file; or
- a compiled macOS `.cursor` property list.

Archives from cursor sites commonly contain several variants; each discovered
variant is imported separately. When an archive contains both Xcursor and
Mousecape versions, Cursor Atelier prefers Xcursor so it can preserve the
source's native resolution tiers and hotspots.

The importer tolerates conventional nesting, Xcursor aliases, resolution
tiers, animation lengths/timing, and harmless canvas variation. Authentic
tiers are never replaced. If an Xcursor pack stops below the app's 128px tier,
the importer uses an alpha-safe no-halo reconstruction baseline and adopts a
pack-learned filter only when held-out roles prove it improves quality; roles
that regress retain the baseline. It then normalizes each variant to the same
47-role native contract, generates static PNG or looping APNG role previews,
verifies the resource and manifest, and atomically installs the result under
the per-user `ImportedPacks` store (`~/Library/Application Support/Cursor Atelier`
on macOS; `~/.config/Cursor Atelier` on Linux). Imported packs
are revalidated by both the Electron bridge and native cursor engine before
they are exposed or applied.

Import is deliberately local and compiled-format-only. Cursor Atelier does not
scrape or download from cursor websites or compile raw SVG/config source trees.
An xcursorgen text file that happens to use the `.cursor` extension is source
configuration, not a compiled macOS theme, and is rejected with guidance to
choose the site's compiled Xcursor archive instead.

## Checks

Use the repository's Node 22 LTS runtime for these checks:

```sh
npm run lint
npm run test:run
npm run curated:build
npm run curated:verify
npm run native:preflight
npm run test:e2e
```

`npm run test:e2e` rebuilds the Forge package and runs the UI and local conversion
checks inside isolated temporary user state with cursor application disabled.
The Linux suite also verifies the frozen converter and installed runtime.

Python corpus checks additionally require `rsvg-convert` (Arch/Fedora: librsvg;
Debian/Ubuntu: librsvg2-bin; macOS: `brew install librsvg`) and the pinned source
cache. They use the already-created converter venv so the exact Pillow version
is available without installing packages globally:

```sh
CONVERTER_PYTHON="native/cursor-packs/build/curated-converter/tooling-$(uname -s)-$(node -p process.arch)/bin/python"
"$CONVERTER_PYTHON" native/cursor-packs/acquire_sources.py
"$CONVERTER_PYTHON" -m unittest discover -s native/cursor-packs -p 'test_*.py'
"$CONVERTER_PYTHON" -m unittest discover -s native -p 'test_svg_renderer.py'
```

The Objective-C engine's tests require macOS and its signed native build:

```sh
"$CONVERTER_PYTHON" -m unittest discover -s native/oreo -p 'test_*.py'
```
