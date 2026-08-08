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
than the packaged native component, so the suite exercises layout, search,
appearance persistence, preload fallback, and catalogue behavior in truthful
preview mode. Cursor-assignment and Restore controls remain disabled, and it
cannot change the host cursor.

The packaged-native smoke spawns the exact
`Contents/MacOS/Cursor Atelier` Forge executable as a normal child process;
production fuses intentionally prevent Playwright's Electron-driver launch
hooks. The test reserves an ephemeral `127.0.0.1` port, starts the app with a
separate temporary user-data directory and loopback-only remote debugging, then
attaches through CDP. Bridge/manifest overrides are removed.

The CDP session performs only read-only status, verifies the complete 240-theme
bundled inventory plus any valid user-imported themes, checks 47-role metadata,
parses an animated preview's APNG frame and timing controls, and exercises the
custom image protocol. It does not invoke Import, Apply, Restore, Login Items
settings, or any other cursor mutation. Cleanup closes CDP, terminates the child
if needed, waits for exit, and recursively removes only a realpath-validated
direct child of the system temporary directory with the expected test prefix.
