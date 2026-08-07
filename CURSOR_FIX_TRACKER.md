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

| Workstream | Status | Owner | Notes |
| --- | --- | --- | --- |
| Prior context and architecture review | Complete | root | Old tracker, referenced Codex task, current architecture, and imported duplicates reviewed. |
| Spinner/resolution investigation | Complete | spinner_investigation/root | Exact lookup fixed; full rebuild and source/preview frame audits are clean. |
| Family assignment and creation | Complete | family_delete_investigation/root | Imported packs move to canonical existing families or a newly named family from the rail menu. |
| Cursor/family deletion | Complete | family_delete_investigation/root | Imported-only rail actions confirm, deactivate safely, and move validated artifacts to Trash. |
| Rail indicator removal | Complete | size_ui_investigation | Removed only the left-side selection bar; row selection and live-state checkmarks remain. |
| Per-cursor size preview | Complete | size_ui_investigation | Per-theme 50–200% native geometry with a live arrow preview and explicit Apply/Reapply. |
| Verification and documentation | Complete | root | Full tests/lint, corpus audit, signed build/preflight, package/E2E, visual inspection, and architecture update complete. |

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

## Decision Log

- 2026-08-06: Created this tracker before investigation, as requested.
- 2026-08-06: Split investigation across spinner assets, import/family/deletion behavior, and cursor-size/UI feasibility while root reviews prior task context and current architecture.
- 2026-08-06: Began a full transactional corpus rebuild after the exact-frame resolver fix passed all cursor-pack tests.
- 2026-08-06: Completed the transactional rebuild of all 239 themes; no staging output was promoted until validation succeeded.
- 2026-08-06: Kept cursor sizing per theme and left the private global Accessibility default untouched. Slider movement is preview-only; Apply/Reapply is the live-registration boundary.
- 2026-08-06: Limited destructive actions to imported data because bundled cursor resources are inside the signed app. Mixed built-in/import families cannot be deleted as a family.

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
