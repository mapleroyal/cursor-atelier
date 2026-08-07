# Cursor Atelier

Cursor Atelier is a quiet, local macOS cursor manager. Its Electron interface
provides search, real cursor previews, and explicit Apply/Restore controls;
the signed Objective-C component owns the private CoreGraphics/AppKit work.

This repository currently targets one personal installation. Distribution
signing, notarization, update delivery, and redistribution review are deferred
release concerns, not blockers for the local build.

## What is included

- 239 locked bundled variants: 19 Oreo themes and 220 conversions from the
  requested external families. The catalogue can also include locally imported
  user themes.
- All 47 native cursor identifiers for every bundled variant, with 9,290
  generated PNG preview assets derived from the converted resources. Imports
  are normalized to the same 47-role contract.
- Looping APNG previews for animated states, using source-cycle-preserving
  timing from the applied cursor (rounded to APNG milliseconds).
- A searchable two-pane workspace with independently scrolling rail/detail
  panes, restrained surfaces, and consistent squircle controls.
- Local import for compiled Xcursor directories and ZIP/tar archives,
  compatible Mousecape `.cape` files, and compiled macOS `.cursor` themes.
- A persisted Light/System/Dark appearance selector.
- Truthful selected, requested, and live-verified active states. Preview mode
  never mutates macOS or presents a selection as active.
- Atomic theme application, transactional rollback/recovery, login-item
  persistence, and complete teardown back to the saved Apple cursors.

Architecture decisions and current verification are recorded in
[ARCHITECTURE.md](ARCHITECTURE.md) and
[PROGRESS_TRACKER.md](PROGRESS_TRACKER.md). Source and license provenance is in
[CURSOR_PACK_NOTICES.md](CURSOR_PACK_NOTICES.md).

## Stack

- Electron 43, Electron Forge, and Vite
- React 19
- Tailwind CSS 4 and shadcn/Radix primitives
- Zustand for persisted appearance and TanStack Query for native data
- ESLint, Vitest, Python `unittest`, and Playwright

The app has one renderer route and does not use React Router.

## Local build

Requirements are macOS 13 or newer, Node.js/npm, Xcode or the Xcode Command
Line Tools, Python 3 with the pinned Pillow dependency, librsvg, and a stable
Apple-issued development signing identity.

```sh
brew install librsvg
npm install
python3 -m pip install -r native/oreo/ArtworkSource/requirements.txt
python3 native/cursor-packs/acquire_sources.py
npm run native:packs
OREO_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" npm run native:build
npm start
```

The source-acquisition command populates an ignored build cache. It verifies
pinned Git revisions and archive digests and is not used at app runtime. Once
the cache exists, verify it without fetching with:

```sh
python3 native/cursor-packs/acquire_sources.py --verify-only
```

For the personal packaged app:

```sh
npm run native:preflight
npm run package
npm run make
```

Forge runs the native preflight for `package` and `make`. It uses the nested
native app's Apple Development identity for the outer Electron app, then
preserves the signatures on the nested native app and login helper. All three
bundles must have the same nonempty TeamIdentifier and keep their distinct
bundle identifiers. No Developer ID distribution certificate or notarization
is needed for this personal local build.

Forge writes its output under `out`; neither command installs or opens the app.
Move the resulting outer `Cursor Atelier.app` to a stable location such as
`/Applications` before using Apply, because its nested `SMAppService` login
item is registered from that location.

### Replacing the proof of concept

Do not run Cursor Atelier alongside the earlier
`io.github.mapleroyal.OreoCursor` login helper. Use that app's own `--teardown`
command before the first Cursor Atelier Apply. If the old command reports a
pending same-boot recovery or a cursor-removal error, restart macOS before
running its teardown once more. Cursor Atelier intentionally does not read or
migrate the proof of concept's preferences, snapshots, or login item.

## Native availability

The production bridge lives in the nested signed app outside `app.asar`. When
that component is absent or invalid, the catalogue remains available as a
read-only preview, Apply/Restore are unavailable, and the UI does not claim a
system cursor is active. Cursor Atelier never downloads cursor artwork; local
imports are initiated explicitly through the system file picker.

See [native/README.md](native/README.md) for the build and manifest contract.

## Importing local cursor packs

Choose **Import** and select one of these local sources:

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
tiers, animation lengths/timing, and harmless canvas variation. It normalizes
each variant to the same 47-role native contract as a bundled theme, generates
static PNG or looping APNG role previews, verifies the resource and manifest,
and atomically installs the result under
`~/Library/Application Support/Cursor Atelier/ImportedPacks`. Imported packs
are revalidated by both the Electron bridge and native cursor engine before
they are exposed or applied.

Import is deliberately local and compiled-format-only. Cursor Atelier does not
scrape or download from cursor websites or compile raw SVG/config source trees.
An xcursorgen text file that happens to use the `.cursor` extension is source
configuration, not a compiled macOS theme, and is rejected with guidance to
choose the site's compiled Xcursor archive instead.

## Checks

```sh
npm run lint
npm run test:run
python3 -m unittest discover -s native/cursor-packs -p 'test_*.py'
python3 -m unittest discover -s native/oreo -p 'test_*.py'
npm run native:preflight
npm run test:e2e
```

`npm run test:e2e` rebuilds the Forge package, runs the UI suite in safe
preview mode, and performs a read-only smoke test against the real packaged
native bundle.
