# Change Batch — 2026-08-10

## Onboarding

- [x] Remove helper copy from the selection screen.
- [x] Rename “Deselect all” to “Select none”.
- [x] Add a muted bottom-left “Skip” action that persists an empty selection and continues.

## Main View

- [x] Move the cursor-size percentage into the preview’s bottom-right corner beside the slider.
- [x] Replace the Size tooltip with the supplied System Settings guidance.

## Reliability

- [x] Find and fix the root cause of repeated, uncaught `AbortError: Request aborted` dialogs during initial cursor preparation.

## macOS Integration

- [x] Remove app-controlled Dock icon light/dark switching and return icon appearance control to macOS.
- [x] Add a concise informational Settings item describing System Settings → Appearance → Icon & widget style → Dark → Auto.

## Scrollbars — Investigation Only

- [x] Determine whether always-visible scrollbar rails have a definite app-level cause.
- [x] Make no scrollbar styling change unless the cause and idiomatic correction are clear.

## Verification

- [x] Run focused automated checks.
- [x] Verify affected UI states visually.
- [x] Package, install, launch, and verify the installed app/update lifecycle.
- [x] Perform the required staged-artifact cleanup and duplicate-bundle checks.

## Notes

- Created before implementation, as requested.
- Scrollbar investigation found no app CSS targeting scrollbars, no scrollbar/GPU
  command-line switches, and no `app.disableHardwareAcceleration()` call (a known
  cause of persistent Electron scrollbars). The current macOS global preference has
  no `AppleShowScrollBars` override, and AppKit reports the effective preferred
  scroller style as `overlay`. No scrollbar code was changed because there is no
  definite app-level cause.
- The onboarding popup came from directly destroying Undici response bodies
  while following redirects. Undici emits an asynchronous `AbortError` for that
  early destruction even though the redirected request continues. Discarded
  bodies now use Undici's supported `dump()` disposal path; real acquisition
  failures are still reported normally.
- Removed the runtime `app.dock.setIcon` override and all generated light/dark
  Dock PNG plumbing. The native Icon Composer asset remains the app icon source,
  including its system-managed dark specializations and legacy `.icns` fallback.
- Verification passed with 401 unit/integration tests, 10 packaged UI/native
  tests, lint, package signature checks, and visual review of onboarding,
  Settings, and cursor-size detail states.
- Installed build `20260810154540` replaced `20260810141039`. The running main
  process and relaunched login helper both resolve inside
  `/Applications/Cursor Atelier.app`; persisted settings hashes and all 240
  imported pack directories were unchanged.
- Spotlight resolves the bundle identifier only to the installed app. The
  staged package output and superseded installed bundle were moved to Trash.
