# General

- DRY, YAGNI, measure twice cut once, and so forth. Do not over-engineer.
- For every functionality (backend/UI/UX) without built-in support from the tech stack, prefer (and install as needed) the overwhelmingly popular/dominant library/package over hacking together a custom implementation.
- Never build backwards/legacy compatibility. The app is in active pre-release development.

# Design Aesthetic

- Quiet and utilitarian
- No-or-low helper copy
- The UI/UX should be intuitive and self-explanatory
- No card-slop (avoid overuse of giving several UI details a container-analogous background and/or outline)
- See /Users/user1/Projects/markdown-reader-editor or /Applications/ChatGPT.app when design questions would benefit from a favored reference

# UI Components

Use `@/components/ui/*` and Shadcn/Radix primitives. Compose from existing parts when possible. Build from scratch only when none of the above satisfy the requirement.

# Styling Policy

- Use Tailwind v4. If you aren’t sure, reference the v4 docs.
- When unsure, check how /Users/user1/Projects/markdown-reader-editor and /Applications/ChatGPT.app handle it.

# Scope Control

- Don't work ahead of the current task. Let the implementers of future tasks own the design and implementation of those tasks.
- You may repair or improve work from before your task if it relates to your task, nothing is set in stone just because it was done a certain way at some previous point—**if there's a better way, do that**.

# Tests

- If you're considering adding low-value or low-signal tests, don't. For example, no so-called "regression" tests unless things that were explicitly specified and definitely working correctly are now broken.

# Delivery, Installation & Updates

- Treat installation and update work as a state migration, not just a build or file copy. Inventory installed app bundles, resident helpers/agents, login items, caches, generated artifacts, persisted schemas, and prior-version paths that the release owns.
- Keep the user-facing release version separate from a unique, monotonically increasing build identity. Stamp the main app and every bundled helper/service from the same exact build; never reuse a static release version as the identity macOS uses to decide whether resident code is current.
- Never assume replacing an app bundle replaces code already running from it. On packaged launch, compare registered/running helper identity with the installed build and use the platform lifecycle API to terminate/unregister and re-register/relaunch obsolete services. Reconcile disabled and legacy registrations too.
- Make updates transactional: stage and verify the new signed artifact, preserve a recoverable prior install, activate and verify the new build and its background processes, then move superseded artifacts to Trash. If activation or verification fails, restore the prior installation and registration state.
- Preserve user-created data unless a migration explicitly owns it. Cleanup must target only validated, version-owned artifacts and must follow the repository's destructive-action safeguards.
- Test an update from a previous installed build while its helper/background process is actually running. A clean-install test is insufficient; verify bundle/build identities, process replacement, registrations, migrations, user data, and absence of duplicate or obsolete processes afterward.
- For Cursor Atelier code or delivery changes, wrap-up is not complete after packaging: build the newest signed app, install it at `/Applications/Cursor Atelier.app`, launch it, verify that the installed bundle and resident login helper are from that build, and safely clean up the superseded app. Do this automatically unless the user explicitly asks not to install.

# Troubleshooting & Problem-Solving

- **Root-Cause Fixes Only**: Diagnose and correct the causes of problems, not their symptoms; avoid workarounds or patching established, likely-stable packages. Prefer fixes that are idiomatic to the stack components involved. If there is any uncertainty, eagerly search the docs on the web for the most current best practices.
- **Log Before You Leap**: When the correct solution isn't obvious, add console logging to trace actual runtime behavior. Speculative attempts are allowed only when guided by logging rather than guesswork.
- **Cleanup**: Whenever an attempt doesn't work, remove it before trying the next one.
