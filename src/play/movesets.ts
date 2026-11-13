import type { AttackProfile } from './player';
import type { CharacterId } from './roster';

/**
 * Per-Adventurer combat data.
 *
 * Movement, collision, targeting, health, dodging and the enemy simulation stay
 * shared; only the numbers and clips below change between characters. The Player
 * controller reads this through `player.profile`, which follows the active rig.
 *
 * `hitStart`..`hitEnd` are authored clip times, measured from the keyframes of
 * `Rig_Medium_CombatMelee.glb` with the same hand-sweep analysis used for the
 * Knight in M4: sample the weapon hand, find the fastest portion of its travel,
 * and take the window above 55% of peak speed. As a calibration, that method
 * reproduces the documented Knight windows within a frame or two
 * (Slice_Diagonal 0.37..0.47 measured vs 0.39..0.46 authored).
 */

export interface GuardProfile {
  /** Looping pose while the guard is held. */
  clip: string;
  /** One-shot clip played when a guarded hit lands. */
  hitClip: string;
  /** Movement multiplier while guarding. */
  moveScale: number;
  /** Fraction of incoming damage that still gets through. */
  damageScale: number;
}

export interface CombatProfile {
  id: CharacterId;
  light: AttackProfile;
  /** Second light swing, alternating with `light` (the Rogue's slice). */
  lightAlt?: AttackProfile;
  heavy: AttackProfile;
  /** `null` means this Adventurer has no block: dodging is the only defence. */
  guard: GuardProfile | null;
  /** Hold the defence input to settle into this stance instead of guarding. */
  aim?: AimProfile;
}

export interface AimProfile {
  /** Looping stance clip. */
  clip: string;
  /** Movement multiplier while the stance is held. */
  moveScale: number;
}

export type CombatProfileId = 'knight' | 'barbarian' | 'rogue' | 'ranger';

/** Knight's shipped values. This is the regression baseline: do not retune. */
const KNIGHT_LIGHT: AttackProfile = {
  clip: 'Melee_1H_Attack_Slice_Diagonal',
  damage: 26,
  range: 2.4,
  arc: Math.PI * 0.34,
  hitStart: 0.39,
  hitEnd: 0.46,
  timeScale: 1.15,
  cooldown: 1.2,
};

const KNIGHT_HEAVY: AttackProfile = {
  clip: 'Melee_1H_Attack_Chop',
  damage: 44,
  range: 2.7,
  arc: Math.PI * 0.42,
  hitStart: 0.58,
  hitEnd: 0.65,
  timeScale: 1,
  cooldown: 1.9,
  armored: true,
};

export const PROFILES: Record<CombatProfileId, CombatProfile> = {
  knight: {
    id: 'knight',
    light: KNIGHT_LIGHT,
    heavy: KNIGHT_HEAVY,
    guard: {
      clip: 'Melee_Blocking',
      hitClip: 'Melee_Block_Hit',
      moveScale: 0.4,
      damageScale: 0.25,
    },
  },

  /**
   * Slower, wider, harder. The two-hander has no shield: "block" becomes a
   * brace that stops less and still lets a third of the hit through.
   *
   * Measured windows: Slice 0.37..0.43 (peak 0.37), Chop 0.64..0.87 (peak 0.70).
   * `recovery` replaces the authored tail with a shorter, deliberate one so the
   * swing recovers on its own terms instead of sitting in clamped pose.
   */
  barbarian: {
    id: 'barbarian',
    light: {
      clip: 'Melee_2H_Attack_Slice',
      damage: 34,
      range: 2.6,
      arc: Math.PI * 0.45,
      hitStart: 0.36,
      hitEnd: 0.44,
      timeScale: 1,
      cooldown: 1.5,
      recovery: 0.26,
    },
    heavy: {
      clip: 'Melee_2H_Attack_Chop',
      damage: 60,
      range: 2.9,
      arc: Math.PI * 0.42,
      hitStart: 0.66,
      hitEnd: 0.82,
      timeScale: 1,
      cooldown: 2.6,
      armored: true,
      recovery: 0.4,
    },
    guard: {
      clip: 'Melee_Block',
      hitClip: 'Melee_Block_Hit',
      moveScale: 0.5,
      damageScale: 0.6,
    },
  },

  /**
   * Fast, short, no guard. Alternating stab and slice keeps the silhouette
   * changing without adding a combo system; the short `recovery` is what makes
   * the pair feel quick, not a faster clip.
   *
   * Measured windows: Stab 0.37..0.40 (peak 0.37), Slice 0.54..0.63 (peak 0.54),
   * Chop 0.50..0.60 (peak 0.54).
   */
  rogue: {
    id: 'rogue',
    light: {
      clip: 'Melee_Dualwield_Attack_Stab',
      damage: 15,
      range: 2.1,
      arc: Math.PI * 0.3,
      hitStart: 0.35,
      hitEnd: 0.42,
      timeScale: 1.35,
      cooldown: 0.55,
      recovery: 0.14,
    },
    lightAlt: {
      clip: 'Melee_Dualwield_Attack_Slice',
      damage: 15,
      range: 2.1,
      arc: Math.PI * 0.34,
      hitStart: 0.53,
      hitEnd: 0.62,
      timeScale: 1.35,
      cooldown: 0.55,
      recovery: 0.14,
    },
    heavy: {
      clip: 'Melee_Dualwield_Attack_Chop',
      damage: 28,
      range: 2.2,
      arc: Math.PI * 0.34,
      hitStart: 0.5,
      hitEnd: 0.6,
      timeScale: 1.1,
      cooldown: 1.8,
      recovery: 0.3,
    },
    guard: null,
  },

  /**
   * Bow only. Both shots use `Ranged_Bow_Release`, the pack's two-handed bow
   * release: it starts already drawn, the string hand reverses direction at
   * 0.28 s (authored) and sweeps forward — that reversal is the loose, and both
   * profiles fire the arrow there.
   *
   * The `Ranged_1H_*` and `Ranged_2H_*` shooting clips are deliberately unused:
   * they bake a constant 15°/25° yaw into the root bone, which would turn the
   * body away from the aim direction.
   */
  ranger: {
    id: 'ranger',
    light: {
      clip: 'Ranged_Bow_Release',
      damage: 18,
      range: 40,
      arc: 0,
      hitStart: 0.28,
      hitEnd: 0.28,
      timeScale: 1.45,
      cooldown: 0.62,
      recovery: 0.16,
      ranged: { speed: 34, maxRange: 40 },
    },
    heavy: {
      clip: 'Ranged_Bow_Release',
      damage: 34,
      range: 55,
      arc: 0,
      hitStart: 0.28,
      hitEnd: 0.28,
      timeScale: 0.85,
      cooldown: 1.5,
      recovery: 0.26,
      ranged: { speed: 46, maxRange: 55 },
    },
    guard: null,
    aim: { clip: 'Ranged_Bow_Aiming_Idle', moveScale: 0.45 },
  },
};

/**
 * M7.1/M7.2 only define the melee identities and the Ranger's bow. The Mage
 * keeps the Knight's baseline until its own milestone, so switching stays
 * functional and behaviour is unchanged.
 */
export function profileFor(id: CharacterId): CombatProfile {
  return (PROFILES as Record<string, CombatProfile | undefined>)[id] ?? PROFILES.knight;
}
