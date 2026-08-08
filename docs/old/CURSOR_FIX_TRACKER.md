# Cursor Fix Tracker

Last updated: 2026-08-06

## Scope

- Remove the selected-cursor indicator from the left rail.
- Diagnose and fix cyclic glitches in built-in Colloid, Future, and Vimix wait/progress animations.
- Let imported cursors be assigned to an existing or newly created family.
- Add right-click deletion for cursors and families, with confirmation.
- Add per-cursor size customization with a live main-arrow preview, or document/use the closest safe macOS-backed alternative.
- Compare manually imported duplicates with built-ins for animation and sharpness differences.
- Record the durable asset-resolution/animation rules in `ARCHITECTURE.md`.

## Guardrails

- Preserve unrelated work already present in the dirty worktree.
- Fix the shared root cause rather than patching individual cursor themes.
- Reuse existing Shadcn/Radix components and the current data model where possible.
- Add only high-signal tests around specified behavior and the diagnosed asset invariant.

## Workstreams

| Workstream                                      | Status   | Owner                            | Notes                                                                                                                                                                                                          |
| ----------------------------------------------- | -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prior context and architecture review           | Complete | root                             | Old tracker, referenced Codex task, current architecture, and imported duplicates reviewed.                                                                                                                    |
| Spinner/resolution investigation                | Complete | spinner_investigation/root       | Exact lookup fixed; full rebuild and source/preview frame audits are clean.                                                                                                                                    |
| Family assignment and creation                  | Complete | family_delete_investigation/root | Imported packs move to canonical existing families or a newly named family from the rail menu.                                                                                                                 |
| Cursor/family deletion                          | Complete | family_delete_investigation/root | Imported-only rail actions confirm, deactivate safely, and move validated artifacts to Trash.                                                                                                                  |
| Rail indicator removal                          | Complete | size_ui_investigation            | Removed only the left-side selection bar; row selection and live-state checkmarks remain.                                                                                                                      |
| Per-cursor size preview                         | Complete | size_ui_investigation            | Per-theme 50–200% native geometry with a live arrow preview and explicit Apply/Reapply.                                                                                                                        |
| Verification and documentation                  | Complete | root                             | Full tests/lint, corpus audit, signed build/preflight, package/E2E, visual inspection, and architecture update complete.                                                                                       |
| Installed-build/helper reconciliation follow-up | Complete | root                             | Moga 180% exposed a stale resident helper from an older same-version package; unique build identity, launch reconciliation, delivery guidance, transactional installation, and live verification are complete. |

## Findings

- The prior resolution work found three relevant invariants: Xcursor pixels need correct premultiplied-alpha handling, vector families should render directly at every target tier, and macOS accessibility scaling benefits from additional native representations instead of enlarging 32/64 px assets.
- The previous corpus rebuild intended to render Qogir, Vimix, Future, and Colloid directly from SVG at 32/64/96/128 px, preserve animation cycle duration during downsampling, and reconstruct distinct Wait/Progress cycles.
- The local imported store contains manual duplicates for Colloid, Colloid Dark, Future, Future Cyan, and Vimix White, giving direct working-vs-bundled comparison material.
- The current renderer already has cursor/family context-menu wrappers and groups every import under the manifest `family` value; import manifests currently use `Imported`.
- Root cause of the Colloid/Future/Vimix glitch: `_candidate_asset` interpreted animation filenames ending in `-16`, `-20`, and `-22` as raster-size suffixes before trying the exact SVG basename. Those rows rendered the static `wait.svg`/`progress.svg` instead of their numbered frame, causing three discontinuities per cycle across every affected SVG family.
- The resolver now tries exact PNG/SVG basenames (including nested SVGs) before size-suffix normalization. The focused exact-frame test and all 45 cursor-pack tests pass.
- Manual imports are less sharp for a separate, expected reason: the supplied compiled Xcursor archives top out at 64 px artwork, while bundled vector sources render directly at 32/64/96/128 px. The importer can expose a 96 px tier, but it cannot invent vector detail absent from the compiled input.
- Per-pack sizing is feasible through native registration geometry, not through macOS Accessibility. The Accessibility cursor-size setting is global/private and remains untouched. The engine scales point geometry and hotspots together while preserving the validated representation pixels, hashes, animation order, and timing; configured and verified-effective sizes are persisted separately.
- Imported family assignment atomically edits only the manifest `Group`. Duplicate identity excludes only that user-editable field, so reimporting identical content still converges; case-only IDs, unsafe Unicode controls, and immutable-content collisions fail closed.
- Imported deletion is serialized with cursor mutations. A live target is restored first, a deleted native selection is reassigned to bundled Oreo White while disabled, artifacts are atomically removed from the indexed store and sent to Trash, and library/native size references are pruned afterward.
- Moga Colors Grey was the reproducer, not a theme-specific failure. The 180% draft persisted and native apply completed; the renderer's later verification failed because a login helper launched from an earlier package remained resident after `/Applications/Cursor Atelier.app` was replaced. Both builds were stamped `0.1.0`, so registration incorrectly treated the old process as current and it reapplied 100% geometry after the new apply notification.
- Delivery now separates the release version from a unique build identity shared by the outer app, native app, and helper. Packaged launch reconciles the registered helper through `SMAppService`, replacing an older resident build or removing obsolete/legacy registrations without selecting or resizing a cursor.

