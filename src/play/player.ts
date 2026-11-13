import * as THREE from 'three';
import type { CharacterRig } from './character';
import type { DodgeMotion } from './models';
import { DODGE_MOTION, findBone } from './models';
import type { ThirdPersonCamera } from './camera';
import type { InputController } from './input';
import { hasLineOfSight, resolveBlockers } from './collision';
import type { World } from './world';
import { ARENA } from './world';
import type { AbilityProfile, CounterAbilityProfile, WhirlwindAbilityProfile, ChargeProfile, CombatProfile } from './movesets';
import { profileFor } from './movesets';
import type { CharacterId } from './roster';

export type AbilityPhase = 'idle' | 'startup' | 'active' | 'recovery';

/**
 * Attack definitions. `hitStart`..`hitEnd` are the authored clip times (measured
 * from the keyframes in Rig_Medium_CombatMelee.glb) during which the weapon is
 * sweeping through the target zone, so damage never lands during windup.
 *
 * The values for each Adventurer live in `movesets.ts`; this is only the shape.
 */
export interface AttackProfile {
  clip: string;
  damage: number;
  range: number;
  /** Half-angle of the damage cone. */
  arc: number;
  /** Authored clip time (seconds) when the active weapon sweep begins. */
  hitStart: number;
  /** Authored clip time (seconds) when the active weapon sweep ends. */
  hitEnd: number;
  timeScale: number;
  cooldown: number;
  /** Heavy swings trade hits instead of being cancelled by incoming damage. */
  armored?: boolean;
  /**
   * Seconds after `hitEnd` before the swing releases the character. Omitted on
   * profiles that should play their authored tail (the Knight), so a shorter
   * value here is a deliberate cut, not a side effect.
   */
  recovery?: number;
  /**
   * Present on bow profiles: this attack launches a projectile instead of
   * sweeping a melee cone, and fires once at `hitStart`.
   */
  ranged?: {
    /** Metres per second. */
    speed: number;
    /** Maximum flight distance. */
    maxRange: number;
  };
  /**
   * Input slot this attack came from. A charged shot is derived from the heavy
   * profile at release, so callers cannot compare by object identity.
   */
  tag?: 'light' | 'heavy';
}

const DODGE = {
  /** Playback speed of the authored step. */
  timeScale: 1.25,
  /** Constant dash added on top of the clip's own footwork. */
  speed: 4.6,
  /** Multiplier on the clip's authored root travel. */
  reach: 1.6,
  /** Ready again just after the move ends, so chained dodges feel responsive. */
  cooldown: 0.42,
  invulnerable: 0.28,
  /** Fallback length when the pack has no dodge clip. */
  duration: 0.4,
} as const;

const WALK_SPEED = 2.5;
const RUN_SPEED = 6.2;
const GRAVITY = -26;
const JUMP_SPEED = 8.6;
const BODY_RADIUS = 0.42;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Piecewise-linear sample of an authored root-motion curve. */
function sampleMotion(values: number[], times: number[], time: number): number {
  if (time <= times[0]) return values[0];

  const last = times.length - 1;
  if (time >= times[last]) return values[last];

  for (let i = 1; i <= last; i += 1) {
    if (time <= times[i]) {
      const span = times[i] - times[i - 1] || 1;
      const k = (time - times[i - 1]) / span;
      return values[i - 1] + (values[i] - values[i - 1]) * k;
    }
  }

  return values[last];
}

export class Player {
  /** Replaced by `replaceRig` when the player switches Adventurer. */
  rig: CharacterRig;
  /** Moveset of the active Adventurer; swapped together with the rig. */
  profile: CombatProfile;
  readonly position = new THREE.Vector3();
  readonly maxHealth = 100;

  health = 100;
  yaw = Math.PI;
  alive = true;

  /** Fired the moment a swing starts, before any damage can land. */
  onAttackStart: ((attack: AttackProfile) => void) | null = null;
  /** Fired the moment a dodge begins. */
  onDodgeStart: (() => void) | null = null;
  /** Fired when the character touches the ground after a real jump. */
  onLand: (() => void) | null = null;

  /** Fired during the active swing window; hitTargets prevents multi-hitting one enemy. */
  onAttackHit:
    | ((position: THREE.Vector3, forward: THREE.Vector3, attack: AttackProfile, hitTargets: Set<object>) => void)
    | null = null;

  /**
   * Fired once, at the measured release frame of a ranged attack. Aiming lives
   * outside the controller, so whoever owns the camera decides where it goes.
   */
  onRangedShot: ((attack: AttackProfile) => void) | null = null;

  /** Fired the moment an ability begins execution. */
  onAbilityStart: ((ability: AbilityProfile) => void) | null = null;
  /** Fired when an incoming attack is successfully negated during the counter window. */
  onCounterSuccess: ((attacker: unknown, from: THREE.Vector3) => void) | null = null;
  /** Fired when an ability delivers its hit or effect. */
  onAbilityHit: ((target: unknown | null, ability: AbilityProfile) => void) | null = null;
  /** Fallback resolver to find a target in range if the countered attacker is dead or missing. */
  findFallbackTarget: (() => unknown | null) | null = null;
  /**
   * Optional target provider for area-of-effect abilities (e.g. Whirlwind).
   * Returns candidate targets in the encounter for range, line-of-sight and height filtering.
   */
  findAreaTargets: (() => unknown[]) | null = null;
  /**
   * Optional custom radial sweep handler for area-of-effect abilities.
   * If provided, executeWhirlwindSweep delegates to this rather than using findAreaTargets.
   */
  onAbilityRadialSweep:
    | ((
        position: THREE.Vector3,
        radius: number,
        maxVerticalOffset: number,
        ability: WhirlwindAbilityProfile,
        hitTargets: Set<object>,
      ) => void)
    | null = null;

