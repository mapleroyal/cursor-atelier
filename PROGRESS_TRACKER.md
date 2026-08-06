# Cursor Atelier completion tracker

This tracker records the completed review/remediation pass for the personal
macOS build. Checked items are implemented and covered by the relevant static,
unit, native, package, end-to-end, or visual verification.

## Product and corpus

- [x] Lock the exact corpus at 239 identifiers: 220 external and 19 Oreo.
- [x] Convert all requested upstream variants, including color, dark/light,
      handed, and palette variants.
- [x] Preserve source palettes, hotspots, aliases, animation frames, and
      human-facing labels rather than flattening them into generic fallbacks.
- [x] Emit all 47 native cursor roles for every variant and reject unexpected
      fallback, hotspot, animation, palette, or role-count drift.
- [x] Generate schema-v2 metadata and 9,290 real PNG preview assets from the
      converted resources.
- [x] Keep source acquisition and generated output behind ignored,
      reproducible build-time boundaries with pinned revisions/digests and
      transactional promotion.

## Native behavior and state

- [x] Keep renderer selection, native selection, desired state, persisted
      effective state, and live sentinel verification separate.
- [x] Derive the active marker only when desired, persisted-effective, and
      `currentSentinelsMatchTheme` all agree.
- [x] Apply selection, cursor registration, persistence, and login-helper
      setup atomically with rollback on partial failure.
- [x] Restore the saved Apple cursors and unregister current/legacy login items
      through one teardown operation.
- [x] Preserve the per-boot snapshot, journal, locking, recovery, and
      post-operation verification behavior from the native engine.
- [x] Verify cursor-removal results by authoritative read-back, accepting only
      absence or an exact saved Apple alias and failing closed for custom or
      unreadable registrations.
- [x] Recover an interrupted transaction at the beginning of every login-helper
      refresh, including journals left by a separate CLI process while the
      helper is already running.
- [x] Surface Login Items approval accurately and expose the system-settings
      action only while approval is required.
- [x] Refresh authoritative status after operations and after focus/helper
      reapply timing.
- [x] Return structured diagnostics on native success and failure without
      manufacturing an active state in preview mode.

## Electron security and packaging

- [x] Limit the preload to status, theme inventory, apply, restore, appearance,
      and Login Items settings methods.
- [x] Validate IPC senders and serialize/timeout every cursor mutation.
- [x] Deny unexpected navigation, windows, permissions, webviews, and packaged
      network access; allow only curated HTTPS provenance links externally.
- [x] Resolve packaged executables, manifests, resources, and previews only
      beneath the packaged resource root and reject path/symlink escape.
- [x] Serve preview PNGs through a content-addressed custom protocol.
- [x] Handle renderer load/process failures and synchronize the native window
      background with appearance.
- [x] Stamp Electron, native app, and helper versions from `package.json` and
      declare macOS 13.0 consistently.
- [x] Give the outer app, nested native app, and login helper distinct exact
      bundle identifiers.
- [x] Require the native app/helper to share one stable Apple TeamIdentifier;
      keep the outer personal Electron app ad-hoc signed.
- [x] Fail preflight/package on missing signatures, IDs, versions, manifest
      locks, resources, hashes, role previews, or native validation.
- [x] Package only `app.asar` plus the nested native runtime app/resources,
      without source caches, generated working trees, or duplicate themes.

## Interface and polish

- [x] Replace the giant outlined/padded card with a quiet full-window two-pane
      workspace.
- [x] Remove card soup, decorative badges, redundant helper copy, and
      unnecessary surfaces while retaining useful preview canvases.
- [x] Bound the shell to the viewport and make rail/detail independently
      scrollable without min-content overflow.
- [x] Provide the narrow-width pack sheet without collisions or hidden
      controls.
- [x] Use the compact persisted Light/System/Dark squircle selector and apply
      the squircle policy consistently to rounded controls.
- [x] Render real per-role artwork, exact role counts, and honest missing or
      unavailable states.
- [x] Propagate authoritative inventory failures and structured status
      failures into concise Retry states instead of successful-looking static
      fallback data.
- [x] Distinguish inspected, selected-by-native, applying, live active,
      drifted/restorable, unavailable, and error states without verbose copy.
- [x] Use a hidden-inset macOS titlebar, deliberate traffic-light spacing,
      final product icon, restrained light/dark colors, and reduced-motion
      behavior.
