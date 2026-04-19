# Electron Template

Desktop scaffold for building modern Electron applications with a routed shell,
tokenized typography, and theme handling that supports light, dark, and system
mode behavior from the start.

## Stack

- Electron 40 + Electron Forge + Vite
- React 19 + React Router v7 (`createMemoryRouter`)
- Tailwind CSS v4
- shadcn/ui primitives in `src/components/ui`
- Zustand + TanStack Query
- ESLint + Vitest

## Included baseline

- `src/app/routes/home.jsx` — starter screen for the template baseline
- `src/app/router.jsx` — renderer routes
- `src/app/theme-bootstrap.js` — applies the resolved theme before React mounts
- `src/app/theme-sync.jsx` — keeps document theme state in sync after mount
- `src/stores/app-store.js` — theme mode persistence and system theme resolution
- `src/preload.js` — renderer-safe Electron bridge
- `src/globals.css` — Tailwind v4 theme tokens, typography scale, and base styles
- `docs/learnings/typography-design-system.md` — typography system guidance

## Commands

```bash
npm install
npm start
npm run package
npm run make
npm test
```
