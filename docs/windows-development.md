# Windows development

The Windows implementation uses the shared Electron renderer, import pipeline,
curated catalogue, preferences, automation, and portable backup format. Build
and run it inside Windows; cross-compiling a Windows converter from Linux is
not supported.

## Native desktop integration

`windows-cursor-backend.js` implements the existing native command contract.
It records the original per-user cursor registry values and types, serializes
mutations, journals the previous state, and recovers interrupted mutations.
Generated themes are content-addressed and verified against file receipts.
The shared plist/PNG reader feeds Clickgen's pinned Windows CUR/ANI writer.
Frames preserve scaled hotspots and animation timing (Windows jiffies).

The desktop adapter invokes fixed PowerShell/C# code. It uses the current
user's registry and Win32 cursor APIs, and requires an interactive desktop.
Status verifies the actual Arrow, IBeam, and Hand pixel/hotspot fingerprints
in addition to the registered file paths. Restore checks the saved values
and, in the same session and display geometry, the original fingerprints.
SPI_SETCURSORS reloads and broadcasts after registry persistence; its
UPDATEINIFILE flag is deliberately omitted because Windows 11 can reject
that combination even after a successful registry write.

Fourteen conventional Windows slots map to the portable role set. NWPen,
Pin, and Person are preserved. Native Windows INF/CUR/ANI input, signed
release distribution, and verification on ARM64 remain future work.

## Packaging and updates

`build-windows-converter.py` freezes the pinned Python runtime on Windows.
Its staging directory inherits the checkout's access controls so a build
made over an elevated SSH session still runs under the desktop's limited
user token. Application stores use a private user/SYSTEM/Administrators
DACL. Unix permission bits and directory fsync are not Windows security or
durability APIs; transaction files are still flushed before atomic rename.

`windows-package.cjs` validates PE architectures, native Node libraries,
converter self-test, resources, build identity, and complete file hashes.
`install-windows.mjs` stages a per-user installation, verifies the actual
running executable/build/session, and retains the previous install until
activation succeeds. Its temporary scheduled tasks use the current user's
interactive token when invoked over SSH. Cleanup runs in the desktop and
verifies the resulting Recycle Bin item; recycling from session 0 can
silently ignore the requested recycle option.

`npm.cmd run make` also creates an assisted per-user NSIS setup executable.
Forge builds and verifies the payload; electron-builder packages that exact
payload with a welcome screen, visible installation progress, and an optional
launch on completion. Setup keeps the authoritative installation at
`%LOCALAPPDATA%/Programs/Cursor Atelier`, verifies the new renderer before
committing, and retains the previous installation for recovery. It migrates
the earlier one-off Squirrel installation only after the new build verifies.
The developer installer preserves NSIS uninstall ownership on later updates.

## Verification

Run unit tests and lint in the Windows checkout:

```powershell
npm.cmd run test:run -- --maxWorkers=2
npm.cmd run lint
npm.cmd run package
```

Some importer tests use the ignored, pinned upstream Remus, Nordzy, and
Google fixtures acquired by the existing source acquisition tooling.
Platform-specific native tests and POSIX directory-fsync injections skip
when those facilities are unavailable.

Run the packaged integration suite from the signed-in Windows desktop:

```powershell
npx.cmd playwright test test/e2e/desktop-package-smoke.spec.mjs
```

It launches the staged app only with isolated temporary state and startup
registration disabled, checks native resources, and imports all 19 Oreo
variants through the real first-run UI. Set
`CURSOR_ATELIER_LIVE_PACKAGE_SMOKE=1` to additionally apply, resize, randomize,
and restore actual system cursors. Run this only in a disposable development
desktop. `CURSOR_ATELIER_LIVE_WINDOWS_SMOKE=1` enables the focused native
apply/resize/exact-restore test. Both live tests restore the baseline in a
finally block and retain diagnostics when restoration cannot be verified.

A release validation also needs two installed builds: leave the first build
running, install the newer build, verify exact process/build replacement,
startup/shortcut state, and preservation of user data, then inspect and run
`npm run package:clean`. Unit tests alone do not establish that lifecycle.

## Development VM validation, 2026-09-20 to 2026-09-21

Verified on Windows 11 Pro 25H2 x64 (build 26200.8037), with application
processes running under the signed-in user's limited desktop token:

- Full Vitest suite: 519 passed, 46 platform-specific or opt-in tests skipped,
  zero failures. ESLint and Git whitespace checks passed.