- [x] Verify keyboard access, focus indication, contrast, desktop overflow,
      and compact/narrow layouts.

## Tests and documentation

- [x] Cover status normalization, live/persisted drift, atomic apply/teardown,
      structured failures, login approval, and IPC trust boundaries.
- [x] Cover exact inventory digests, representative metadata, converter
      semantics, native teardown rollback, bundle IDs, and settings commands.
- [x] Keep renderer E2E tests non-mutating by launching packaged `app.asar` in
      preview mode.
- [x] Add a separate read-only packaged-app smoke test for real bridge
      discovery, all 239 themes, all 47 roles, and custom preview loading.
- [x] Reconcile README, architecture, conversion, native component, notices,
      tracker, and E2E documentation with the finished implementation.

## Intentionally deferred

- [ ] Developer ID distribution signing, notarization, and stapling.
- [ ] Public redistribution review/permission for CC BY-NC-ND-derived packs
      and release packaging of the complete third-party license/source corpus.
- [ ] Publication channels, automatic updates, and release support policy.

These are release gates only if distribution is added later. They are not
blockers for the personal local app.

## One-time workstation handoff

- [x] Replace the stale intermediate `/Applications/Cursor Atelier.app` with
      the verified final package. The stale bundle was moved to Trash before
      the final app was installed into the now-absent destination, avoiding a
      resource merge. The installed renderer hash and deep signature match the
      final build.
- [x] Keep the new Cursor Atelier bridge clean/off and limit its final native
      smoke test to read-only status, inventory, and preview checks.
- [x] Ask the installed proof-of-concept app to disable itself using its own
      teardown path; it persisted `CursorEnabled = 0` and
      `LaunchAtLoginDesired = 0` before WindowServer rejected removal of the
      native `Cell` alias.
- [ ] Restart macOS so WindowServer and the old helper enter a fresh boot
      session, then run the old app's `--status`, `--teardown`, and `--status`
      once before the first Cursor Atelier Apply. Confirm no pending
      transaction and a `notRegistered` login item. Do not run both helpers.

The restart is a one-time cleanup of this workstation's still-running POC,
not a Cursor Atelier source or packaging defect. No process was force-killed,
no recovery data was deleted, and no new cursor theme was applied while that
recovery remains pending.

At the final read-only check, POC helper PID 621 remained active with
`CursorEnabled = 0`, `CursorEffective = 1`,
`LaunchAtLoginDesired = 0`, and a pending-recovery status. After restarting,
use the old app's own commands in this order:

```sh
"/Users/user1/Applications/Oreo Cursor.app/Contents/MacOS/OreoCursor" --status
"/Users/user1/Applications/Oreo Cursor.app/Contents/MacOS/OreoCursor" --teardown
"/Users/user1/Applications/Oreo Cursor.app/Contents/MacOS/OreoCursor" --status
```

## Verification log

- 2026-08-05: The current generated corpus was audited at schema v2, 239 exact
  manifest identifiers (220 external + 19 Oreo), 47 role rows per variant,
  220 generated external `.cursor` files, and 8,607 unique PNG previews. The
  external and unified identifier digests match `inventory-lock.json`.
- 2026-08-05: `npm run native:preflight` passed against the signed 0.1.0 native
  bundle. It validated 239 resources, exact app/helper IDs, the shared stable
  TeamIdentifier, hashes, role previews, native theme enumeration, and native
  decode validation.
- 2026-08-05: `npm run lint` passed.
- 2026-08-05: `npm run test:run` passed 40 tests in 5 files.
- 2026-08-05: Cursor-conversion Python discovery passed 13 tests; native Oreo
  contract discovery passed 12 tests, including fail-closed native-alias
  restore and already-running-helper recovery coverage.
- 2026-08-05: Before the POC recovery conflict above, a live lifecycle smoke
  against the built signed bridge passed.
  `--apply-theme OreoBlue` returned desired/effective/sentinels true, Login Item
  enabled, snapshot present, and no pending transaction; immediate `--status`
  agreed. `--teardown` returned desired/effective false, Login Item
  `notRegistered`, snapshot removed, and no pending transaction.
  `--select-theme OreoWhite` restored the original stored selection and final
  status remained clean/off.
