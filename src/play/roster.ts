/**
 * The playable Adventurers.
 *
 * Data only — no Three.js imports — so the roster can be tested and handed to
 * the HUD without pulling in the renderer.
 *
 * All five KayKit Adventurers are built on the pack's Rig_Medium skeleton
 * (23 identically named joints), so the existing clip set, sockets, hit windows
 * and combat timings apply to every one of them unchanged.
 */

export type CharacterId = 'knight' | 'barbarian' | 'rogue' | 'mage' | 'ranger';

/** Weapon models copied from the Adventurers pack into public/rpg/weapons/. */
export type WeaponKey = 'sword' | 'shield' | 'axe' | 'barbarianShield' | 'dagger' | 'staff' | 'bow';

export type SocketKey = 'sword' | 'shield' | 'axe' | 'largeShield' | 'mainHand' | 'offHand';

export interface AdventurerWeapon {
  asset: WeaponKey;
  socket: SocketKey;
}

export interface Adventurer {
  id: CharacterId;
  name: string;
  /** One-word role line, used in the tray tooltip. */
  title: string;
  /** Fallback portrait glyph: the pack ships no character portraits. */
  mark: string;
  /** Keycap shown on the chip; matches the number key that selects it. */
  key: string;
  /** Accent colour for the selected chip. */
  accent: string;
  weapons: AdventurerWeapon[];
}

export const ADVENTURERS: readonly Adventurer[] = [
  {
    id: 'knight',
    name: 'Knight',
    title: 'Sword & board',
    mark: 'Kn',
    key: '1',
    accent: '#9fc4ff',
    weapons: [
      { asset: 'sword', socket: 'sword' },
      { asset: 'shield', socket: 'shield' },
    ],
  },
  {
    id: 'barbarian',
    name: 'Barbarian',
    title: 'Great axe',
    mark: 'Ba',
    key: '2',
    accent: '#ff9a6a',
    weapons: [
      { asset: 'axe', socket: 'mainHand' },
      { asset: 'barbarianShield', socket: 'offHand' },
    ],
  },
  {
    id: 'rogue',
    name: 'Rogue',
    title: 'Twin daggers',
    mark: 'Ro',
    key: '3',
    accent: '#7fd8b0',
    weapons: [
      { asset: 'dagger', socket: 'mainHand' },
      { asset: 'dagger', socket: 'offHand' },
    ],
  },
  {
    id: 'mage',
    name: 'Mage',
    title: 'Staff',
    mark: 'Mg',
    key: '4',
    accent: '#b59cff',
    weapons: [{ asset: 'staff', socket: 'mainHand' }],
  },
  {
    id: 'ranger',
    name: 'Ranger',
    title: 'Longbow',
    mark: 'Ra',
    key: '5',
    accent: '#ffd479',
    weapons: [{ asset: 'bow', socket: 'mainHand' }],
  },
];

export function findAdventurer(id: string): Adventurer | undefined {
  return ADVENTURERS.find((entry) => entry.id === id);
}
