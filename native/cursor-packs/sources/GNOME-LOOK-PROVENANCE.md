# GNOME-look source provenance

This directory contains the source archives fetched for the seven GNOME-look
pages requested for Cursor Atelier.  The OCS JSON responses are kept beside
the archives in each pack directory (`ocs.json`); they preserve the original
download URLs, names, page version, and publisher-provided MD5 values.  The
archives are expanded under an `expanded/<archive-name-without-.zip>/` root so
converters have a stable, normalized input path without changing anything in
the original archive.

Fetch date: 2026-08-05 (America/Chicago).  Metadata endpoint used for each
page: `https://api.opendesktop.org/ocs/v1/content/data/<product-id>?format=json`.

## Attribution and licensing

The embedded `ReadMe.txt` in every Linux archive identifies the creator as
**MOYASH / Moyash** and states **CC BY-NC-ND**.  The same notices are preserved
verbatim in each expanded source tree.  The OCS tags include `cc-by-sa` on
these pages, but the OCS `license` field is empty; the embedded archive notice
is therefore the license recorded here for redistribution review.  The
conversion step must retain this attribution and license notice with every
generated macOS cursor bundle.  Because CC BY-NC-ND restricts derivatives,
conversion/redistribution should be reviewed before release or cleared with
the creator; this manifest intentionally does not reinterpret that license.

Windows-only companion archives are retained for provenance but are not
macOS/Xcursor inputs (`*-Windows-Free.zip`).

## Pinned archives

All paths below are relative to this file.  `file id` is the Pling file id
decoded from the OCS download URL; `md5` is the publisher's OCS value and
`sha256` is computed from the downloaded archive.  Per-pack `SHA256SUMS`
files can be checked with `shasum -a 256 -c SHA256SUMS` from that pack folder.

### Remus Cursor (product 2355234)

Source page: <https://www.gnome-look.org/p/2355234>  
Author: Moyash  
Version: 1.1  
Source root: `remus/expanded/<archive-name>/Remus-*`

| Archive | file id | md5 | sha256 |
| --- | ---: | --- | --- |
| `remus/archives/Remus-Black.zip` | 1777367426 | `c64a1ba23d568dee56e1353d1fa967a4` | `425e1aa9530c65cadb1b6b319b2b08ca3458c12dbd3484784f78f9f14c5dd225` |
| `remus/archives/Remus-Dark.zip` | 1777443043 | `5804dbd817924ae14de1bf8af43f6db1` | `d939e3642cda0cb3f51da08c2ba378754d532eb46d631386a94c4dd8769a51e7` |
| `remus/archives/Remus-White-Windows-Free.zip` | 1775847670 | `98d2f276a91c9c7ba2a638a6aabfcbca` | `43e2aa9c1451fa95bca8247b468ff0cbaad13ad79d08d5a9766a811f639c2e67` |
| `remus/archives/Remus-White.zip` | 1777367406 | `eb31d6ade24f5e5f07605c5f6e3e06a0` | `9d615720e41148e1d1f12ba8a1ae0811b7544d4b874385ddde91fd5439baedf7` |

### Drop Cursors (product 2330173)

Source page: <https://www.gnome-look.org/p/2330173>  
Author: Moyash  
Version: 1.0 (New)  
Source root: `drop/expanded/<archive-name>/Drop-*`

| Archive | file id | md5 | sha256 |
| --- | ---: | --- | --- |
| `drop/archives/Drop-Alien.zip` | 1764824196 | `9e571cadf1fc81cc5eca778a3148dec3` | `983f230067062d36c842fc64bd5cf8689a19cb6f63ab9e22652ca9e23a6a8655` |
| `drop/archives/Drop-Blood.zip` | 1763875515 | `c6373e1b89edea3245f09c59303194cd` | `13c00a1ecf7b11f34c838d9f6df9d79ec5806cd99ca20ac7100ee421f1bd0dfb` |
| `drop/archives/Drop-Blue.zip` | 1767557189 | `75310a6515516025fc740a1a899e17a5` | `3d1937c1c2e71777c814f8862cbbea31cddd003b11c60b195dcec1a46ffe3cb4` |
| `drop/archives/Drop-BlueLayan.zip` | 1776266035 | `56780b9a87a63c5a63bfc555a0d74936` | `9e0eddc936ed5c0c9524d166d9ee5824f0b5cbbddae74745729af58d5a64c805` |

### Moga Classic / Moga Cursor (product 2296782)

Source page: <https://www.gnome-look.org/p/2296782>  
Author: Moyash  
Version: 1.3  
Source root: `moga-classic/expanded/<archive-name>/Moga-*`

| Archive | file id | md5 | sha256 |
| --- | ---: | --- | --- |
| `moga-classic/archives/Moga-Black.zip` | 1782628503 | `1e71e8378505bfd588cad1debe2a159e` | `f7d3602759eccb223dd9fdc0c6d9d8e3ee2657851732c0c3d227dde4919d7d7f` |
| `moga-classic/archives/Moga-Dark.zip` | 1783053670 | `28a95433b7d0e3aeff63359759226802` | `53ef5a707f63e4efbb818907999717792b63bdaa5596a1e85e36019ecf82ff7f` |
| `moga-classic/archives/Moga-White.zip` | 1782804741 | `751da320d40e306f039b4cb1e6ea678d` | `f7f7075dfeea6ef2e18b19a9b4bdfeff6587c7b9865c0d44ec481181ebfdb0b2` |
| `moga-classic/archives/Moga-Windows-Free.zip` | 1775848309 | `5eb11fab434e4f009057b72af1d7a128` | `169a76d63dbfeb525cbffa2a155f0aad74f18980e882f2fa2813df4b7bc9a007` |

