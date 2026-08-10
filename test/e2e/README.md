# Electron end-to-end tests

The suite uses Playwright in two deliberate modes: the Electron driver for the
safe preview-mode UI suite, and a normal child process plus loopback CDP for the
packaged-native smoke. The normal command builds a fresh Forge artifact
(including native preflight) before running both:

```bash
npm run test:e2e
```

To run only the safe UI suite against an existing renderer archive, set
`CURSOR_ATELIER_ASAR` to its `Contents/Resources/app.asar` path:

```bash
CURSOR_ATELIER_ASAR="/path/to/Cursor Atelier.app/Contents/Resources/app.asar" \
  npx playwright test test/e2e/cursor-atelier.spec.mjs
```

The UI suite launches `app.asar` directly with native bridge and manifest
overrides removed. That gives Electron a temporary resources directory rather
than the packaged native component. It covers the fresh-profile 15-family
chooser, whole-row/select-all/deselect-all behavior, zero-selection onboarding,
the empty library, settings persistence, and truthful preview-mode safety.
Cursor-assignment and Restore controls remain disabled, so it cannot change the
host cursor.

The packaged-native smoke spawns the exact
`Contents/MacOS/Cursor Atelier` Forge executable as a normal child process;
production fuses intentionally prevent Playwright's Electron-driver launch
hooks. The test reserves an ephemeral `127.0.0.1` port, starts the app with a
separate temporary user-data directory and loopback-only remote debugging, then
attaches through CDP. Bridge/manifest overrides are removed.

The packaged checks prove that no `.cursor` payload is bundled, the signed
native bridge accepts a valid empty library, and the packaged source converter
is executable. A conversion smoke creates an exact pinned Future source archive
from the local acquisition cache, supplies it through
`CURSOR_ATELIER_CURATED_ARCHIVE_ROOT`, and verifies that both variants install
progressively beneath one collapsed family. It never invokes Apply, Restore, or
Login Items settings; all converted data stays inside the temporary profile.
Cleanup closes CDP, terminates the child if needed, waits for exit, and
recursively removes only a realpath-validated direct child of the system
temporary directory with the expected test prefix.
