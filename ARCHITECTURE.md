# Cursor Atelier architecture

This is the implementation record for the current personal macOS build.

## Product shape

Cursor Atelier is a focused cursor manager, not an online pack store or cursor
editor. The main window is a viewport-bounded two-pane workspace:

- a searchable, grouped variant rail; and
- a detail pane with real role previews, compact provenance, light/dark
  assignment, and randomization-pool controls.

The window has no giant outer card. Borders and muted fills establish only the
rail, titlebar, selection, and preview-canvas boundaries. Controls use
squircles (with a rounded fallback where CSS `corner-shape` is unavailable),
helper copy is sparse, and active state is primarily icon-led. Below the rail
breakpoint the catalogue moves into a sheet. Each pane scrolls independently;
the document itself remains fixed.

The Light/System/Dark selector is persisted by Zustand. The renderer itself is
a single React 19 entry point; React Router is not part of the runtime.

## Runtime boundaries

```text
React renderer
  -> allowlisted contextBridge methods
     -> validated Electron main IPC handlers
        -> apply/restore: signed Objective-C command-line bridge
           -> transactional cursor engine and SMAppService login helper
              -> private CoreGraphics/AppKit cursor registration
        -> import: bounded local decoder and schema-v2 artifact builder
           -> private per-user ImportedPacks store
              -> independently validated Electron/native readers
```

The sandboxed renderer has no Node.js access and cannot execute arbitrary
commands. Main validates the sender, serializes mutations, applies per-command
timeouts, parses structured JSON on success and failure, and refreshes status
after each mutation. Unexpected navigation, windows, permissions, and packaged
network requests are denied; only curated HTTPS provenance links may open in
the default browser.

Import paths never come from renderer input. Electron main owns the system
file picker, preflights ZIP, tar, gzip, and XZ paths plus decompression bounds,
rejects special files and path escapes, and decodes only compiled Xcursor or
compatible macOS cursor property lists. Same-directory Xcursor alias chains are
resolved only to regular Xcursor files in that same `cursors` directory. Every
variant is converted in a private staging directory, validated as a
self-contained schema-v2 artifact, and moved into the per-user store with an
atomic rename. Existing identical artifacts converge without duplication;
identifier collisions fail closed.

The native engine validates every selected resource before mutation. It keeps
a per-boot Apple-cursor snapshot, transaction journal, process lock, rollback,
and recovery path. Unsupported graphical sessions or unresolved private APIs
fail closed.

WindowServer can return a nonzero result when asked to remove a lazily
materialized Apple cursor alias. Snapshot restore therefore treats removal as
a request, reads the registration back, and accepts only verified absence or
an exact curated native alias matching the saved Apple source. An unreadable,
stale, or custom record still fails restoration closed.

## Native command contract

The executable supports JSON-producing commands:

- `--status`
- `--list-themes`
- `--validate-themes`
- `--validate-theme <identifier>`
- `--apply-theme <identifier>`
- `--teardown`
- `--open-login-settings`
- lower-level `--select-theme`, `--enable`, `--disable`, and `--setup`

Electron uses status/list/validate, atomic `--apply-theme`, complete
`--teardown`, and the login-settings command. Applying a theme validates it,
applies it, persists the selection, and registers the unprivileged login
helper as one rollback-capable operation. Teardown restores the saved Apple
cursors and unregisters both current and legacy login items. Exit code 5 from
apply represents a successful cursor change that still needs Login Items
approval; the UI offers the settings action only in that state.

## State model

These values are deliberately separate:

- renderer selection: the variant currently being inspected;
- `selectedThemeIdentifier`: the native selection persisted for future use;
- `desiredEnabled`: whether custom cursors are requested;
- persisted `effectiveApplied`: the native engine's last completed result;
- `currentSentinelsMatchTheme`: live verification of Arrow, I-beam, and hand
  registrations in the current WindowServer session; and
- `effectiveVariantId`: exposed only when desired, persisted-effective, and
  live sentinel states all agree.

`currentSentinelsMatchTheme` is authoritative for the active marker. Drift
keeps Restore available even when a theme is no longer live, so stale desired
state or a login registration can still be cleaned up. Status refreshes after
mutations and again after focus, allowing the helper's bounded reapply to
settle before the second read.

The login helper checks for an interrupted transaction at the start of every
refresh pass, including settings changes received while it is already
running. A successful recovery leaves custom cursors off and ends that pass;
no stale desired/effective decision is acted on afterward.

Preview mode is a read-only failure mode. It can show catalogue metadata and
available artwork, but it never changes fallback state, enables cursor
assignment or Restore, or reports an effective theme.

## Per-theme cursor size

