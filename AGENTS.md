# Repository Guidelines

## Supreme Top Priority — The "Codebase Health" Rule

Treat every contribution as a long-term architectural decision: follow established patterns, conventions, and ownership boundaries. Where sensible from a high-level, long-term perspective, extend existing constructs before introducing new ones or one-off paths. Each change should leave the codebase more coherent than before by centralizing responsibility, avoiding parallel implementations, and delivering net simplification rather than net complexity.

**IMPORTANT: At the beginning of your very first response to the human in a new conversation, state your awareness of the above rule and repeat it ver batim.**

(We established this after a costly rewrite caused by reactive, directionless/ad-hoc coding. Regardless of size or scope, every change must pass this big-picture test: "If the app were designed from scratch to include this, is this how it would be implemented?")

## JavaScript-First Policy

This is a JavaScript-first project: write app code in `.js/.jsx` by default. TypeScript may exist only where explicitly required by dependency/tooling constraints.

## Component Sourcing Rules

Do not build custom UI components immediately. Follow this chain:

1. Existing: Reuse/extend current project components.
2. shadcn/ui: Run npx shadcn@latest add <component...>. Import from @/components/ui/\*. Never recreate shadcn components from memory.
3. Custom: Build from scratch ONLY if 1 and 2 fail. Prefer existing shadcn + Tailwind patterns where possible.

## UI Implementation Policy

For any screen, modal, or flow, begin with modern default implementations and canonical library patterns. Only introduce customization after a working default is in place and there is a clear product requirement to diverge.

## General

- DRY DRY DRY. For all changes, big or small, local or systemic, ask yourself, "What does the code I'm changing do?" and, "What else in the codebase does the same thing, or even something similar?" Whenever the answer isn't "Nothing," DRY it up!
- For any feature without built-in support from the tech stack, prefer the overwhelmingly popular/dominant library/package over hacking together a custom implementation.
- Don't add notes to commits or licenses or anywhere else about how AI (in general, or a specific one) worked on the project.
- Don't leave low value comments around the codebase (e.g., AIs are notorious for describing the change(s) you made).
- Never build backwards/legacy compatability. The app is in active pre-release development.
