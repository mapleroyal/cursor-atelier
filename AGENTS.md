# General

- DRY, YAGNI, measure twice cut once, and so forth. Do not over-engineer.
- For every functionality (backend/UI/UX) without built-in support from the tech stack, prefer (and install as needed) the overwhelmingly popular/dominant library/package over hacking together a custom implementation.
- Never build backwards/legacy compatibility. The app is in active pre-release development.
 
# UI Components

Use `@/components/ui/*` and Shadcn/Radix primitives. Compose from existing parts when possible. Build from scratch only when none of the above satisfy the requirement.

# Styling Policy

- Use Tailwind v4. If you aren’t sure, reference the v4 docs.
- When unsure, check how /Users/user1/Projects/markdown-reader-editor and /Applications/ChatGPT.app handle it.

# Scope Control

- Don't work ahead of the current task. Let the implementers of future tasks own the design and implementation of those tasks.
- You may repair or improve work from before your task if it's tied to your task, nothing is set in stone just because it was done a certain way at some previous point—if there's a better way, do that.

# Tests

- If you're considering adding low-value or low-signal tests, don't. For example, no so-called "regression" tests unless things that were explicitly specified and definitely working correctly are now broken.

# Troubleshooting & Problem-Solving

- **Root-Cause Fixes Only**: Diagnose and correct the causes of problems, not their symptoms; avoid workarounds or patching established, likely-stable packages. Prefer fixes that are idiomatic to the stack components involved. If there is any uncertainty, eagerly search the docs on the web for the most current best practices.
- **Log Before You Leap**: When the correct solution isn't obvious, add console logging to trace actual runtime behavior. Speculative attempts are allowed only when guided by logging rather than guesswork.
- **Cleanup**: Whenever an attempt doesn't work, remove it before trying the next one.