  /** Cooldowns persist per character across swaps. */
  readonly abilityCooldowns: Record<CharacterId, number> = {
    knight: 0,
    barbarian: 0,
    rogue: 0,
    ranger: 0,
    mage: 0,
  };

  /** Exposed so the camera can recenter behind the direction of travel. */
  readonly velocity = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly hitTargets = new Set<object>();

  private grounded = true;
  private verticalSpeed = 0;
  private airTime = 0;
  private speed = 0;
  private attack: AttackProfile | null = null;
  private attackTime = 0;
  private cooldown = 0;
  private lockTimer = 0;
  private blocking = false;
  private aiming = false;
  /** A ranged attack only ever fires one arrow. */
  private shotFired = false;
  private abilityProfile: AbilityProfile | null = null;
  private abilityPhase: AbilityPhase = 'idle';
  private abilityTime = 0;
  private counterTriggered = false;
  private counterAttacker: unknown | null = null;
  private readonly counterAttackerPos = new THREE.Vector3();
  private abilityHitApplied = false;
  private readonly abilityHitTargets = new Set<object>();
  private abilityBuffer = 0;
  private dodging = false;
  private dodgeTime = 0;
  private dodgeDuration: number = DODGE.duration;
  private dodgeCooldown = 0;
  private dodgeBuffer = 0;
  private attackBuffer = 0;
  private queuedAttack: AttackProfile | null = null;
  /** Alternates the Rogue's stab and slice; unused by single-clip profiles. */
  private lightFlip = false;
  /** Heavy input is being held to charge a shot. */
  private charging = false;
  private chargeTime = 0;
  /** Reused so a charged shot does not build a new profile object per release. */
  private chargeAttack: AttackProfile | null = null;
  private dodgeClip: string | null = null;
  private dodgeMotion: DodgeMotion | null = null;
  private invulnerable = 0;
  private lockTarget: { x: number; z: number } | null = null;
  private handSlot: THREE.Object3D | null | undefined;

  /** Assigned explicitly rather than as a parameter property, so the node test
   * harness can drive the controller with a stub world and rig. */
  private readonly world: World;

  constructor(
    rig: CharacterRig,
    world: World,
    spawn: { x: number; z: number } = ARENA.spawn,
    profile: CombatProfile = profileFor('knight'),
  ) {
    this.rig = rig;
    this.profile = profile;
    this.world = world;
    this.position.set(spawn.x, world.heightAt(spawn.x, spawn.z), spawn.z);
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
  }

  get isAttacking(): boolean {
    return this.attack !== null;
  }

  get isBlocking(): boolean {
    return this.blocking;
  }

  /** True while the aim stance is held (Ranger: the defence input draws the bow). */
  get isAiming(): boolean {
    return this.aiming;
  }

  /** True between pressing and releasing the heavy input, on a charge profile. */
  get isCharging(): boolean {
    return this.charging;
  }

  /** 0..1 of the authored charge window, for the HUD. */
  get chargeProgress(): number {
    const charge = this.profile.charge;
    if (!charge || !this.charging) return 0;
    return clamp(this.chargeTime / charge.maxTime, 0, 1);
  }

  /** 0..1 of the *bonus* window: 0 until `minTime`, 1 at `maxTime`. */
  get chargePower(): number {
    const charge = this.profile.charge;
    if (!charge) return 0;
    const span = Math.max(0.0001, charge.maxTime - charge.minTime);
    return clamp((this.chargeTime - charge.minTime) / span, 0, 1);
  }

  get isDodging(): boolean {
    return this.dodging;
  }

  /** Clip currently driving the dodge, if any. */
  get dodgingWith(): string | null {
    return this.dodgeClip;
  }

  get isLockedOn(): boolean {
    return this.lockTarget !== null;
  }

  get isAbilityActive(): boolean {
    return this.abilityPhase !== 'idle';
  }

  get activeAbilityPhase(): AbilityPhase {
    return this.abilityPhase;
  }

  get currentAbility(): AbilityProfile | null {
    return this.abilityProfile ?? this.profile.ability ?? null;
  }

  get currentAbilityCooldown(): number {
    return this.abilityCooldowns[this.profile.id] ?? 0;
  }

  get isCounterWindowActive(): boolean {
    if (!this.isAbilityActive || !this.abilityProfile || this.abilityProfile.kind !== 'counter') {
      return false;
    }
    const clipTime = this.abilityTime * this.abilityProfile.timeScale;
    return clipTime >= this.abilityProfile.counterStart && clipTime <= this.abilityProfile.counterEnd;
  }

  get isCounterTriggered(): boolean {
    return this.counterTriggered;
  }

  get abilityTargetsHit(): ReadonlySet<object> {
    return this.abilityHitTargets;
  }

  /**
   * Hard-lock facing. Movement stays camera-relative, so holding A/D strafes
   * around the target while the character keeps facing it.
   */
  setLockTarget(target: { x: number; z: number } | null): void {
    this.lockTarget = target;
  }

  /** Name of the clip currently driving the attack, if any. */
  get attackingWith(): string | null {
    return this.attack?.clip ?? null;
  }

