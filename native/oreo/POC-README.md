# Native cursor component (historical Oreo POC)

This directory began as the standalone `oreo-cursor-macos` proof of concept.
It is now Cursor Atelier's private native runtime component; the Electron app
is the product interface and owns catalogue selection, appearance, and user
feedback. Historical executable/app names remain `OreoCursor` and
`Oreo Cursor.app` to keep the vendored engine boundary obvious.

The current component loads 19 vendored Oreo themes plus 221 generated
external themes from one locked schema-v2 manifest, then merges validated
user-imported schema-v2 packs. Every usable resource contains the exact 47
CoreGraphics/AppKit cursor identifiers.

## Responsibilities

- Validate manifest metadata, resource SHA-256, theme UUID/geometry, frames,
  hotspots, and required cursor identifiers before mutation.
- Discover user imports only from the fixed Application Support store, without
  following manifest, pack, or cursor-resource symbolic links.
- Snapshot the current Apple registrations once per boot session.
- Journal changes, serialize access, verify results, recover interrupted
  transactions, and roll back partial apply/restore failures.
- Persist native selection, desired state, and last effective result
  separately from live sentinel verification.
- Register an embedded unprivileged `SMAppService` helper so a selected theme
  can be reasserted after login/session events.
- Restore the saved Apple cursors and remove login registration on teardown.

It does not use a privileged helper, Accessibility/Input Monitoring
permission, network access, an updater, system-file patches, or a LaunchAgent.

## Compatibility and risk

| Item              | Current contract                                        |
| ----------------- | ------------------------------------------------------- |
| Deployment target | macOS 13.0 or newer                                     |
| Architectures     | Apple silicon and Intel (universal binaries)            |
| Required session  | Logged-in Aqua/WindowServer graphical session           |
| API stability     | Private/undocumented; future macOS updates may break it |

Private cursor symbols are resolved dynamically. Missing symbols, an invalid
resource, or an unsupported graphical session produce structured unsupported
status rather than modifying system files. Do not run another cursor manager
that owns the same session registrations at the same time. If both rollback
and Apple restoration ever fail, log out or restart to reset WindowServer.

## Build

Run the corpus converter first, then build with an Apple-issued signing
identity visible to `security find-identity -v -p codesigning`:

```sh
npm run native:packs
OREO_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" npm run native:build
npm run native:preflight
```

The native build refuses an empty or ad-hoc identity. It builds the helper and
host as universal binaries, signs the nested helper first, verifies the whole
bundle, and atomically promotes the result to:

```text
native/oreo/build/Release/Oreo Cursor.app
```

The host and helper are versioned from the root `package.json`, target macOS
13.0, use distinct bundle IDs, and must share one nonempty TeamIdentifier:

- `com.cursoratelier.CursorAtelier.NativeCursor`
- `com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper`

For the current personal app, Forge preserves these signatures and uses the
same Apple Development identity for the outer Electron app so its background
launch registration remains stable. Developer ID distribution signing and
notarization are intentionally outside this milestone.

## JSON command line

From the repository root:

```sh
APP="native/oreo/build/Release/Oreo Cursor.app/Contents/MacOS/OreoCursor"
"$APP" --status
"$APP" --list-themes
"$APP" --validate-themes
"$APP" --validate-theme OreoWhite
"$APP" --apply-theme OreoWhite
"$APP" --teardown
"$APP" --open-login-settings
```

- `--status`, `--list-themes`, `--validate-theme`, and `--validate-themes` are
  read-only. The singular validation command is the importer's final native
  gate before it reports a newly installed identifier as usable.
- `--apply-theme IDENTIFIER` is the product apply primitive. It validates and
  applies the chosen theme, persists selection, and registers the login helper
  as one rollback-capable operation.
- `--teardown` restores Apple cursors and unregisters current and legacy login
  items. Cursor Atelier's Restore action uses this command.
- `--open-login-settings` calls the macOS 13+
  `SMAppService` Login Items settings API.
