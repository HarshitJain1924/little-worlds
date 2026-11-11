# Credits & asset licences

All 3D assets in this project are **CC0 1.0 (public domain dedication)**: free for
personal, educational and commercial use, with no attribution required. Kenney is
credited here because the work deserves it, not because the licence demands it.

Original licence files are kept verbatim in [`licenses/`](licenses/).

## Nature Kit (2.1) — Kenney

- Source: https://kenney.nl/assets/nature-kit
- Download: https://kenney.nl/assets/nature-kit (retrieved November 2026)
- Licence: Creative Commons Zero (CC0 1.0)
- Licence file: [`licenses/nature-kit-2.1-CC0.txt`](licenses/nature-kit-2.1-CC0.txt)
- Local source pack (not committed): `kenney_nature-kit/Models/GLTF format/`

Models shipped in `public/models/nature/`:

```
tree_oak                  tree_pineTallA_detailed  tree_pineRoundA
tree_palm                 tree_simple              tree_small
tree_thin                 grass                    grass_large
plant_bush                plant_bushLarge          plant_flatShort
flower_redA               flower_purpleA           flower_yellowA
mushroom_red              mushroom_tan             rock_largeA
rock_tallA                rock_smallFlatA          stone_largeA
log                       stump_round              lily_large
campfire_stones           tent_smallOpen           path_stone
sign                      canoe
```

## Fantasy Town Kit (2.0) — Kenney

- Source: https://kenney.nl/assets/fantasy-town-kit
- Download: https://kenney.nl/assets/fantasy-town-kit (retrieved November 2026)
- Licence: Creative Commons Zero (CC0 1.0)
- Licence file: [`licenses/fantasy-town-kit-2.0-CC0.txt`](licenses/fantasy-town-kit-2.0-CC0.txt)
- Local source pack (not committed): `kenney_fantasy-town-kit_2.0/Models/GLB format/`

Models shipped in `public/models/town/`:

```
wall-block   wall-door   wall-window-small   roof-gable
roof-gable-end   roof-gable-top   chimney   planks   lantern
```

These models reference a shared texture atlas by relative path
(`Textures/colormap.png`). It is shipped at `public/models/town/Textures/colormap.png`
and must keep that exact path, or the cottage loses its texture.

## Not used

The main Fantasy Town preview shows a **red/teal roof variant**; the shipped atlas
is the default palette. `Models/Textures/variation-a.png` in the source pack is an
alternative palette that can be swapped in later without touching any model.

## Fonts / audio

None. The HUD uses the system UI font stack; there is no audio yet.