  /** Facing direction on the ground plane. */
  facing(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /**
   * True when swapping the visual rig cannot corrupt animation or combat state:
   * alive, standing, and not mid-swing, mid-dodge, mid-ability or mid-recoil.
   */
  get canSwitchCharacter(): boolean {
    return (
      this.alive &&
      this.grounded &&
      !this.isAttacking &&
      !this.isAbilityActive &&
      !this.dodging &&
      this.lockTimer <= 0.05
    );
  }

  /**
   * Swap the visual rig without touching simulation state. Position, health,
   * yaw, velocity, cooldowns, i-frames and the guard all live on the
   * controller, so the encounter continues through the change.
   */
  replaceRig(rig: CharacterRig, profile: CombatProfile): void {
    this.rig = rig;
    this.profile = profile;
    // The new skeleton has its own handslot bone; drop the cached one.
    this.handSlot = undefined;
    // Nothing from the previous moveset may survive the swap: a stale attack,
    // buffered press, alternation or guard would apply Knight timings to a
    // Barbarian swing (or leave a Rogue guarding with no guard).
    this.attack = null;
    this.attackTime = 0;
    this.shotFired = false;
    this.hitTargets.clear();
    this.queuedAttack = null;
    this.attackBuffer = 0;
    this.lightFlip = false;
    this.blocking = false;
    this.aiming = false;
    // Charge state belongs to the previous moveset; never carry it across.
    this.charging = false;
    this.chargeTime = 0;
    this.chargeAttack = null;
    // Active ability execution and buffered inputs are dropped, but cooldowns persist in this.abilityCooldowns.
    this.interruptAbility();
    this.abilityBuffer = 0;
    rig.root.position.copy(this.position);
    rig.root.rotation.y = this.yaw;
    // Pose the new model in the state the simulation is already in.
    this.updateLocomotion();
  }

  /**
   * World position of the weapon hand, sampled after the skeleton has been
   * posed. Used by the slash flipbook so the arc travels with the blade instead
   * of sitting at a fixed offset.
   */
  weaponHand(out: THREE.Vector3): void {
    if (this.handSlot === undefined) {
      this.handSlot = findBone(this.rig.root, 'handslot.r') ?? null;
    }

    if (this.handSlot) this.handSlot.getWorldPosition(out);
    else out.copy(this.position).setY(this.position.y + 1.1);
  }

  /**
   * World position of the staff's casting point (the crystal tip).
   * Returns false if no staff is equipped, falling back to the weapon hand.
   */
  staffCastingPoint(out: THREE.Vector3): boolean {
    if (this.handSlot === undefined) {
      this.handSlot = findBone(this.rig.root, 'handslot.r') ?? null;
    }

    if (this.handSlot) {
      const staff = this.handSlot.getObjectByName('staff') ?? this.handSlot.children[0];
      if (staff) {
        // Staff crystal tip is at local (0, 1.25, 0) in the authored staff model.
        out.set(0, 1.25, 0);
        staff.localToWorld(out);
        return true;
      }
    }

    this.weaponHand(out);
    return false;
  }

  /**
   * World position where a ranged projectile leaves the character:
   * for the Mage, the staff's actual crystal tip; for the Ranger, the weapon hand.
   */
  muzzlePosition(out: THREE.Vector3): void {
    if (this.profile.id === 'mage') {
      if (this.staffCastingPoint(out)) return;
    }
    this.weaponHand(out);
    out.y += 0.06;
  }

  update(delta: number, input: InputController, camera: ThirdPersonCamera): void {
    this.cooldown = Math.max(0, this.cooldown - delta);
    this.lockTimer = Math.max(0, this.lockTimer - delta);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - delta);
    this.invulnerable = Math.max(0, this.invulnerable - delta);

    for (const key of Object.keys(this.abilityCooldowns) as CharacterId[]) {
      if (this.abilityCooldowns[key] > 0) {
        this.abilityCooldowns[key] = Math.max(0, this.abilityCooldowns[key] - delta);
      }
    }

    if (!this.alive) {
      this.rig.update(delta);
      return;
    }

    const move = input.readMove();
    const forward = camera.forward(this.forward);
    this.right.set(-forward.z, 0, forward.x);

    this.direction
      .set(0, 0, 0)
      .addScaledVector(forward, move.y)
      .addScaledVector(this.right, move.x);

    const inputLength = Math.min(1, Math.hypot(move.x, move.y));
    if (this.direction.lengthSq() > 0.0001) this.direction.normalize();

    const wantsJump = input.takeJump();
    // Buffer the dodge briefly so a press during recovery is not swallowed.
    if (input.takeDodge()) this.dodgeBuffer = 0.3;
    this.dodgeBuffer = Math.max(0, this.dodgeBuffer - delta);

    // Signature ability input buffer
    if (input.takeAbility?.()) this.abilityBuffer = 0.25;
    this.abilityBuffer = Math.max(0, this.abilityBuffer - delta);
    if (this.abilityBuffer > 0 && this.canStartAbility()) {
      this.abilityBuffer = 0;
      this.startAbility(this.profile.ability!, forward);
    }

    // Attacks buffer briefly too, so a press during recovery or cooldown is not
    // dropped — it becomes the next swing instead of being swallowed.
    //
    // On a charge profile the heavy input does not fire anything: it starts the
    // draw, and the shot leaves when the input is released.
    if (input.takeHeavy()) {
      if (this.profile.charge) this.beginCharge();
      else {
        this.queuedAttack = this.profile.heavy;
        this.attackBuffer = 0.22;
      }
    } else if (input.takeAttack()) {
      // A light shot stays responsive: it cancels a charge without firing it.
      this.cancelCharge();
      this.queuedAttack = this.lightFlip && this.profile.lightAlt ? this.profile.lightAlt : this.profile.light;
      this.attackBuffer = 0.22;
    }
    this.attackBuffer = Math.max(0, this.attackBuffer - delta);
    if (this.attackBuffer === 0) this.queuedAttack = null;

    if (this.grounded && wantsJump && this.lockTimer <= 0 && !this.isAttacking && !this.isAbilityActive && !this.dodging) {
      this.grounded = false;
      this.verticalSpeed = JUMP_SPEED;
      this.airTime = 0;
      this.rig.animator.play('Jump_Start', { once: true, fade: 0.08, clamp: true });
      this.lockTimer = 0.1;
    }

    if (this.dodgeBuffer > 0 && this.canStartDodge()) {
      this.dodgeBuffer = 0;
      this.startDodge();
    }

    this.updateCharge(delta, input);

    if (this.queuedAttack && this.canStartAttack()) {
      const profile = this.queuedAttack;
      this.queuedAttack = null;
      this.attackBuffer = 0;
      // Only a committed light swing advances the alternation.
      if (profile === this.profile.light || profile === this.profile.lightAlt) {
        this.lightFlip = !this.lightFlip;
      }
      this.startAttack(profile, forward);
    }

    if (this.dodging) {
      this.applyDodgeMotion(delta);
    } else {
      // The defence input either guards or, for a bow profile, draws into the
      // aim stance. Entering and leaving is fade-driven, never a hard cut.
      const aim = this.profile.aim;
      this.aiming =
        aim !== undefined && input.isBlocking() && this.grounded && this.alive && !this.dodging;

      // Keep an active guard intact through block-hit recoil if the button stays held.
      // A profile without a guard (the Rogue, the Ranger) never enters the state.
      const canBlock = input.isBlocking() && this.grounded && !this.isAttacking && !this.isAbilityActive && this.profile.guard !== null;
      this.blocking = canBlock && (this.blocking || this.lockTimer <= 0);

      // Swinging, guarding and aiming all slow the character down rather than freezing them.
      const abilityMoveScale =
        this.isAbilityActive && this.abilityProfile && 'moveScale' in this.abilityProfile && typeof this.abilityProfile.moveScale === 'number'
          ? this.abilityProfile.moveScale
          : 0.15;
      const speedFactor = this.isAttacking || this.isAbilityActive
        ? abilityMoveScale
        : this.charging
          ? (this.profile.aim?.moveScale ?? 0.35)
          : this.aiming
            ? (this.profile.aim?.moveScale ?? 1)
            : this.blocking
              ? (this.profile.guard?.moveScale ?? 1)
              : 1;
      const targetSpeed = (move.run ? RUN_SPEED : WALK_SPEED) * inputLength * speedFactor;

      const accel = this.grounded ? 13 : 4.5;
      const blend = 1 - Math.exp(-accel * delta);
      this.velocity.x += (this.direction.x * targetSpeed - this.velocity.x) * blend;
      this.velocity.z += (this.direction.z * targetSpeed - this.velocity.z) * blend;
    }

    this.position.x += this.velocity.x * delta;
    this.position.z += this.velocity.z * delta;

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // While the bow/staff is up or charging, the aim owns the facing, so travel must not drag the
    // body around and make the stance oscillate.
    if (!this.isAttacking && !this.isAbilityActive && !this.dodging && !this.aiming && !this.charging && this.direction.lengthSq() > 0.01) {
      const targetYaw = Math.atan2(this.direction.x, this.direction.z);
      this.turnToward(targetYaw, delta, 13);
    }

    // Locked-on: face the enemy instead of the travel direction, which makes
    // sideways and backward input read as strafing and retreating.
    if (this.lockTarget && !this.dodging && !this.isAbilityActive) {
      const targetYaw = Math.atan2(
        this.lockTarget.x - this.position.x,
        this.lockTarget.z - this.position.z,
      );
      this.turnToward(targetYaw, delta, 14);
    } else if ((this.aiming || this.charging) && !this.isAbilityActive) {
      // Bow/staff up or charging: face the camera's aim, arriving at it rather than snapping.
      this.turnToward(Math.atan2(forward.x, forward.z), delta, 11);
    }

    this.applyGroundAndGravity(delta);
    this.clampToArena();
    resolveBlockers(this.position, this.world.blockers, BODY_RADIUS);

    this.updateAttack(delta);
    this.updateAbility(delta);
    this.updateDodge(delta);
    this.updateLocomotion();

    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    this.rig.update(delta);
  }