- `--select-theme`, `--enable`, `--disable`, and `--setup` remain lower-level
  diagnostic/POC commands; Electron does not compose them for normal apply or
  restore.

Commands print JSON to stdout on both ordinary and structured failure paths.
An apply exit code of 5 means the cursor operation succeeded but macOS still
requires approval in System Settings → General → Login Items & Extensions.
Electron accepts that code, refreshes status, and offers Open Settings. Other
nonzero codes represent validation, recovery, action, or usage failures.

## Imported pack store

The Electron importer installs a pack atomically at:

```text
~/Library/Application Support/Cursor Atelier/ImportedPacks/<pack-id>/
```

Each pack has one `manifest.json` with `schemaVersion: 2`; its `Resource`
values are safe `.cursor` basenames stored directly beside that manifest.
Preview subdirectories are owned by Electron and ignored by the native
runtime. The native reader bounds directory, pack, theme, manifest, and cursor
sizes/counts; opens directories and files with no-follow semantics; verifies
real-path containment; rejects duplicate identifiers/resources atomically per
pack; and verifies every resource SHA during discovery and immediately before
decoding it. Signed bundled identifiers always take precedence over imports.

The login helper resolves the saved identifier through this same merged
catalogue and fixed store, so an imported selection works after login without
persisting or accepting an arbitrary filesystem path.

## State and recovery

The active indicator must not be inferred from the selected preference alone.
The native diagnostics expose:

- `themeIdentifier` / selected theme;
- `desiredEnabled`;
- persisted `effectiveApplied`;
- `currentSentinelsMatchTheme`, a live check of Arrow, I-beam, and hand roles;
- login-item desired/registration/approval state; and
- transaction/snapshot/error details.

Electron reports an effective variant only when desired, persisted-effective,
and live sentinel state all agree. A mismatch is drift, not an active theme.

The snapshot and transaction journal live in the user's Cursor Atelier
application-support area. They are boot-scoped and checked before every
mutation. Applying another theme preserves the original Apple snapshot; a
failed replacement re-applies the previous valid theme or restores Apple.

## Removal

Run teardown from the same stable outer app location before moving it to
Trash. For a typical personal installation:

```sh
"/Applications/Cursor Atelier.app/Contents/Resources/Oreo Cursor.app/Contents/MacOS/OreoCursor" --teardown
```

Confirm `effectiveApplied: false` and an unregistered login item. If the app
was removed first, restore it to the same path and run teardown; otherwise
disable its Login Item and log out/restart to reset the graphical session.

Optional remaining per-user state uses:

- `~/Library/Application Support/Cursor Atelier/`
- preference domain `com.cursoratelier.CursorAtelier.NativeCursor`

## Oreo artwork regeneration

The checked-in 19 Oreo `.cursor` files are sufficient for the normal corpus
build. Regeneration additionally requires Python 3, librsvg's `rsvg-convert`,
and the pinned Pillow version:

```sh
brew install librsvg
python3 -m pip install -r native/oreo/ArtworkSource/requirements.txt
native/oreo/ArtworkSource/generate_all_themes.sh \
  native/oreo/Resources/Themes
```

Expected SHA-256 values are in
`native/oreo/ArtworkSource/THEME-SHA256SUMS.txt`.

## Licenses

- MIT: native application/helper code, native build script, conversion code,
  and project documentation. See `native/oreo/LICENSE`.
- GPL-2.0-only: the vendored Oreo artwork/source tree and the 19 converted Oreo
  resources. See `native/oreo/THIRD-PARTY-NOTICES.md`,
  `native/oreo/Resources/Oreo-GPL-2.0.txt`, and
  `native/oreo/ArtworkSource/`.
- External generated packs retain the source/license metadata documented in
  `CURSOR_PACK_NOTICES.md` and the schema-v2 manifest.

The current target is personal local use. Any future distribution needs its
own signing/notarization and license/source review.
