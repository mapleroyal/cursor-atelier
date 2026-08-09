# Code and Polish Review Tracker

Last updated: 2026-08-09

## Scope

This tracker covers the actionable findings from the comprehensive code and
polish review. Packaging, distribution, repository administration, and custom
accessibility work are intentionally out of scope.

## Findings

| ID     | Priority | Finding                                                                                         | Resolution                                                                                                                                                                     | Status   |
| ------ | -------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| CPR-01 | P1       | Fail closed when native status is incomplete or malformed.                                      | Require the complete native status contract, reject malformed or conflicting aliases, and reject mutations whose result cannot be verified.                                    | Complete |
| CPR-02 | P2       | Bound import memory and keep CPU-heavy cursor conversion off the Electron main thread.          | Stream variants through a dedicated worker, cap retained decoded artwork and total generated output, and terminate workers that exceed a bounded wall-clock runtime.           | Complete |
| CPR-03 | P2       | Make Python-generated cursor validation match the native runtime contract.                      | Validate the exact identifier set, numeric types, geometry, timing, scale ordering, required scales, and encoded/decoded byte budgets; reject edge hotspots during generation. | Complete |
| CPR-04 | P2       | Consume failure-page navigation rejections in the main process.                                 | Preserve the window-show finalizer while catching and reporting rejection from the failure-page load.                                                                          | Complete |
| CPR-05 | P2       | Keep asynchronous apply feedback attached to the pack that was applied.                         | Capture the operation target and scope apply, size, appearance-assignment, pending, success, and error presentation to that pack.                                              | Complete |
| CPR-06 | P2       | Preserve focus on a newly added scheduled time after normalization sorts it.                    | Reconcile schedule rows by stable identity and restore focus by row ID instead of array index.                                                                                 | Complete |
| CPR-07 | P3       | Retain queued renderer navigation until delivery succeeds.                                      | Remove queued navigation only after a successful send and mark the renderer unready after a send failure.                                                                      | Complete |
| CPR-08 | P3       | Use one Unicode control-character policy for imported metadata generation and installation.     | Share the Unicode Cc/Cf policy between metadata sanitization and manifest installation validation.                                                                             | Complete |
| CPR-09 | P3       | Remove the nonfunctional family disclosure affordance from search results.                      | Render search-result family labels as static headings while retaining normal disclosure controls outside search.                                                               | Complete |
| CPR-10 | P3       | Restore a conventional tooltip hover delay.                                                     | Use the provider's 500 ms default hover delay while retaining immediate close behavior.                                                                                        | Complete |
| CPR-11 | P3       | Use a clear/close glyph for clearing search instead of a delete glyph.                          | Replace the delete glyph with the existing close glyph.                                                                                                                        | Complete |
| CPR-12 | P3       | Refresh the secondary native window when the selected theme's size changes externally.          | Include the configured/effective theme size in the native window's stale-state comparison.                                                                                     | Complete |
| CPR-13 | P3       | Avoid eager full-resource loading and repeated manifest parsing in the secondary native window. | Cache the immutable bundled catalogue and use securely validated lazy preview URLs for bundled and imported themes.                                                            | Complete |

## Verification Checklist

- [x] Focused tests cover each corrected behavior where a stable, high-signal test is practical.
- [x] ESLint passes.
- [x] Vitest passes.
- [x] Cursor-pack Python tests pass.
- [x] Native Oreo Python tests pass, except for the documented root-only ownership test.
- [x] Objective-C syntax and compiled harness checks pass.
- [x] Current-source UI smoke checks pass at the supported responsive breakpoints.
- [x] The final diff contains no generated or temporary artifacts.

## Verification Results

- `npm run lint`: passed.
- `npm run test:run`: 21 files and 303 tests passed.
- `python3 -m unittest discover -s native/cursor-packs -p 'test_*.py'`:
  48 tests passed.
- `python3 -m unittest discover -s native/oreo -p 'test_*.py'`: 54 tests
  passed with one expected skip because changing file ownership requires root.
- Python compile checks and Objective-C app/helper `-Wall -Wextra`
  syntax checks passed. The Oreo suite also compiled, linked, and invoked the
  lazy-preview selector in its native harness.
- The native contract validator accepted all 240 checked cursor artifacts: 221
  generated resources and 19 bundled resources.
- The Forge/Vite source build produced the main, preload, and cursor-import
  worker targets and launched the Electron app successfully.
- Current-source UI smoke checks passed at 760, 959, and 960 px with no document
  overflow, console errors, or page errors. Search headings had no false
  disclosure control, tooltip timing matched the 500 ms policy, and a newly
  added `00:00` schedule entry retained focus after sorting and persistence.
- Prettier and `git diff --check` passed for the final change set.

## Decision Log

- 2026-08-09: Created this tracker before implementation.
- 2026-08-09: Kept packaging, installation, distribution, repository
  administration, and bespoke accessibility work outside this effort as
  requested.
- 2026-08-09: Independent cross-review found and resolved contradictory native
  status aliases, an unbounded non-responsive worker, and missing imported
  native previews before delivery.