  /** Returns the damage actually taken, so the HUD can show the real number. */
  takeDamage(amount: number, from: THREE.Vector3, attacker?: unknown): number {
    if (!this.alive) return 0;

    // Dodge i-frames: the roll is a real evasion, not just a cosmetic clip.
    if (this.invulnerable > 0) return 0;

    // Knight Shield Counter: if in valid counter window, negate incoming damage
    // and identify the attacking enemy for the riposte strike.
    if (this.isCounterWindowActive) {
      if (!this.counterTriggered) {
        this.counterTriggered = true;
        this.counterAttacker = attacker ?? null;
        this.counterAttackerPos.copy(from);
        this.onCounterSuccess?.(attacker, from);
      }
      return 0;
    }

    // Being struck interrupts a charge rather than leaking the shot later.
    this.cancelCharge();

    const guard = this.profile.guard;
    const blocked = this.blocking && guard !== null;
    const applied = blocked && guard ? amount * guard.damageScale : amount;

    this.health = Math.max(0, this.health - applied);
    this.rig.flash(0.16);

    if (this.health <= 0) {
      this.alive = false;
      this.attack = null;
      this.blocking = false;
      this.dodging = false;
      this.aiming = false;
      this.shotFired = false;
      this.interruptAbility();
      this.rig.animator.play('Death_A', { once: true, fade: 0.1, clamp: true });
      return applied;
    }

    // Hyper-armour: heavy swings continue through hits so they are not cancelled
    // before their strike lands. For an armored ability, hyper-armour protects the
    // committed active strike phase (0.35..0.55s) from interruption. Recovery
    // (0.55..1.067s) is post-strike end-lag, so hits interrupt it into Hit_A.
    const abilityArmored =
      this.isAbilityActive && Boolean(this.abilityProfile?.armored) && this.abilityPhase === 'active';

    if (blocked && guard) {
      this.rig.animator.play(guard.hitClip, { once: true, fade: 0.06, clamp: true });
      this.lockTimer = 0.28;
    } else if (this.attack?.armored || abilityArmored) {
      this.lockTimer = 0.12;
    } else {
      this.attack = null;
      this.interruptAbility();
      this.lockTimer = 0.26;
      this.rig.animator.play('Hit_A', { once: true, fade: 0.06, clamp: true });
    }

    const knockback = this.position.clone().sub(from).setY(0);
    if (knockback.lengthSq() > 0.0001) {
      knockback.normalize().multiplyScalar(blocked ? 1.4 : 3.6);
      this.velocity.x += knockback.x;
      this.velocity.z += knockback.z;
    }

    return applied;
  }

