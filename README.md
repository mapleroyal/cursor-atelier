# Electron Template

JavaScript-first Electron starter template built for packaging and distribution with Electron Forge + Vite.

## Purpose

This repo is a reusable baseline for desktop apps that need:

- Electron process scaffolding with secure defaults.
- React renderer with memory-based routing.
- Shared global state and async query infrastructure.
- Theme handling that starts from current OS light/dark appearance and supports in-session manual toggling.
- shadcn/ui styling and component primitives.
- Forge makers configured for cross-platform packaging.

## Stack

- Electron + Electron Forge + Forge Vite plugin
- Vite + React
- Tailwind CSS (Vite plugin)
- shadcn/ui (`new-york`, `neutral`, CSS variables)
- React Router (`createMemoryRouter`)
- Zustand
- TanStack Query

### JS-first policy

- App logic is JavaScript (`.js` / `.jsx`).
- Tooling/config files may use `.mjs` where required by the toolchain.
- TypeScript syntax is avoided unless a specific upstream tool requires it.

## Commands

```bash
npm install
npm run start
npm run package
npm run make
npm run lint
npm run lint:fix
npm run test
npm run test:run
```

- `npm run start`: runs Forge dev mode and opens the Electron app.
- `npm run package`: creates packaged app output.
- `npm run make`: builds maker artifacts for the current host OS.
- `npm run lint`: runs ESLint with the flat config.
- `npm run lint:fix`: runs ESLint with autofix.
- `npm run test`: runs Vitest in watch mode.
- `npm run test:run`: runs Vitest once for CI/local verification.

## Quality Baseline

### ESLint

- Setup follows the ESLint manual setup docs: https://eslint.org/docs/latest/use/getting-started#manual-set-up
- Config file: `eslint.config.mjs`
- Uses `@eslint/js` recommended base plus common rules:
  - `no-unused-vars` (warn)
  - `no-undef` (error)
  - `eqeqeq` (error)
  - `curly` (error)
  - `no-var` (error)
  - `prefer-const` (error)
  - `object-shorthand` (error)
  - `no-console` (warn, allows `console.warn` and `console.error`)

### Vitest

- Setup follows the Vitest guide for adding Vitest to a project: https://vitest.dev/guide/#adding-vitest-to-your-project
- Config file: `vitest.config.mjs`
- Current high-value scaffold tests:
  - `src/stores/app-store.test.js`: validates system-theme initialization, fallback behavior, and manual toggle reset flow.
  - `src/lib/query-client.test.js`: validates conservative QueryClient defaults.
  - `src/app/router.test.jsx`: validates memory router baseline at `/`.

## Directory Map

- `forge.config.js`: Forge makers/plugins config with Vite entry wiring.
- `vite.main.config.mjs`: Vite config for Electron main process.
- `vite.preload.config.mjs`: Vite config for preload process.
- `vite.renderer.config.mjs`: Vite config for renderer (React + Tailwind + alias).
- `eslint.config.mjs`: ESLint flat config.
- `vitest.config.mjs`: Vitest config and alias wiring.
- `src/main.js`: Electron main lifecycle + BrowserWindow bootstrap.
- `src/preload.js`: safe `contextBridge` API surface.
- `src/renderer.jsx`: React app bootstrap with Query and Router providers.
- `src/app/router.jsx`: memory-backed route tree.
- `src/app/routes/home.jsx`: welcome screen composed from shadcn CLI components.
- `src/app/router.test.jsx`: router scaffold tests.
- `src/stores/app-store.js`: baseline Zustand store.
- `src/stores/app-store.test.js`: store scaffold tests.
- `src/lib/query-client.js`: shared TanStack Query client.
- `src/lib/query-client.test.js`: query client scaffold tests.
- `src/components/ui/*`: shadcn CLI-generated UI primitives.
- `components.json`: shadcn registry/config contract.
- `jsconfig.json`: `@/* -> src/*` alias mapping.

## Packaging Notes

Forge includes makers for Windows/macOS/Linux (`squirrel`, `zip`, `deb`, `rpm`).

- `npm run make` generates artifacts for maker targets supported by the current OS runtime.
- For full cross-platform artifacts, run make on native CI runners per OS.

## shadcn Setup Note

This template uses shadcn manual+CLI setup because Forge uses split Vite config files, which auto-detection does not always infer reliably.
