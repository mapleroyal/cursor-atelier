# Shape design system

- Use Tailwind radius utilities for every rounded treatment. Do not add component-specific squircle masks or clipping paths.
- `src/globals.css` upgrades every nonzero CSS border radius—including pseudo-elements, partial corners, arbitrary values, and `rounded-full` controls—to `superellipse(1.5)` when Chromium supports `corner-shape`.
- Supporting Chromium builds scale the shared radius ladder by 1.25 so the superellipse keeps the intended visual reach. Other builds retain ordinary border-radius geometry and the original scale.
- Cursor Atelier intentionally keeps its compact 8/10/12/16px base radius ladder. Keep `--app-corner-radius-scale`, `--app-corner-shape`, `--radius-base`, and the ladder ratios centralized in `src/globals.css`.
- The only round CSS treatments are native radio inputs and elements explicitly marked `data-corner-shape="round"`. The marker resets the element and its own `::before`/`::after`; it does not affect descendants.
- Use the explicit round marker only for radio controls, status/presence lights, CSS-border loading spinners, and avatars/profile images. Mark nested pieces individually if a component contains more than one of those shapes.
- Checkboxes remain squircles. That includes the onboarding selection indicator. The appearance selector's `role="radio"` buttons also remain squircles because they are the interactive segments of the theme switcher rather than native radio controls.
- SVG geometry is unaffected by CSS `corner-shape`.