  reset(): void {
    this.health = this.maxHealth;
    this.alive = true;
    this.attack = null;
    this.attackTime = 0;
    this.shotFired = false;
    this.charging = false;
    this.chargeTime = 0;
    this.chargeAttack = null;
    this.hitTargets.clear();
    this.cooldown = 0;
    this.lockTimer = 0;
    this.blocking = false;
    this.aiming = false;
    this.dodging = false;
    this.dodgeTime = 0;
    this.dodgeCooldown = 0;
    this.dodgeBuffer = 0;
    this.attackBuffer = 0;
    this.queuedAttack = null;
    this.lightFlip = false;
    this.dodgeClip = null;
    this.dodgeMotion = null;
    this.invulnerable = 0;
    this.lockTarget = null;
    this.interruptAbility();
    this.abilityBuffer = 0;
    for (const key of Object.keys(this.abilityCooldowns) as CharacterId[]) {
      this.abilityCooldowns[key] = 0;
    }
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.verticalSpeed = 0;
    this.yaw = Math.PI;
    this.position.set(ARENA.spawn.x, this.world.heightAt(ARENA.spawn.x, ARENA.spawn.z), ARENA.spawn.z);
    this.rig.animator.play('Idle_A', { fade: 0.1 });
  }

  private canStartAttack(): boolean {
    return (
      this.cooldown <= 0 &&
      !this.isAttacking &&
      !this.isAbilityActive &&
      !this.dodging &&
      !this.blocking &&
      this.grounded &&
      this.lockTimer <= 0
    );
  }

  /**
   * Starts a held charge. Nothing is fired here: the shot leaves on release, so
   * holding the key longer actually means more.
   */
  private beginCharge(): void {
    const charge = this.profile.charge;
    if (!charge || this.charging) return;
    if (!this.canStartAttack()) return;

    this.charging = true;
    this.chargeTime = 0;
    // Aim idle is the rest pose, not the charge pose. Always enter the authored
    // draw clip, including when F/RMB aim was already held; updateLocomotion
    // explicitly protects this clip while the charge is active.
    this.rig.animator.play(charge.drawClip, { once: true, fade: 0.14, clamp: true });
  }

  /** Advances or releases a held charge; runs before the attack-start gate. */
  private updateCharge(delta: number, input: InputController): void {
    if (!this.charging) return;

    const charge = this.profile.charge;
    if (!charge || !this.alive || this.dodging || !this.grounded) {
      this.cancelCharge();
      return;
    }

    if (input.isHeavyHeld()) {
      this.chargeTime = Math.min(charge.maxTime, this.chargeTime + delta);
      if (charge.clampTime !== undefined && this.chargeTime >= charge.clampTime) {
        (this.rig.animator as unknown as { clampAt?: (name: string, time: number) => void }).clampAt?.(
          charge.drawClip,
          charge.clampTime,
        );
      }
      return;
    }

    // Released: the arrow leaves with whatever charge it gathered. A release
    // before `minTime` still fires, at the minimum power.
    this.queuedAttack = this.chargedAttack(charge);
    this.attackBuffer = 0.12;
    this.charging = false;
    this.chargeTime = 0;
  }

  /** Interrupt: drops the charge without firing. */
  private cancelCharge(): void {
    this.charging = false;
    this.chargeTime = 0;
  }

