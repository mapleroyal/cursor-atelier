# Native cursor system

The native layer is the only part of Cursor Atelier that touches macOS cursor
registrations. `native/oreo` contains the Objective-C engine adapted from the
Oreo proof of concept; `native/cursor-packs` acquires, converts, previews, and
validates the requested upstream packs at build time. Electron main invokes
the signed native executable through a small JSON command contract.

## Build flow

```text
pinned upstream cache
  -> cursor-packs/build_all.py
     -> ignored generated/ (220 external .cursor files + unified manifest/previews)
        -> oreo/build.sh
           -> signed Oreo Cursor.app (239 runtime resources + login helper)
              -> Forge package under Cursor Atelier.app/Contents/Resources/
```

The 19 Oreo `.cursor` files are vendored in
`native/oreo/Resources/Themes`. The converter adds 220 external resources and
generates schema-v2 metadata/previews for all 239 variants. Every variant has
the same 47 explicit native identifiers. The current preview corpus contains
9,290 unique PNGs; role aliases may reference the same PNG.

The acquisition cache and `generated/` are ignored build artifacts. The app
contains neither one: only the nested signed native runtime app, its 239
`.cursor` files, schema-v2 manifest, previews, and runtime notices are staged
outside `app.asar`.

## Build

On macOS 13 or newer, install librsvg and the pinned Python dependency, then
populate or verify the source cache:

```sh
brew install librsvg
python3 -m pip install -r native/oreo/ArtworkSource/requirements.txt
python3 native/cursor-packs/acquire_sources.py
python3 native/cursor-packs/acquire_sources.py --verify-only
npm run native:packs
```

Build with a stable Apple-issued signing identity visible to
`security find-identity -v -p codesigning`:

```sh
OREO_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" npm run native:build
npm run native:preflight
```

The result is:

```text
native/oreo/build/Release/Oreo Cursor.app
```

Ad-hoc signing is rejected for this nested app because `SMAppService` must
recognize the login helper across launches. The native app and helper must
retain the same nonempty TeamIdentifier while using distinct identifiers:

- `com.cursoratelier.CursorAtelier.NativeCursor`
- `com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper`

Both versions are stamped from the root `package.json`. The outer personal
Electron app uses `com.cursoratelier.CursorAtelier`; Forge signs it with the
same Apple Development identity so its background launch registration is
stable across builds. Developer ID distribution signing and notarization are
not required for the personal build.

`native:preflight` verifies signatures, identities, versions, macOS 13.0,
exact inventory digests, every resource SHA-256, 47 role previews per theme,
native list parity, and a read-only native decode of all 239 resources. Forge
runs the same preflight before package and make.

## Schema-v2 manifest

`native/cursor-packs/generated/manifest.json` is a unified renderer/native
allowlist. A shortened row looks like:

```json
{
  "schemaVersion": 2,
  "roleCount": 47,
  "themes": [
    {
      "Identifier": "Vimix",
      "DisplayName": "Vimix",
      "Variant": "Default",
      "UpstreamVariant": "Vimix",
      "Group": "Vimix",
      "Resource": "Vimix.cursor",
      "SHA256": "<64 lowercase hex characters>",
      "UUID": "<stable UUIDv5>",
      "SourceURL": "https://github.com/vinceliuice/Vimix-cursors",
      "License": "GPL-3.0-only",
      "preview": "previews/Vimix/default.png",
      "rolePreviews": [
        {
          "asset": "previews/Vimix/default.png",
          "macIdentifier": "com.apple.coregraphics.Arrow",
          "role": "default",
          "fallback": false,
          "frameCount": 1,
          "frameDuration": 1.0,
          "hotspot": { "x": 4.0, "y": 4.0 }
        }
      ]
    }
  ]
}
```

The exact 220 external IDs, 19 Oreo IDs, and 47-role contract are locked in
`native/cursor-packs/inventory-lock.json`; digests prevent a count-preserving
substitution. Resource basenames, paths, hashes, metadata geometry, fallback
rates, animation, and preview files are all validated before promotion and
again before packaging.

## Runtime contract

The native executable supports status, list, validate, atomic apply, complete
teardown, Login Items settings, and lower-level diagnostic commands. Electron
uses `--apply-theme <identifier>` rather than a select/enable sequence and
uses `--teardown` rather than a superficial disable. See
`native/oreo/POC-README.md` for the full CLI and native recovery details.

If the signed component cannot be discovered or validated, Electron exposes a
read-only preview catalogue. It does not substitute an in-memory apply, enable
the action buttons, or claim the system cursor changed.
