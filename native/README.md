# Native cursor system

All platforms use the same locked source acquisition, source-specific conversion
recipes, 47-role intermediate cursor contract, and PNG/APNG previews. The
on-demand converter is frozen with the pinned Python/Pillow dependencies. SVGs
are rendered through the app's existing Sharp/libvips/librsvg bridge. Porting
Linux changes the final system application layer, not those conversion recipes.

## Build and runtime flow

```text
pinned upstream source archive selected in the app
  -> existing source-specific frozen Python converter + Sharp SVG renderer
     -> verified .cursor intermediate and PNG/APNG previews
        -> per-user ImportedPacks store
           -> macOS: signed Objective-C CoreGraphics/AppKit engine
           -> Linux: Xcursor theme + desktop settings integration
```

The packaged app starts with an empty library. It contains conversion recipes,
source lock metadata, and 45 tiny first-run previews, without the generated
240-theme cursor corpus. `native/cursor-packs/build_all.py` remains an optional
developer corpus build for comparing all 19 Oreo and 221 external variants.

## Linux

Follow the [Linux build instructions](../README.md#linux-build-install-use).
`npm run package` builds the frozen converter for the current Linux architecture,
exports the checked-in application icon, compiles Electron, and verifies all
packaged resources. `npm run native:build` prepares converter/assets separately;
`npm start` also prepares them when missing. No Objective-C or Apple signing
tools are required. The packaged converter and native importer addons must
match Electron's architecture; cross-compilation is rejected.

Linux retains the validated `.cursor` representation internally for lossless
portable import/export with macOS. The final Xcursor encoding uses Clickgen
inside the bundled converter, retaining available frame sizes, hotspots, and
animation timing without a host encoder dependency. Omarchy/Hyprland
is the primary Linux environment; GNOME and KDE integrations use desktop-specific
settings and still require broader live testing. A desktop whose cursor state
cannot be verified does not receive an invented active result.

## macOS

Build the signed native bridge on macOS 13 or newer:

```sh
OREO_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" npm run native:build
npm run native:preflight
npm run package
```

`native/oreo/build/Release/Oreo Cursor.app` is copied outside `app.asar` into the
outer app. The native app and login helper retain the same Apple development
TeamIdentifier with distinct identifiers:

- `com.cursoratelier.CursorAtelier.NativeCursor`
- `com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper`

The visible release version comes from `package.json`; all three apps share a
distinct, increasing build identity. The outer bundle uses
`com.cursoratelier.CursorAtelier`. `native:preflight` verifies signatures,
identities, versions, the empty bundled library, and installed-theme validation
using isolated user state. See [the main README](../README.md#macos-local-build)
for install and cleanup requirements.

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

The exact 221 external IDs, 19 Oreo IDs, and 47-role contract are locked in
`native/cursor-packs/inventory-lock.json`; digests prevent a count-preserving
substitution. Resource basenames, paths, hashes, metadata geometry, fallback
rates, animation, and preview files are all validated before promotion and
again before packaging.

## Runtime contract

On macOS, the native executable supports status, list, validate, atomic apply, complete
teardown, Login Items settings, and lower-level diagnostic commands. Electron
uses `--apply-theme <identifier>` rather than a select/enable sequence and
uses `--teardown` rather than a superficial disable. See
`native/oreo/POC-README.md` for the full CLI and native recovery details.

Linux exposes the corresponding operations through its main-process desktop
adapter. It records the original desktop settings before application, verifies
the chosen theme through that desktop's control interface, and restores the
saved settings on teardown. Hyprland also updates the systemd user activation
environment when present, so apps launched through UWSM receive the selected
cursor theme and size; Restore returns those variables to their original values.

When a platform component cannot be discovered or validated, the UI leaves
assignment unavailable and reports the missing capability. It does not
substitute an in-memory apply or claim the system cursor changed.
