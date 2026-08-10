# Cursor Atelier

Cursor Atelier is a quiet, local macOS cursor manager. Its Electron interface
provides search, real cursor previews, light/dark cursor assignments, and Restore;
the signed Objective-C component owns the private CoreGraphics/AppKit work.

This repository currently targets one personal installation. Distribution
signing, notarization, update delivery, and the Remus, Drop, and Moga licensing
review described in [CURSOR_PACK_NOTICES.md](CURSOR_PACK_NOTICES.md) remain
release concerns.

## What is included

- No `.cursor` resources or bulk preview corpus in the signed app. The native
  bridge starts with an empty library and discovers packs from the private
  Application Support store.
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
  helper.
- Portable export/import of installed cursors and settings, plus a recoverable
  full reset to the first-run experience. Import always leaves Apple cursors
  active rather than applying the archived selection.
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
Line Tools, and a stable Apple-issued development signing identity. Python,
Pillow, and librsvg are developer requirements for rebuilding/comparing the
full source corpus; the packaged app's converter is self-contained.

```sh
brew install librsvg
npm install
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

The production bridge lives in the nested signed app outside `app.asar`. When
that component is absent or invalid, cursor assignment and Restore are
unavailable and the UI does not claim a system cursor is active.

On first run, Cursor Atelier obtains only the curated families selected by the
user. It downloads their pinned original upstream inputs over HTTPS, verifies
them, runs the bundled source-specific converter locally, and transactionally
installs each completed variant. Arbitrary user imports instead use the general
compiled Xcursor pipeline described below.

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
tiers, animation lengths/timing, and harmless canvas variation. Authentic
tiers are never replaced. If an Xcursor pack stops below the app's 128px tier,
the importer uses an alpha-safe no-halo reconstruction baseline and adopts a
pack-learned filter only when held-out roles prove it improves quality; roles
that regress retain the baseline. It then normalizes each variant to the same
47-role native contract, generates static PNG or looping APNG role previews,
verifies the resource and manifest, and atomically installs the result under
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
npm run curated:build
npm run curated:verify
npm run native:preflight
npm run test:e2e
```

`npm run test:e2e` rebuilds the Forge package, runs the UI suite in safe
preview mode, verifies the empty native library, and converts a pinned local
Future source fixture inside isolated temporary user state.