- Two opt-in native tests applied static CUR and animated ANI cursors,
  changed size, and restored all saved registry values/types and the original
  Arrow, IBeam, and Hand pixel/hotspot fingerprints.
- Three packaged integration tests passed. They preserved system appearance,
  verified the self-contained converter, imported all 19 pinned Oreo variants,
  then applied, resized, assigned, randomized, and restored live cursors.
- Installed build 1789943204458 was left running in the background while
  build 1790006349485 replaced it. The old processes exited, the exact new
  installed executable reached a ready renderer in desktop session 1, and
  startup registration, shortcut, and user data survived the update. The test
  restored the original preferences byte-for-byte and original startup state.
- Final build 1790007022162 added UI text/encoding corrections, passed the
  two focused packaged launch/converter checks, and replaced the running
  previous build. Its installed executable reached a ready renderer with
  the original preferences, onboarding data, startup state, and shortcut intact.
- Cleanup dry-run and execution recycled the exact staging directory and
  four superseded installations. All five items were independently found in
  the Recycle Bin with their original paths; only the current installation
  remains active, with no temporary verification tasks.

The interruption audit fixed restore-status reporting, Electron startup
lookup of paths containing spaces, persisted recovery-state validation, and
Windows metadata link checks. Live tests keep the profile and recovery files
if restoration cannot be verified. These results establish this development
milestone; they do not establish native Windows pack import, ARM64 behavior,
or signed release distribution. Actual reboot/sign-in and mixed-DPI
wake/unlock/display-event combinations still need broader desktop testing.

## Family-test fixes, 2026-09-21

The repeated native library inventory was invalidating and synchronously
rechecking every cursor resource and preview. With 120 fixture themes and
5,640 distinct PNG previews, repeated reads previously took 4.7–5.0 seconds
and starved a 25 ms main-process timer. After retaining the inventory until
an explicit library mutation, repeated reads took 4–8 ms. A 500-read run
remained at 3–4 ms on average with a stable 16 MB heap after collection.
Cold inventory validation remains proportional to library size.

Windows status now combines registry and live-cursor checks into one native
observation, reuses apply verification, and shares concurrent status requests.
Linux shares concurrent status requests with the same mutation boundaries.
Final build 1790027921254 passed three actual Windows appearance transitions:
dark with system app appearance in 8.048 seconds, light with dark app appearance
in 7.494 seconds, and dark with light app appearance in 7.385 seconds. Each
result verified the live cursors. The test restored the original cursor state
and both Windows appearance registry values, then removed its temporary profile.
PowerShell startup and native verification still account for several seconds;
these timings do not establish instant switching or native behavior on other OSes.

Validation on the Windows VM:

- The final full unit run passed 527 tests, skipped 46, and timed out one existing
  filesystem test at its five-second limit while packaging ran concurrently.
  That exact test passed when rerun alone: 528 active tests passed in total.
- ESLint, Prettier, and Git whitespace checks passed.
- Packaged UI automation passed 100 browsing interactions plus rail ownership,
  collapse/first-entry behavior, search, keyboard selection, source removal and
  movement, toolbar geometry, mobile drawer remount, and 320 px layout checks.
- The packaged native suite imported all 19 Oreo variants and passed actual
  apply, resize, default assignment, randomization, restore, and system-mode
  changes; the other two packaged launch/converter checks also passed.
- The replacement NSIS installer upgraded the running original Squirrel build
  1790007903967 to interim build 1790027051555 with visible progress. It retired
  the old installer and processes, preserved preferences and onboarding bytes,
  and repaired the Start Menu shortcut to the authoritative installation.
- The final NSIS-to-NSIS upgrade replaced running build 1790027051555 with
  build 1790027921254. Welcome appeared at 6.7 seconds, progress at 7.3 seconds,
  and completion at 46.8 seconds. The sole running main process used the
  authoritative Programs path and the complete installed manifest verified.
- A subsequent developer installation of the final build preserved the NSIS
  uninstaller hashes and registration. Original preferences and onboarding data
  remained byte-identical; the final build ran as the sole main process.
- Cleanup dry-run and execution recycled the staging tree, all three superseded
  recovery installations, and validated retired Squirrel residue. Final inventory
  contained only the authoritative installation; the final renderer was ready,
  user data remained unchanged, and temporary native-test tasks were removed.