  /**
   * The heavy profile with charge-scaled damage and arrow speed. One cached
   * object is reused, so a release allocates nothing.
   */
  private chargedAttack(charge: ChargeProfile): AttackProfile {
    const base = this.profile.heavy;
    if (!this.chargeAttack) this.chargeAttack = { ...base, ranged: { speed: 0, maxRange: 0 } };

    const attack = this.chargeAttack;
    const power = this.chargePower;

    attack.clip = base.clip;
    attack.arc = base.arc;
    attack.range = base.range;
    attack.hitStart = base.hitStart;
    attack.hitEnd = base.hitEnd;
    attack.timeScale = base.timeScale;
    attack.cooldown = base.cooldown;
    attack.recovery = base.recovery;
    attack.armored = base.armored;
    attack.tag = 'heavy';
    attack.damage = Math.round(charge.minDamage + (charge.maxDamage - charge.minDamage) * power);

    if (attack.ranged && base.ranged) {
      attack.ranged.speed = charge.minSpeed + (charge.maxSpeed - charge.minSpeed) * power;
      attack.ranged.maxRange = base.ranged.maxRange;
    }

    return attack;
  }

  canStartAbility(): boolean {
    const ability = this.profile.ability;
    if (!ability) return false;
    return (
      this.alive &&
      this.grounded &&
      !this.isAbilityActive &&
      this.abilityCooldowns[this.profile.id] <= 0 &&
      !this.isAttacking &&
      !this.dodging &&
      this.lockTimer <= 0.05
    );
  }

  startAbility(ability: AbilityProfile, cameraForward: THREE.Vector3): void {
    this.abilityProfile = ability;
    this.abilityPhase = 'startup';
    this.abilityTime = 0;
    this.counterTriggered = false;
    this.counterAttacker = null;
    this.abilityHitApplied = false;
    this.abilityHitTargets.clear();
    this.abilityCooldowns[this.profile.id] = ability.cooldown;
    this.blocking = false;
    this.cancelCharge();

    if (this.lockTarget) {
      this.yaw = Math.atan2(
        this.lockTarget.x - this.position.x,
        this.lockTarget.z - this.position.z,
      );
    } else {
      const aim = this.direction.lengthSq() > 0.01 ? this.direction : cameraForward;
      this.yaw = Math.atan2(aim.x, aim.z);
    }

    this.rig.animator.play(ability.clip, {
      once: true,
      fade: 0.08,
      timeScale: ability.timeScale,
      clamp: true,
    });

    this.onAbilityStart?.(ability);
  }

  interruptAbility(): void {
    this.abilityPhase = 'idle';
    this.abilityProfile = null;
    this.abilityTime = 0;
    this.counterTriggered = false;
    this.counterAttacker = null;
    this.abilityHitApplied = false;
    this.abilityHitTargets.clear();
  }

  private updateAbility(delta: number): void {
    if (!this.isAbilityActive || !this.abilityProfile) return;

    const ability = this.abilityProfile;
    this.abilityTime += delta;
    const clipTime = this.abilityTime * ability.timeScale;

    if (ability.kind === 'counter') {
      const counterEnd = ability.counterEnd;
      const riposteHit = ability.riposteHit;
      const riposteEnd = 0.55;
      const totalDuration = ability.duration;

      if (clipTime < counterEnd) {
        this.abilityPhase = 'startup';
      } else if (clipTime < riposteEnd) {
        this.abilityPhase = 'active';
      } else if (clipTime < totalDuration) {
        this.abilityPhase = 'recovery';
      } else {
        this.interruptAbility();
        return;
      }

      if (!this.abilityHitApplied && clipTime >= riposteHit) {
        this.abilityHitApplied = true;
        this.executeCounterRiposte(ability);
      }
    } else if (ability.kind === 'whirlwind') {
      const hitStart = ability.hitStart;
      const hitEnd = ability.hitEnd;
      const totalDuration = ability.duration;

      if (clipTime < hitStart) {
        this.abilityPhase = 'startup';
      } else if (clipTime < hitEnd) {
        this.abilityPhase = 'active';
        this.executeWhirlwindSweep(ability);
      } else if (clipTime < totalDuration) {
        this.abilityPhase = 'recovery';
      } else {
        this.interruptAbility();
        return;
      }
    }
  }

  private executeWhirlwindSweep(ability: WhirlwindAbilityProfile): void {
    if (this.onAbilityRadialSweep) {
      this.onAbilityRadialSweep(
        this.position,
        ability.radius,
        ability.maxVerticalOffset ?? 1.5,
        ability,
        this.abilityHitTargets,
      );
      return;
    }

    if (!this.findAreaTargets) return;
    const candidates = this.findAreaTargets();
    if (!Array.isArray(candidates)) return;

    const maxVertical = ability.maxVerticalOffset ?? 1.5;
    const radiusSq = ability.radius * ability.radius;

    const clipTime = this.abilityTime * ability.timeScale;
    const hitStart = ability.hitStart;
    const hitEnd = ability.hitEnd;
    const span = Math.max(0.0001, hitEnd - hitStart);
    const progress = Math.min(1.0, Math.max(0.0, (clipTime - hitStart) / span));

    // Authored root rotation at hitStart (0.10s) is -53.5 deg (-0.9337 rad).
    // The spin rotates clockwise (decreasing yaw), sweeping 360 degrees (2*PI rad) across [hitStart, hitEnd].
    const startAngle = ability.startAngle ?? -0.9337;
    const arcHalf = (ability.bladeArc ?? 1.22) * 0.5;
    const TWO_PI = Math.PI * 2;
    const maxSwept = TWO_PI * progress + arcHalf;

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      if (this.abilityHitTargets.has(candidate)) continue;

      const enemyObj = candidate as { alive?: boolean; position?: THREE.Vector3 };
      if (enemyObj.alive === false) continue;
      if (!enemyObj.position) continue;

      const dy = Math.abs(enemyObj.position.y - this.position.y);
      if (dy > maxVertical) continue;

      const dx = enemyObj.position.x - this.position.x;
      const dz = enemyObj.position.z - this.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > radiusSq) continue;