Cursor size is a native, per-theme preference from 50% through 200%; Cursor
Atelier does not write macOS's private Accessibility cursor-size default. That
system setting is global, while this feature must follow the selected theme.
The renderer slider scales the main-arrow preview immediately and saves a draft
value when the gesture ends. If that theme is live, the renderer immediately
reapplies it at the committed size and verifies the resulting registration.

The native engine first integrity-checks and decodes the immutable theme at its
authored 100% geometry. It then scales `PointsWide`, `PointsHigh`, and both
hotspot coordinates together, while preserving representation pixels and
hashes, frame order, frame count, and timing. This lets WindowServer use the
best existing representation without a second baked resampling pass: at 200%,
a bundled 128 px source is the 2x representation of a 64 pt cursor; at 50%, a
32 px source is the 2x representation of a 16 pt cursor. An imported pack with
only a 64 px source cannot remain equally sharp at the largest sizes.

Configured and effective size are distinct, like selected and effective theme.
The effective size is persisted only after scaled registrations verify. The
login helper compares both identifier and effective size before deciding its
loaded engine is current, so a reapplication notification reloads changed
geometry without allowing an uncommitted slider draft to race the helper.

## Installed-build and login-helper lifecycle

`CFBundleShortVersionString` is the human-facing release version. Every native
build also receives a distinct numeric `CFBundleVersion`, shared by the
packaged Electron app, native cursor app, and embedded login helper. The build
identity must change even when the pre-release product version remains the
same: macOS can keep helper code resident after its containing app bundle has
been replaced, so a static product version is not a valid process-freshness
signal.

Every packaged launch starts a narrow login-item reconciliation before later
cursor mutations can run, but an interactive launch does not hold the window
behind that work. When Launch at Login is desired and the registered helper's
saved build differs, `SMAppService` unregisters it (which terminates the old
resident process) and registers the current embedded helper, which starts
immediately. When startup is no longer desired, stale helper and legacy main-
app registrations are removed instead. Reconciliation does not select or size
a cursor; the current helper then reads the already committed desired/effective
state through the normal transaction and verification path.

The menu-bar setting controls whether the Electron main app is registered to
run at login. Menu-bar launches keep a hidden renderer warm, and closing a
window while the menu-bar item is enabled hides rather than destroys that
renderer. Opening Settings therefore only presents the existing window and
sends a renderer navigation event. A presented window uses macOS's regular
activation policy and appears in the Dock; closing it switches to accessory
mode so the Dock no longer presents the app as running. When the menu-bar item
is disabled, closing the last window quits Electron instead. There is no
independent Dock preference or asynchronous Dock show/hide path.

This ordering is part of cursor correctness, not only packaging hygiene. A
resident helper from an older build could otherwise react to the new build's
settings notification and overwrite a freshly verified scaled registration
before the renderer's follow-up status read.

## Cursor corpus

`native/cursor-packs/inventory-lock.json` locks the exact identifier set:

- 221 external variants;
- 19 built-in Oreo variants;
- 240 unified manifest rows; and
- 47 native cursor identifiers per row.

The schema-v2 manifest includes stable identifier/UUID, resource basename and
SHA-256, family and human-facing variant labels, upstream label, author,
source/license provenance, one default preview, and 47 `rolePreviews`. Shared
role artwork is stored once, yielding 9,328 real PNG files for 11,280 role
references. Animated states are encoded as indefinitely looping APNGs instead
of still frames. Their frame delay encodes the normalized native resource to
the nearest millisecond; the converter preserves the complete source cycle
duration when it downsamples a long animation. Oreo `.cursor` files remain vendored under
`native/oreo/Resources/Themes`; the 221 external `.cursor` files and all
preview metadata/assets are generated from pinned build inputs.

Config-referenced artwork is resolved by exact relative basename and exact
alternate-extension basename before any normalized fallback. In particular, a
numeric suffix is not assumed to be a raster-size marker: names such as
`wait-16.svg`, `wait-20.svg`, and `wait-22.svg` are animation frames. Trying
the unsuffixed `wait.svg` first substitutes a static image for those frames and
creates a visible jump once per cycle. Focused converter coverage locks this
exact-before-normalized ordering, and corpus generation validates complete
frame order, timing, and output resources rather than special-casing individual
families.

Resolution provenance stays explicit. Bundled vector families are rendered
directly at the 32, 64, 96, and 128 px tiers; each tier therefore retains the
source detail. Local import begins with already-compiled cursor rasters. The
importer can normalize those rasters into the required representation ladder,
but it cannot restore detail above the largest source representation. A 96 px
import derived from a compiled pack whose largest frame is 64 px is expected to
look softer than the bundled build from the original SVG and is not evidence of
the animation-resolution bug above.

