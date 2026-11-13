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
  /** Heavy attack is charged by holding the heavy input, then released. */
  charge?: ChargeProfile;
  /** Signature Adventurer ability activated with E / touch button. */
  ability?: AbilityProfile;
}

/**
 * Discriminated union for signature adventurer abilities.
 * In M7.5.1, we define CounterAbilityProfile for the Knight.
 * In M7.5.2, we add WhirlwindAbilityProfile for the Barbarian.
 */
export interface CounterAbilityProfile {
  kind: 'counter';
  id: string;
  name: string;
  description: string;
  cooldown: number;
  clip: string;
  duration: number;
  timeScale: number;
  /**
   * Hyper-armour: when true, incoming hits during the active strike phase (0.35..0.55s)
   * do not interrupt or cancel the riposte. Recovery (0.55..1.067s) remains vulnerable
   * and interruptible by hits.
   */
  armored?: boolean;
  /** Window during which incoming damage triggers a counter (authored clip seconds). */
  counterStart: number;
  counterEnd: number;
  /** Authored clip time when the counter riposte strike lands. */
  riposteHit: number;
  /** Riposte attack properties */
  damage: number;
  range: number;
  arc: number;
}

export interface WhirlwindAbilityProfile {
  kind: 'whirlwind';
  id: string;
  name: string;
  description: string;
  cooldown: number;
  clip: string;
  duration: number;
  timeScale: number;
  armored?: boolean;
  hitStart: number;
  hitEnd: number;
  damage: number;
  radius: number;
  maxVerticalOffset?: number;
  moveScale?: number;
}

export type AbilityProfile = CounterAbilityProfile | WhirlwindAbilityProfile;

export interface AimProfile {
  /** Looping stance clip. */
  clip: string;
  /** Movement multiplier while the stance is held. */
  moveScale: number;
}

/**
 * Held-charge configuration for a heavy attack.
 *
 * A partial charge is still a shot: releasing early fires at `minDamage`. Only
 * an interruption (dodge, hit, switch, death) cancels without firing.
 */
export interface ChargeProfile {
  /** Charge held before any bonus accrues. */
  minTime: number;
  /** Charge at which the shot is at full power. */
  maxTime: number;
  minDamage: number;
  maxDamage: number;
  minSpeed: number;
  maxSpeed: number;
  /** Clip played once while drawing from the hip (not when already aiming). */
  drawClip: string;
  /** Authored timestamp to hold when charge is held past this duration. */
  clampTime?: number;
}

/**
 * Authored timings inside `Ranged_Bow_Release`, measured from the string hand's
 * keyframes: it reverses direction at 0.28 s (the loose) and finishes its
 * forward sweep at 0.65 s. Recovery is set from the sweep, not guessed.
 */
export const BOW_LOOSE = 0.28;
export const BOW_RELEASE_SWEEP = 0.65;

/**
 * Authored timings inside `Ranged_Magic_Shoot`, measured from the staff's
 * keyframes: the forward thrust snaps and completes its release at 0.28 s
 * (the cast release) and finishes its forward sweep at 0.60 s.
 */
export const MAGE_CAST_RELEASE = 0.28;
export const MAGE_CAST_SWEEP = 0.60;

/**
 * Seconds an attack must stay active for the release sweep to finish.
 * The follow-through is the whole point of the clip, so no bow profile may end
 * before the string hand has completed its travel.
 */
export function releaseDuration(attack: { timeScale: number }): number {
  return BOW_RELEASE_SWEEP / attack.timeScale + 0.02;
}

export type CombatProfileId = 'knight' | 'barbarian' | 'rogue' | 'ranger' | 'mage';

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
  tag: 'light',
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
  tag: 'heavy',
};

/**
 * Authored timings inside `Melee_Block_Attack`, measured from the shield's
 * keyframes: the left arm braces tight (0.00..0.35s), violently accelerates forward
 * (peak velocity 5.62 m/s at 0.367s) reaching peak extension at 0.467s (the riposte strike),
 * with recovery spanning the remainder of the 1.067s clip.
 */
export const KNIGHT_COUNTER_WINDOW_START = 0.0;
export const KNIGHT_COUNTER_WINDOW_END = 0.35;
export const KNIGHT_RIPOSTE_HIT = 0.47;
export const KNIGHT_BLOCK_ATTACK_DURATION = 1.067;

export const KNIGHT_ABILITY: CounterAbilityProfile = {
  kind: 'counter',
  id: 'shield_counter',
  name: 'Shield Counter',
  description: 'Brace behind the shield to negate incoming attacks and deliver a devastating riposte.',
  cooldown: 6.0,
  clip: 'Melee_Block_Attack',
  duration: KNIGHT_BLOCK_ATTACK_DURATION,
  timeScale: 1.0,
  armored: true,
  counterStart: KNIGHT_COUNTER_WINDOW_START,
  counterEnd: KNIGHT_COUNTER_WINDOW_END,
  riposteHit: KNIGHT_RIPOSTE_HIT,
  damage: 48,
  range: 2.6,
  arc: Math.PI * 0.4,
};