- 2026-08-05: A fresh `npm run make` passed, including the native preflight,
  renderer build, package hooks, deep strict signature checks, and ZIP maker.
  Electron entitlements were minimal and contained no privacy/device grants.
  It produced
  `out/make/zip/darwin/arm64/Cursor Atelier-darwin-arm64-0.1.0.zip`
  (181,021,649 bytes; SHA-256
  `35cbc4f9c6fa080583f0b830f933afebcde9de3f4f4a54e730ffce691dc60c3f`).
  `unzip -t` reported no compressed-data errors.
- 2026-08-05: The full Playwright suite passed 9/9 against the app rebuilt by
  `make`, including the non-mutating preview UI suite, the supported 760×560
  pack-drawer flow, roving 239-item rail navigation, and the exact packaged
  executable's read-only native/CDP smoke (239 themes, 47 roles each, and
  custom-protocol preview loading).
- 2026-08-05: Desktop visual inspection confirmed the card-free two-pane
  composition, real native previews, titlebar treatment, inherited dark-mode
  control colors, and settled Light/Dark selectors. The 760×560 pack sheet,
  fixed document, and independently scrolling panes were also inspected.
- 2026-08-05: `npm ls --depth=0` passed, the shipped dependency audit reported
  zero vulnerabilities. The remaining 24 advisories are confined to Electron
  Forge's development-only `tar`/`tmp` graph; npm offers only a forced Forge
  downgrade while Forge's current plugins report no fix, so no unsupported
  transitive override was added.
- 2026-08-06: A stale pre-overhaul build was found at
  `/Applications/Cursor Atelier.app`; Forge had produced the final package but
  had not installed it. The stale app was moved to
  `~/.Trash/Cursor Atelier (stale installed 2026-08-05).app`, the final build
  was installed at the stable `/Applications` path, and deep strict signature
  plus renderer SHA-256 verification passed. The app was not launched and no
  cursor or login-item state was changed.
- 2026-08-06: Three earlier diagnostic invocations of `sfltool dumpbtm`
  caused macOS authorization UI, with one prompt left awaiting input
  overnight. The command only dumped the Background Task Management database;
  it did not install, reset, or alter anything, and no credentials were
  exposed to the app or Codex. Future inspection avoids `sfltool` entirely.
- 2026-08-06: The cursor corpus was regenerated after role, timing, hotspot,
  resolution-tier, and SVG-rendering normalization. The schema-v2 result has
  239 themes, 47 role rows per theme (11,233 total), 9,290 unique 96×96 PNG
  previews, and 478 animated role rows. APNGs loop indefinitely, preserve
  source cycle duration, and no Wait/Progress pair remains an exact or cyclic
  duplicate. A temporal-union size audit found no strong undersized outliers.
- 2026-08-06: Import coverage now includes compiled Xcursor folders, ZIP,
  uncompressed/gzip/xz tar archives (including extensionless magic-detected
  archives), `.cursor`, and compatible `.cape` sources. Normalization and
  adversarial coverage passed 39 focused importer tests, including 132-theme
  archives, 512-frame inputs, mixed resolution tiers, variable delays,
  rectangular frames, safe symlink chains, malformed archives, and
  Wait/Progress reconstruction.
- 2026-08-06: `npm run test:run` passed 97 tests in 7 files; `npm run lint` and
  the focused Prettier check passed. Cursor-conversion discovery passed 44
  tests, and native Oreo discovery passed 30 tests with one expected
  root-only ownership test skipped.
- 2026-08-06: The signed native rebuild and `npm run native:preflight` passed
  against all 239 themes. The final arm64 Forge package passed its post-package
  deep strict signature check and contains the target Sharp addon, libvips
  dylib, and LZMA addon in `app.asar.unpacked`.
- 2026-08-06: The full packaged-app Playwright suite passed 9/9. It verifies
  the single-instance lock against a conflicting `--user-data-dir`, all 239
  themes and 47 roles, custom-scheme APNG structure, a 96×96 animation canvas,
  infinite playback metadata, and real frame-to-frame visual motion without
  applying a cursor.
- 2026-08-06: The production dependency audit reported zero vulnerabilities.
  Final browser inspection confirmed Google Blue Wait as a large standalone
  animated indicator and Progress as the base cursor with a smaller adjacent
  animated indicator; two captured phases of each visibly differed.