Generation occurs in a validated staging sibling and replaces `generated/`
only after the complete corpus passes. The source cache and generated output
are ignored build-time data; only scripts, inventory locks, and provenance are
source controlled. The running app never fetches cursor artwork.

## Local import store

The packaged importer is intentionally narrower than the build-time converter.
It accepts a user-selected compiled Xcursor directory; ZIP, tar, gzip-tar, or
XZ-tar archive; compatible Mousecape `.cape`; or compiled macOS `.cursor`
property list. It does not run the repository's source acquisition or
SVG/config conversion pipeline.

Each imported variant is a self-contained direct child of the fixed per-user
store:

```text
~/Library/Application Support/Cursor Atelier/ImportedPacks/
  <safe-content-derived-id>/
    manifest.json
    <identifier>.cursor
    previews/
      <identifier>/
        *.png
```

Directories use owner-only permissions; regular files are owner-only,
single-link entries. Both readers reject ownership, mode, link-count, symlink,
and special-file violations. The installer shares the readers' 16 MiB
manifest/preview and 32 MiB cursor ceilings. The renderer bridge checks schema,
bounded paths, PNG signatures, resource sizes, SHA-256, and identifier
collisions before merging imported rows after the bundled catalogue. The
native engine separately opens the same fixed store without following
symlinks, repeats those bounds, and rechecks the cursor SHA-256 before decode
or apply. Every newly promoted resource must also pass that native decoder
before the import transaction succeeds; a failure rolls all newly promoted
variants back. Electron admits one application instance per user, so store-cap
checks and promotion cannot race another importer. Bundled identifiers always
take precedence, including against differently-cased imported identifiers.

An imported theme's manifest `Group` is its family and is the only mutable
artifact metadata. Assignment uses the exact label of a case-insensitive
existing match or a new bounded label; JavaScript and native validation reject
the same control/format characters. Duplicate-content identity normalizes only
`Group` back to `Imported`, so reorganizing a pack does not make a later import
look like an identifier collision. Cursor resources, previews, hashes, IDs, and
all other manifest metadata remain part of the immutable identity.

Only imported rows expose deletion: bundled resources live inside the signed
application and are not mutable library data. A family can be deleted only when
all of its current members are imported. The renderer confirms either operation
before Electron serializes it with imports and cursor mutations. If a target is
live, Electron restores the macOS cursors first; if it is the persisted native
selection, Electron then selects bundled `OreoWhite` while custom cursors remain
off. Validated pack directories are atomically moved out of the indexed store
before Electron sends them to Trash. Manifest caches, favorites, appearance and
randomization references, and native per-theme size preferences are pruned only
after the library removal. Cleanup failures are reported separately and never
misrepresent an already completed removal as a failed one.

## Package layout and identities

Forge packages only runtime material outside the renderer archive. Sharp's
addon and linked libvips library, plus the XZ decoder addon for the package's
target architecture, are extracted from ASAR because the operating system
cannot load native code from inside it:

```text
Cursor Atelier.app/
  Contents/Resources/
    app.asar
    app.asar.unpacked/
      node_modules/
        @img/                    Sharp addon and libvips dylib
        @napi-rs/               XZ decoder addon
    Oreo Cursor.app/
      Contents/MacOS/OreoCursor
      Contents/Library/LoginItems/Oreo Cursor Login Helper.app
      Contents/Resources/Themes/
        manifest.json
        240 .cursor resources
        previews/
```

Source caches, converter sources, and native build trees are not copied into
the package. Bundled manifest and preview resolution is confined to this
resource root; imported resolution is separately confined to the fixed
per-user store. Both reject symlink/path escape.

The identities are intentionally unique:

- outer Electron app: `com.cursoratelier.CursorAtelier`
- native app: `com.cursoratelier.CursorAtelier.NativeCursor`
- login helper: `com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper`

For this personal build the outer app is ad-hoc signed after the nested app is
staged. The nested native app and helper retain stable Apple signatures from
the same nonempty TeamIdentifier so `SMAppService` can recognize them across
launches. Preflight and Forge hooks verify IDs, versions, minimum macOS 13.0,
signatures, manifest locks, resource hashes, previews, and native validation.
Developer ID distribution signing and notarization are deliberately deferred.

## Deliberate non-goals

- No website browsing, scraping, or cursor-pack downloads inside the app.
- No runtime compilation of raw SVG/config trees; local import begins from a
  supported compiled format, either directly or inside a supported archive.
- No JavaScript reimplementation of private cursor registration.
- No accounts, updater, broad settings surface, or verbose in-app pack docs.
- No backwards-compatibility layer for earlier pre-release manifests.
- No public-release legal or signing work in the personal-build milestone.