/**
 * Authored timings inside `Melee_2H_Attack_Spinning` (duration 0.667s / 20 frames @ 30fps).
 * Root rotation begins rapid 360-degree sweep at 0.10s, completes full rotation by 0.54s,
 * with the remaining 0.54..0.667s serving as post-spin recovery.
 */
export const BARBARIAN_WHIRLWIND_HIT_START = 0.10;
export const BARBARIAN_WHIRLWIND_HIT_END = 0.54;
export const BARBARIAN_WHIRLWIND_DURATION = 0.667;

export const BARBARIAN_ABILITY: WhirlwindAbilityProfile = {
  kind: 'whirlwind',
  id: 'whirlwind',
  name: 'Whirlwind',
  description: 'Unleash a devastating 360-degree spin that cleaves all nearby foes.',
  cooldown: 8.0,
  clip: 'Melee_2H_Attack_Spinning',
  duration: BARBARIAN_WHIRLWIND_DURATION,
  timeScale: 1.0,
  armored: true,
  hitStart: BARBARIAN_WHIRLWIND_HIT_START,
  hitEnd: BARBARIAN_WHIRLWIND_HIT_END,
  damage: 55,
  radius: 2.8,
  maxVerticalOffset: 1.5,
  moveScale: 0.35,
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
    ability: KNIGHT_ABILITY,
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
      tag: 'light',
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
      tag: 'heavy',
    },
    guard: {
      clip: 'Melee_Block',
      hitClip: 'Melee_Block_Hit',
      moveScale: 0.5,
      damageScale: 0.6,
    },
    ability: BARBARIAN_ABILITY,
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
      tag: 'light',
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
      tag: 'light',
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
      tag: 'heavy',
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
      hitStart: BOW_LOOSE,
      hitEnd: BOW_LOOSE,
      timeScale: 1.45,
      cooldown: 0.62,
      // 0.65 s of authored sweep at 1.45x is 0.448 s; the loose lands at 0.193,
      // so the follow-through needs 0.275. Rounded up, never down.
      recovery: 0.28,
      ranged: { speed: 34, maxRange: 40 },
      tag: 'light',
    },
    heavy: {
      clip: 'Ranged_Bow_Release',
      /** Full-charge damage and speed; the charge profile interpolates up to it. */
      damage: 46,
      range: 55,
      arc: 0,
      hitStart: BOW_LOOSE,
      hitEnd: BOW_LOOSE,
      timeScale: 0.9,
      cooldown: 1.15,
      // Sweep ends at 0.722 s at 0.9x; release at 0.311 leaves 0.411 + slack.
      recovery: 0.42,
      ranged: { speed: 58, maxRange: 55 },
      tag: 'heavy',
    },
    guard: null,
    aim: { clip: 'Ranged_Bow_Aiming_Idle', moveScale: 0.45 },
    charge: {
      minTime: 0.25,
      maxTime: 1.0,
      minDamage: 26,
      maxDamage: 46,
      minSpeed: 40,
      maxSpeed: 58,
      drawClip: 'Ranged_Bow_Draw',
    },
  },

  /**
   * Mage combat identity: ranged spellcaster with responsive magic bolts and
   * charged heavy spells. The staff's cast release was measured at 0.28 s
   * from the forward thrust keyframes of Ranged_Magic_Shoot.
   */
  mage: {
    id: 'mage',
    light: {
      clip: 'Ranged_Magic_Shoot',
      damage: 16,
      range: 38,
      arc: 0,
      hitStart: MAGE_CAST_RELEASE,
      hitEnd: MAGE_CAST_RELEASE,
      timeScale: 1.35,
      cooldown: 0.58,
      recovery: 0.24,
      ranged: { speed: 32, maxRange: 38 },
      tag: 'light',
    },
    heavy: {
      clip: 'Ranged_Magic_Shoot',
      damage: 48,
      range: 48,
      arc: 0,
      hitStart: MAGE_CAST_RELEASE,
      hitEnd: MAGE_CAST_RELEASE,
      timeScale: 0.95,
      cooldown: 1.15,
      recovery: 0.36,
      armored: true,
      ranged: { speed: 44, maxRange: 48 },
      tag: 'heavy',
    },
    guard: null,
    aim: { clip: 'Ranged_Magic_Spellcasting', moveScale: 0.45 },
    charge: {
      minTime: 0.25,
      maxTime: 1.0,
      minDamage: 24,
      maxDamage: 48,
      minSpeed: 28,
      maxSpeed: 44,
      drawClip: 'Ranged_Magic_Raise',
      clampTime: 0.95,
    },
  },
};

/**
 * Returns the combat profile for the active Adventurer.
 */
export function profileFor(id: CharacterId): CombatProfile {
  return (PROFILES as Record<string, CombatProfile | undefined>)[id] ?? PROFILES.knight;
}
