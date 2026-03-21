# Electron Template

Desktop scaffold for building modern Electron applications.

## Stack

- Electron 40 + Electron Forge + Vite
- React 19 + React Router v7 (`createMemoryRouter`)
- Tailwind CSS v4
- shadcn/ui (`radix-maia` style, Hugeicons, Geist font) with the full component set installed
- Zustand + TanStack Query
- ESLint + Vitest

## Theming

- `src/globals.css` — Tailwind v4 theme tokens and shadcn theme setup
- `src/stores/app-store.js` — `theme`, `setTheme`, `toggleTheme`
- `src/app/theme-sync.jsx` — syncs `html.dark` to the store
- Initial theme falls back from persisted preference to Electron system theme to OS preference

## Structure

```text
src/
  app/
    routes/
      home.jsx
    router.jsx
    theme-sync.jsx
  components/
    ui/
  hooks/
    use-mobile.js
  lib/
    query-client.js
    utils.js
  stores/
    app-store.js
  main.js
  preload.js
  renderer.jsx
  globals.css
```

## Commands

```bash
npm install
npm start
npm run package
npm run make
npm test
```
