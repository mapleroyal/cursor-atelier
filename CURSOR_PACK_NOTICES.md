# Cursor pack provenance

Cursor Atelier's curated catalogue describes 240 variants: 19 Oreo themes and
221 themes from the external sources below. The signed app does not contain
their installable `.cursor` resources or the upstream source archives. It
contains the conversion runtime, locked source metadata, and three small
representative preview images per family. When a user chooses a family, the app
downloads its pinned original upstream input, verifies it, converts every
variant locally, installs the results in the user's private library, and then
removes the verified source cache after a successful conversion.

The variant count and license identifiers below match the schema-v2 manifest.

| Pack         | Variants | Source                                                                                   | Manifest license  |
| ------------ | -------: | ---------------------------------------------------------------------------------------- | ----------------- |
| Remus        |        3 | [GNOME-Look p/2355234](https://www.gnome-look.org/p/2355234)                             | CC BY-NC-ND 4.0   |
| Drop         |        4 | [GNOME-Look p/2330173](https://www.gnome-look.org/p/2330173)                             | CC BY-NC-ND 4.0   |
| Moga Classic |        3 | [GNOME-Look p/2296782](https://www.gnome-look.org/p/2296782)                             | CC BY-NC-ND 4.0   |
| Moga Candy   |        4 | [GNOME-Look p/2299255](https://www.gnome-look.org/p/2299255)                             | CC BY-NC-ND 4.0   |
| Moga Colors  |        4 | [GNOME-Look p/2297654](https://www.gnome-look.org/p/2297654)                             | CC BY-NC-ND 4.0   |
| Moga Neon    |        4 | [GNOME-Look p/2302110](https://www.gnome-look.org/p/2302110)                             | CC BY-NC-ND 4.0   |
| Moga Light   |        1 | [GNOME-Look p/2364891](https://www.gnome-look.org/p/2364891)                             | CC BY-NC-ND 4.0   |
| Volantes     |        2 | [varlesh/volantes-cursors](https://github.com/varlesh/volantes-cursors)                  | GPL-2.0-only      |
| Vimix        |        2 | [vinceliuice/Vimix-cursors](https://github.com/vinceliuice/Vimix-cursors)                | GPL-3.0-only      |
| Qogir        |        6 | [Qogir cursors](https://github.com/vinceliuice/Qogir-icon-theme/tree/master/src/cursors) | GPL-3.0-only      |
| Bibata Extra |        8 | [ful1e5/Bibata_Extra_Cursor](https://github.com/ful1e5/Bibata_Extra_Cursor)              | GPL-3.0-only      |
| Google       |        4 | [ful1e5/Google_Cursor](https://github.com/ful1e5/Google_Cursor)                          | GPL-3.0-only      |
| Simp1e       |       25 | [cursors/simp1e](https://gitlab.com/cursors/simp1e)                                      | GPL-3.0-or-later  |
| Capitaine    |        2 | [keeferrourke/capitaine-cursors](https://github.com/keeferrourke/capitaine-cursors)      | LGPL-3.0-or-later |
| Future       |        2 | [yeyushengfan258/Future-cursors](https://github.com/yeyushengfan258/Future-cursors)      | GPL-3.0-only      |
| Nordzy       |      133 | [guillaumeboehm/Nordzy-cursors](https://github.com/guillaumeboehm/Nordzy-cursors)        | GPL-3.0-only      |
| Colloid      |        2 | [Colloid cursors](https://github.com/vinceliuice/Colloid-icon-theme/tree/main/cursors)   | GPL-3.0-only      |
| Bibata       |       12 | [ful1e5/Bibata_Cursor](https://github.com/ful1e5/Bibata_Cursor)                          | GPL-3.0-only      |

The seven GNOME-Look archive ReadMe files identify MOYASH/Moyash and state CC
BY-NC-ND 4.0. That embedded notice is authoritative for this project even
where a website tag suggests a different Creative Commons variant. Exact
archive IDs, MD5/SHA-256 values, source paths, and acquisition date are in
`native/cursor-packs/sources/GNOME-LOOK-PROVENANCE.md`.

Git revisions, consumed asset roots, and license files are locked by
`native/cursor-packs/sources/pinned-sources.json` and the accompanying
provenance notes. Each generated manifest row retains its author, source URL,
license identifier/URL, stable UUID, resource digest, and upstream variant.

The GNOME-Look licenses still apply to the downloaded artwork, locally
converted resources, and representative preview images. Downloading and local
conversion do not turn CC BY-NC-ND material into open-source artwork or remove
its noncommercial/no-derivatives restrictions. Any public distribution must
review those seven packs and the bundled representative previews separately.
