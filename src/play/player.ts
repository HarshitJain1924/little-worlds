import * as THREE from 'three';
import type { CharacterRig } from './character';
import type { DodgeMotion } from './models';
import { DODGE_MOTION } from './models';
import type { ThirdPersonCamera } from './camera';
import type { InputController } from './input';
import { resolveBlockers } from './collision';
import type { World } from './world';
import { ARENA } from './world';

/**
 * Attack definitions. `hitStart`..`hitEnd` are the authored clip times (measured
 * from the keyframes in Rig_Medium_CombatMelee.glb) during which the weapon is
 * sweeping through the target zone, so damage never lands during windup.
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
}

export const ATTACKS = {
  // Slice_Diagonal: 1.00s clip, blade crosses front center 0.39..0.46s (peak tip speed at 0.43s).
  light: {
    clip: 'Melee_1H_Attack_Slice_Diagonal',
    damage: 26,
    range: 2.4,
    arc: Math.PI * 0.34,
    hitStart: 0.39,
    hitEnd: 0.46,
    timeScale: 1.15,
    cooldown: 1.2,
  } as AttackProfile,
  // Chop: 1.07s clip, overhead windup through 0.53s; downward cleave hits 0.58..0.65s (peak at 0.60s).
  heavy: {
    clip: 'Melee_1H_Attack_Chop',
    damage: 44,
    range: 2.7,
    arc: Math.PI * 0.42,
    hitStart: 0.58,
    hitEnd: 0.65,
    timeScale: 1,
    cooldown: 1.9,
    armored: true,
  } as AttackProfile,
} as const;

const BLOCK = {
  clip: 'Melee_Blocking',
  hitClip: 'Melee_Block_Hit',
  moveScale: 0.4,
  /** Damage that still gets through a raised shield. */
  damageScale: 0.25,
} as const;

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
  readonly rig: CharacterRig;
  readonly position = new THREE.Vector3();
  readonly maxHealth = 100;

  health = 100;
  yaw = Math.PI;
  alive = true;

  /** Fired during the active swing window; hitTargets prevents multi-hitting one enemy. */
  onAttackHit:
    | ((position: THREE.Vector3, forward: THREE.Vector3, attack: AttackProfile, hitTargets: Set<object>) => void)
    | null = null;

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
  private dodging = false;
  private dodgeTime = 0;
  private dodgeDuration: number = DODGE.duration;
  private dodgeCooldown = 0;
  private dodgeBuffer = 0;
  private dodgeClip: string | null = null;
  private dodgeMotion: DodgeMotion | null = null;
  private invulnerable = 0;
  private lockTarget: { x: number; z: number } | null = null;

  constructor(
    rig: CharacterRig,
    private readonly world: World,
    spawn: { x: number; z: number } = ARENA.spawn,
  ) {
    this.rig = rig;
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

  update(delta: number, input: InputController, camera: ThirdPersonCamera): void {
    this.cooldown = Math.max(0, this.cooldown - delta);
    this.lockTimer = Math.max(0, this.lockTimer - delta);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - delta);
    this.invulnerable = Math.max(0, this.invulnerable - delta);

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
    const wantsHeavy = input.takeHeavy();
    const wantsAttack = input.takeAttack();

    if (this.grounded && wantsJump && this.lockTimer <= 0 && !this.isAttacking && !this.dodging) {
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

    if (this.canStartAttack()) {
      if (wantsHeavy) this.startAttack(ATTACKS.heavy, forward);
      else if (wantsAttack) this.startAttack(ATTACKS.light, forward);
    }

    if (this.dodging) {
      this.applyDodgeMotion(delta);
    } else {
      // Keep an active guard intact through block-hit recoil if the button stays held.
      const canBlock = input.isBlocking() && this.grounded && !this.isAttacking;
      this.blocking = canBlock && (this.blocking || this.lockTimer <= 0);

      // Swinging and guarding both slow the character down rather than freezing them.
      const speedFactor = this.isAttacking ? 0.2 : this.blocking ? BLOCK.moveScale : 1;
      const targetSpeed = (move.run ? RUN_SPEED : WALK_SPEED) * inputLength * speedFactor;

      const accel = this.grounded ? 13 : 4.5;
      const blend = 1 - Math.exp(-accel * delta);
      this.velocity.x += (this.direction.x * targetSpeed - this.velocity.x) * blend;
      this.velocity.z += (this.direction.z * targetSpeed - this.velocity.z) * blend;
    }

    this.position.x += this.velocity.x * delta;
    this.position.z += this.velocity.z * delta;

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    if (!this.isAttacking && !this.dodging && this.direction.lengthSq() > 0.01) {
      const targetYaw = Math.atan2(this.direction.x, this.direction.z);
      this.turnToward(targetYaw, delta, 13);
    }

    // Locked-on: face the enemy instead of the travel direction, which makes
    // sideways and backward input read as strafing and retreating.
    if (this.lockTarget && !this.dodging) {
      const targetYaw = Math.atan2(
        this.lockTarget.x - this.position.x,
        this.lockTarget.z - this.position.z,
      );
      this.turnToward(targetYaw, delta, 14);
    }

    this.applyGroundAndGravity(delta);
    this.clampToArena();
    resolveBlockers(this.position, this.world.blockers, BODY_RADIUS);

    this.updateAttack(delta);
    this.updateDodge(delta);
    this.updateLocomotion();

    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    this.rig.update(delta);
  }

  /** Returns the damage actually taken, so the HUD can show the real number. */
  takeDamage(amount: number, from: THREE.Vector3): number {
    if (!this.alive) return 0;

    // Dodge i-frames: the roll is a real evasion, not just a cosmetic clip.
    if (this.invulnerable > 0) return 0;

    const blocked = this.blocking;
    const applied = blocked ? amount * BLOCK.damageScale : amount;

    this.health = Math.max(0, this.health - applied);
    this.rig.flash(0.16);

    if (this.health <= 0) {
      this.alive = false;
      this.attack = null;
      this.blocking = false;
      this.dodging = false;
      this.rig.animator.play('Death_A', { once: true, fade: 0.1, clamp: true });
      return applied;
    }

    if (blocked) {
      this.rig.animator.play(BLOCK.hitClip, { once: true, fade: 0.06, clamp: true });
      this.lockTimer = 0.28;
    } else if (this.attack?.armored) {
      // Hyper-armour: the heavy swing continues through the hit, so it is not
      // cancelled a fraction of a second before its own strike lands.
      this.lockTimer = 0.12;
    } else {
      this.attack = null;
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
    this.hitTargets.clear();
    this.cooldown = 0;
    this.lockTimer = 0;
    this.blocking = false;
    this.dodging = false;
    this.dodgeTime = 0;
    this.dodgeCooldown = 0;
    this.dodgeBuffer = 0;
    this.dodgeClip = null;
    this.dodgeMotion = null;
    this.invulnerable = 0;
    this.lockTarget = null;
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
      !this.dodging &&
      !this.blocking &&
      this.grounded &&
      this.lockTimer <= 0
    );
  }

  private canStartDodge(): boolean {
    // A dodge may cancel attack recovery once the blade has already landed.
    const recovering = this.attack !== null && this.attackTime > this.attack.hitStart / this.attack.timeScale;

    return (
      this.dodgeCooldown <= 0 &&
      !this.dodging &&
      (!this.isAttacking || recovering) &&
      this.grounded
    );
  }

  private startAttack(profile: AttackProfile, cameraForward: THREE.Vector3): void {
    this.attack = profile;
    this.attackTime = 0;
    this.hitTargets.clear();
    this.cooldown = profile.cooldown;

    // Attacks commit to the locked target, else movement input, else camera facing.
    if (this.lockTarget) {
      this.yaw = Math.atan2(
        this.lockTarget.x - this.position.x,
        this.lockTarget.z - this.position.z,
      );
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
    const duration = Math.max(0.2, (authored || 0.8) / this.attack.timeScale);

    if (this.attackTime >= start && prevTime <= end) {
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
      return;
    }

    if (this.airTime > 0.4 && this.verticalSpeed < 1.5) {
      this.rig.animator.play('Jump_Idle', { fade: 0.16 });
    }
  }

  private updateLocomotion(): void {
    if (this.isAttacking || this.dodging) return;
    if (!this.grounded) return;
    if (this.lockTimer > 0.05) return;

    if (this.blocking) {
      this.rig.animator.play(BLOCK.clip, { fade: 0.14 });
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