      // Angular check: the axe sweeps clockwise from startAngle relative to the player's base yaw
      const enemyAngle = Math.atan2(dx, dz);
      const relativeAngle = enemyAngle - this.yaw;
      const angleFromStart = ((startAngle - relativeAngle) % TWO_PI + TWO_PI) % TWO_PI;

      const inSweep =
        angleFromStart <= maxSwept || (progress < 0.15 && angleFromStart >= TWO_PI - arcHalf);
      if (!inSweep) continue;

      // Obstacle line-of-sight check: do not hit through walls or solid obstacles
      const clear =
        !this.world.obstacles ||
        hasLineOfSight(
          this.position.x,
          this.position.y + 1.2,
          this.position.z,
          enemyObj.position.x,
          enemyObj.position.y + 1.2,
          enemyObj.position.z,
          this.world.obstacles,
        );
      if (!clear) continue;

      this.abilityHitTargets.add(candidate);
      this.onAbilityHit?.(candidate, ability);
    }
  }

  private executeCounterRiposte(ability: CounterAbilityProfile): void {
    if (!this.counterTriggered) return;

    let target: unknown | null = null;
    const attacker = this.counterAttacker;

    if (attacker && typeof attacker === 'object') {
      const enemyObj = attacker as { alive?: boolean; position?: THREE.Vector3 };
      const isAlive = enemyObj.alive !== false;
      if (isAlive && enemyObj.position) {
        const dist = this.position.distanceTo(enemyObj.position);
        if (dist <= ability.range + 1.2) {
          // A wall or obstacle between player and attacker stops the riposte
          const clear =
            !this.world.obstacles ||
            hasLineOfSight(
              this.position.x,
              this.position.y + 1.2,
              this.position.z,
              enemyObj.position.x,
              enemyObj.position.y + 1.2,
              enemyObj.position.z,
              this.world.obstacles,
            );
          if (clear) {
            target = attacker;
            const dx = enemyObj.position.x - this.position.x;
            const dz = enemyObj.position.z - this.position.z;
            if (dx * dx + dz * dz > 0.001) {
              this.yaw = Math.atan2(dx, dz);
            }
          }
        }
      }
    }

    if (!target && this.findFallbackTarget) {
      target = this.findFallbackTarget();
    }

    this.onAbilityHit?.(target, ability);
  }

  private canStartDodge(): boolean {
    // A dodge may cancel attack recovery once the blade has already landed,
    // or ability recovery once the riposte/active window has concluded.
    const attackRecovering = this.attack !== null && this.attackTime > this.attack.hitStart / this.attack.timeScale;
    const abilityRecovering = this.isAbilityActive && this.abilityPhase === 'recovery';

    return (
      this.dodgeCooldown <= 0 &&
      !this.dodging &&
      (!this.isAttacking || attackRecovering) &&
      (!this.isAbilityActive || abilityRecovering) &&
      this.grounded
    );
  }

  private startAttack(profile: AttackProfile, cameraForward: THREE.Vector3): void {
    this.attack = profile;
    this.attackTime = 0;
    this.shotFired = false;
    this.hitTargets.clear();
    this.cooldown = profile.cooldown;

    // Attacks commit to the locked target, else movement input, else camera facing.
    if (this.lockTarget) {
      this.yaw = Math.atan2(
        this.lockTarget.x - this.position.x,
        this.lockTarget.z - this.position.z,
      );
    } else if (profile.ranged) {
      // In aim stance, facing already tracks the camera smoothly.
      // If hip-firing without aim stance or lock-on, orient the character
      // toward the camera facing so the attack faces the crosshair.
      if (!this.aiming) {
        this.yaw = Math.atan2(cameraForward.x, cameraForward.z);
      }
    } else {
      const aim = this.direction.lengthSq() > 0.01 ? this.direction : cameraForward;
      this.yaw = Math.atan2(aim.x, aim.z);
    }

    this.rig.animator.play(profile.clip, {
      once: true,
      fade: 0.08,
      timeScale: profile.timeScale,
      clamp: true,
    });

    this.onAttackStart?.(profile);
  }

  private startDodge(): void {
    const direction = this.direction.lengthSq() > 0.01
      ? this.direction.clone()
      : this.facing(new THREE.Vector3());

    const forward = Math.sin(this.yaw) * direction.x + Math.cos(this.yaw) * direction.z;
    const strafe = -Math.cos(this.yaw) * direction.x + Math.sin(this.yaw) * direction.z;
    const clip =
      Math.abs(forward) >= Math.abs(strafe)
        ? forward >= 0
          ? 'Dodge_Forward'
          : 'Dodge_Backward'
        : strafe >= 0
          ? 'Dodge_Right'
          : 'Dodge_Left';

    this.dodging = true;
    this.dodgeTime = 0;
    this.cancelCharge();
    this.interruptAbility();
    this.dodgeClip = clip;
    this.dodgeMotion = DODGE_MOTION.get(clip) ?? null;
    this.dodgeDuration = Math.max(
      0.18,
      (this.rig.animator.clipDuration(clip) || DODGE.duration) / DODGE.timeScale,
    );
    this.dodgeCooldown = DODGE.cooldown;
    this.invulnerable = Math.min(DODGE.invulnerable, this.dodgeDuration * 0.9);
    this.blocking = false;
    this.attack = null;
    this.hitTargets.clear();

    // Constant dash for the whole move: a decaying burst reads as a nudge, not
    // a committed evade. The clip's own footwork is layered on top.
    this.velocity.set(direction.x * DODGE.speed, 0, direction.z * DODGE.speed);

    this.rig.animator.play(clip, {
      once: true,
      fade: 0.06,
      clamp: true,
      timeScale: DODGE.timeScale,
    });

    this.onDodgeStart?.();
  }

  /**
   * Replays the clip's authored root travel (stripped from the skeleton at load)
   * rotated into the character's frame, so the feet and the body move together.
   */
  private applyDodgeMotion(delta: number): void {
    const motion = this.dodgeMotion;
    if (!motion) return;

    const from = this.dodgeTime * DODGE.timeScale;
    const to = Math.min(this.dodgeDuration, this.dodgeTime + delta) * DODGE.timeScale;

    const stepX =
      (sampleMotion(motion.x, motion.times, to) - sampleMotion(motion.x, motion.times, from)) * DODGE.reach;
    const stepZ =
      (sampleMotion(motion.z, motion.times, to) - sampleMotion(motion.z, motion.times, from)) * DODGE.reach;

    // Local +x is the character's left, local +z is forward.
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    this.position.x += stepX * cos + stepZ * sin;
    this.position.z += -stepX * sin + stepZ * cos;
  }

  private updateDodge(delta: number): void {
    if (!this.dodging) return;

    this.dodgeTime += delta;
    if (this.dodgeTime >= this.dodgeDuration) {
      this.dodging = false;
      this.dodgeMotion = null;
      // Bleed the dash off so the character plants instead of coasting.
      this.velocity.multiplyScalar(0.35);
    }
  }

  private updateAttack(delta: number): void {
    if (!this.attack) return;

    const prevTime = this.attackTime;
    this.attackTime += delta;

    const authored = this.rig.animator.clipDuration(this.attack.clip);
    const start = this.attack.hitStart / this.attack.timeScale;
    const end = this.attack.hitEnd / this.attack.timeScale;
    // Profiles that declare a recovery release the character a fixed time after
    // the strike instead of playing the clip's authored tail. The Knight omits
    // it, so its timing is byte-for-byte what it was.
    const duration =
      this.attack.recovery === undefined
        ? Math.max(0.2, (authored || 0.8) / this.attack.timeScale)
        : Math.max(0.2, end + this.attack.recovery);

    if (this.attack.ranged) {
      // One arrow per attack, released on the first frame past the loose.
      if (!this.shotFired && this.attackTime >= start) {
        this.shotFired = true;
        this.onRangedShot?.(this.attack);
      }
    } else if (this.attackTime >= start && prevTime <= end) {
      this.onAttackHit?.(this.position, this.facing(new THREE.Vector3()), this.attack, this.hitTargets);
    }

    if (this.attackTime >= duration) this.attack = null;
  }

  private applyGroundAndGravity(delta: number): void {
    const ground = this.world.heightAt(this.position.x, this.position.z);

    if (this.grounded) {
      this.position.y = ground;
      return;
    }

    this.airTime += delta;
    this.verticalSpeed += GRAVITY * delta;
    this.position.y += this.verticalSpeed * delta;

    if (this.position.y <= ground) {
      this.position.y = ground;
      this.grounded = true;
      this.verticalSpeed = 0;
      this.rig.animator.play('Jump_Land', { once: true, fade: 0.08, clamp: true });
      this.lockTimer = 0.14;
      // Ground contact after a real fall, not a one-frame step.
      if (this.airTime > 0.12) this.onLand?.();
      return;
    }

    if (this.airTime > 0.4 && this.verticalSpeed < 1.5) {
      this.rig.animator.play('Jump_Idle', { fade: 0.16 });
    }
  }

  private updateLocomotion(): void {
    if (this.isAttacking || this.isAbilityActive || this.dodging) return;
    // The draw clip owns the body while charging; the aim loop must not replace
    // it, or the bow would re-draw itself every frame.
    if (this.charging) return;
    if (!this.grounded) return;
    if (this.lockTimer > 0.05) return;

    if (this.aiming && this.profile.aim) {
      this.rig.animator.play(this.profile.aim.clip, { fade: 0.2 });
      return;
    }

    if (this.blocking && this.profile.guard) {
      this.rig.animator.play(this.profile.guard.clip, { fade: 0.14 });
      return;
    }

    if (this.speed > 4.3) {
      this.rig.animator.play('Running_A', {
        fade: 0.16,
        timeScale: clamp(this.speed / 5.4, 0.8, 1.55),
      });
    } else if (this.speed > 0.3) {
      this.rig.animator.play('Walking_A', {
        fade: 0.16,
        timeScale: clamp(this.speed / 2.2, 0.7, 1.5),
      });
    } else {
      this.rig.animator.play('Idle_A', { fade: 0.22 });
    }
  }

  private turnToward(targetYaw: number, delta: number, rate: number): void {
    let difference = targetYaw - this.yaw;
    difference = Math.atan2(Math.sin(difference), Math.cos(difference));
    this.yaw += difference * (1 - Math.exp(-rate * delta));
  }

  private clampToArena(): void {
    const limit = ARENA.radius - 1.6;
    const distance = Math.hypot(this.position.x, this.position.z);
    if (distance <= limit) return;

    const scale = limit / distance;
    this.position.x *= scale;
    this.position.z *= scale;
    this.velocity.x *= 0.4;
    this.velocity.z *= 0.4;
  }
}