### Moga Candy (product 2299255)

Source page: <https://www.gnome-look.org/p/2299255>  
Author: Moyash  
Version: 1.0 (New)  
Source root: `moga-candy/expanded/<archive-name>/Moga-Candy-*`

| Archive | file id | md5 | sha256 |
| --- | ---: | --- | --- |
| `moga-candy/archives/Moga-Candy-Blue.zip` | 1752085272 | `65258d2acce53d83e32cb7a7f89afc9d` | `b1572a542bb1a865c0f074457f534bb100c56e8c23ceeef2e22f8cddad90fd4d` |
| `moga-candy/archives/Moga-Candy-Caramel.zip` | 1752085496 | `eef256fdb44ac6cf91091ef0157b4d08` | `2d934a63a28c487f3d94942e898a8ea17a4b980ec3ac84f77b9c3cbf1187e2cd` |
| `moga-candy/archives/Moga-Candy-Green.zip` | 1753073457 | `d8d19f7e5acfb46e8ab45b4bd32cf7b3` | `a3b989f1f5c833e44a18e741786dd3ba89f8e214053207fe033bbb80ad198a40` |
| `moga-candy/archives/Moga-Candy-Grey.zip` | 1753765231 | `5f3ea716fdc9052616fcf60e41d03ed2` | `f0a4896ba78c11a469240615fc115bc943b10923fcc549839fb9aab40a2fc691` |

### Moga Colors / Moga Colored (product 2297654)

Source page: <https://www.gnome-look.org/p/2297654>  
Author: Moyash  
Version: 1.1 (New)  
Source root: `moga-colors/expanded/<archive-name>/Moga-*`

| Archive | file id | md5 | sha256 |
| --- | ---: | --- | --- |
| `moga-colors/archives/Moga-Blue.zip` | 1750863096 | `a3ceddec35c7885fd6b510253c955dbd` | `8105924dfbb67c1a2ad050be0299c61a4c05c0cf6d3022f959a367e1ac167eca` |
| `moga-colors/archives/Moga-Cyan.zip` | 1751911034 | `e3944109cc1099a1f2822f68493c35ce` | `fe06db7762dcb8c75edccd6f211460a936d56ea86d2e66ff005c74da45bdaf31` |
| `moga-colors/archives/Moga-Green.zip` | 1752828771 | `1eaef4af3eb46f9924f5de209873eb32` | `462610a5f77b11092a68e0575e0acfbf53defafa399b587b1ab2338f80d442c4` |
| `moga-colors/archives/Moga-Grey.zip` | 1752350482 | `3a77bfe9f9fc7e5917a1225a1e1bc701` | `164d2517d0b68ef009324d7d00e5947a8e6b4c1e69f3a51b6e29acdb6ab5565d` |

### Moga Neon (product 2302110)

Source page: <https://www.gnome-look.org/p/2302110>  
Author: Moyash  
Version: 1.0 (New)  
Source root: `moga-neon/expanded/<archive-name>/Moga-Neon-*`

| Archive | file id | md5 | sha256 |
| --- | ---: | --- | --- |
| `moga-neon/archives/Moga-Neon-Blue.zip` | 1754641872 | `8766adc21ea596de52da767e7a9eca71` | `f575712629e1e4af0282d2b0a40b72ed9f5d338d4cf0c635783a2d0aa9c6994f` |
| `moga-neon/archives/Moga-Neon-Butter.zip` | 1755252863 | `9b8d64d35c92218654b81f025c9c307b` | `abd2882fbd0aac3e91186a6f668a2dffe2460a0bc5626ef596225834c27a2fb0` |
| `moga-neon/archives/Moga-Neon-Cyan.zip` | 1757735977 | `ae18d8f4e529a1983b7a35b38a339b8b` | `7c63c6abb6e7245844d1785c992711fbb9f48ddcb0cfc1722fcf2f551ffeeedf` |
| `moga-neon/archives/Moga-Neon-Green.zip` | 1759873756 | `25e9a0f4df1f2bd4b749d687c2810c63` | `326a2810f5d711c57eb0ef1a4362a88ebfcba43ca6840f3cf2f0ef1d524e84ba` |

### Moga Light (product 2364891)

Source page: <https://www.gnome-look.org/p/2364891>  
Author: Moyash  
Version: 1.3  
Source root: `moga-light/expanded/<archive-name>/Moga-Light-*`

| Archive | file id | md5 | sha256 |
| --- | ---: | --- | --- |
| `moga-light/archives/Moga-Light-Blue.zip` | 1783428436 | `e6aa743f73218279ca99d554141d49e8` | `89e6648424adbe5834557586ae052c637ee7c5784ea399e3db410b9e2f45f607` |

## Conversion input notes

The Linux/Xcursor themes are under each expanded archive's second-level
directory, for example:

```text
remus/expanded/Remus-Black/Remus-Black/
drop/expanded/Drop-Blue/Drop-Blue/
moga-light/expanded/Moga-Light-Blue/Moga-Light-Blue/
```

Each Linux root contains `index.theme` and a `cursors/` directory.  Keep the
source archive and its `ReadMe.txt` with any generated macOS bundle so the
license and attribution remain auditable.
