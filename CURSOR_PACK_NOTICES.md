# Cursor pack provenance

The personal local bundle contains 239 cursor variants: 19 Oreo resources and
220 conversions from the requested external sources. Repositories and
GNOME-Look archives are pinned build inputs in an ignored acquisition cache;
they are not copied into Electron and are never downloaded at runtime.

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
| Future       |        1 | [yeyushengfan258/Future-cursors](https://github.com/yeyushengfan258/Future-cursors)      | GPL-3.0-only      |
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

This milestone is for personal use. A future distributable build would need a
separate redistribution review—particularly for converted CC BY-NC-ND
artwork—and a complete, license-appropriate source/notice bundle. That work is
deliberately deferred and does not block local use.