## Decision Log

- 2026-08-06: Created this tracker before investigation, as requested.
- 2026-08-06: Split investigation across spinner assets, import/family/deletion behavior, and cursor-size/UI feasibility while root reviews prior task context and current architecture.
- 2026-08-06: Began a full transactional corpus rebuild after the exact-frame resolver fix passed all cursor-pack tests.
- 2026-08-06: Completed the transactional rebuild of all 239 themes; no staging output was promoted until validation succeeded.
- 2026-08-06: Kept cursor sizing per theme and left the private global Accessibility default untouched. Slider movement is preview-only; Apply/Reapply is the live-registration boundary.
- 2026-08-06: Limited destructive actions to imported data because bundled cursor resources are inside the signed app. Mixed built-in/import families cannot be deleted as a family.
- 2026-08-06: Diagnosed the Moga 180% report from process and code-signing evidence: the resident helper binary predated the installed bundle but survived because both builds used the same static build version. Chose the platform build/version lifecycle fix rather than a Moga asset special case.
- 2026-08-06: Added delivery/update rules to `AGENTS.md`, including unique build identities, live prior-version cleanup, transactional install/rollback, upgrade-path testing, and automatic installation/verification of the newest Cursor Atelier build at wrap-up.

## Verification Log

- `python3 -m unittest discover -s native/cursor-packs -p 'test_*.py'`: 45/45 passed after the resolver fix.
- Direct built-vs-imported frame analysis showed transition outliers only at the misresolved numbered frames; working imported cycles were smooth.
- `npm run native:packs`: rebuilt and validated all 239 themes successfully after the resolver fix.
- Post-rebuild audit covered Colloid, Colloid Dark, Future, Vimix, and Vimix White Wait/Progress: all 920 generated tier/frame images matched their exact numbered SVG renders pixel-for-pixel, and all 230 APNG preview frames matched the corresponding 96 px resource frames.
- Each audited APNG has 23 frames at 30 ms, loops indefinitely, and has no substituted-frame interior spike. Remaining cycle-boundary motion matches the authoritative manual imports and authored sources.
- `npm run test:run`: 138/138 Vitest tests passed across 11 files.
- `npm run lint`: passed.
- `python3 -m unittest discover -s native/oreo -p 'test_*.py'`: 33 passed, 1 environment-gated ownership test skipped.
- Signed universal `npm run native:build` and `npm run native:preflight`: passed; preflight validated all 239 manifest themes.
- `npm run package` and `npx playwright test`: packaged successfully; 10/10 packaged Electron/native smoke tests passed without applying cursors.
- Copied-import visual QA verified the existing-family submenu, new-family dialog, cursor confirmation, family menu, size-preview layout, and absence of the left-side selection indicator. No delete/apply action was executed.
- A live 50%/200% WindowServer mutation was intentionally not run during verification; native scaled-record construction, readback comparison, persistence, and helper reload contracts are covered without changing the user's active cursor.
- Follow-up suites passed after the delivery fix: 139/139 Vitest tests, 45/45 cursor-pack tests, and 34 native tests with one expected root-only ownership skip. Lint, formatting, and diff checks are clean.
- Signed native build `20260807024550` passed preflight for all 239 themes. The packaged Electron, native, and helper bundles all carry that exact build identity, and all 10 packaged Playwright tests passed.
- Transactional installation replaced `/Applications/Cursor Atelier.app` only after staging and signature checks. Resident helper PID 11016 from build `0.1.0` was terminated; new PID 85393 has the same `ed10f29b725f9ff02d326c93d8f6c820dc0de2b3` CDHash as the installed helper, registration reports current, and the superseded app was moved to Trash.
- Live follow-up applied the existing Moga Colors Grey 180% preference. Both the apply result and settled status verified `MogaColorsGrey`, effective size 180, matching sentinels, current helper registration, no transaction, and no error. This directly rules out a Moga-specific geometry or 96 px representation failure as the reported cause.
