import * as THREE from 'three';
import type { CharacterRig } from './character';
import type { ThirdPersonCamera } from './camera';
import type { InputController } from './input';
import type { Blocker, World } from './world';
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
  duration: 0.4,
  speed: 9.5,
  cooldown: 0.85,
  /** i-frames, slightly shorter than the clip so recovery is punishable. */
  invulnerable: 0.3,
} as const;

const WALK_SPEED = 2.5;
const RUN_SPEED = 6.2;
const GRAVITY = -26;
const JUMP_SPEED = 8.6;
const BODY_RADIUS = 0.42;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function pushOutOfBlockers(position: THREE.Vector3, blockers: Blocker[], radius: number): void {
  for (const blocker of blockers) {
    if (
      position.x < blocker.minX - radius ||
      position.x > blocker.maxX + radius ||
      position.z < blocker.minZ - radius ||
      position.z > blocker.maxZ + radius
    ) {
      continue;
    }

    // Push along whichever axis offers the shallowest escape.
    const left = position.x - (blocker.minX - radius);
    const right = blocker.maxX + radius - position.x;
    const back = position.z - (blocker.minZ - radius);
    const front = blocker.maxZ + radius - position.z;
    const smallest = Math.min(left, right, back, front);

    if (smallest === left) position.x = blocker.minX - radius;
    else if (smallest === right) position.x = blocker.maxX + radius;
    else if (smallest === back) position.z = blocker.minZ - radius;
    else position.z = blocker.maxZ + radius;
  }
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

  private readonly velocity = new THREE.Vector3();
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
  private dodgeCooldown = 0;
  private invulnerable = 0;

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
    const wantsDodge = input.takeDodge();
    const wantsHeavy = input.takeHeavy();
    const wantsAttack = input.takeAttack();

    if (this.grounded && wantsJump && this.lockTimer <= 0 && !this.isAttacking && !this.dodging) {
      this.grounded = false;
      this.verticalSpeed = JUMP_SPEED;
      this.airTime = 0;
      this.rig.animator.play('Jump_Start', { once: true, fade: 0.08, clamp: true });
      this.lockTimer = 0.1;
    }

    if (wantsDodge && this.canStartDodge()) {
      this.startDodge();
    }

    if (this.canStartAttack()) {
      if (wantsHeavy) this.startAttack(ATTACKS.heavy, forward);
      else if (wantsAttack) this.startAttack(ATTACKS.light, forward);
    }

    if (!this.dodging) {
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

    this.applyGroundAndGravity(delta);
    this.clampToArena();
    pushOutOfBlockers(this.position, this.world.blockers, BODY_RADIUS);

    this.updateAttack(delta);
    this.updateDodge(delta);
    this.updateLocomotion();

    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    this.rig.update(delta);
  }

  takeDamage(amount: number, from: THREE.Vector3): void {
    if (!this.alive) return;

    // Dodge i-frames: the roll is a real evasion, not just a cosmetic clip.
    if (this.invulnerable > 0) return;

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
      return;
    }

    if (blocked) {
      this.rig.animator.play(BLOCK.hitClip, { once: true, fade: 0.06, clamp: true });
      this.lockTimer = 0.28;
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
    this.invulnerable = 0;
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
    return (
      this.dodgeCooldown <= 0 &&
      !this.dodging &&
      !this.isAttacking &&
      this.grounded &&
      this.lockTimer <= 0
    );
  }

  private startAttack(profile: AttackProfile, cameraForward: THREE.Vector3): void {
    this.attack = profile;
    this.attackTime = 0;
    this.hitTargets.clear();
    this.cooldown = profile.cooldown;

    // Attacks commit toward current movement input, or camera facing when stationary.
    const aim = this.direction.lengthSq() > 0.01 ? this.direction : cameraForward;
    this.yaw = Math.atan2(aim.x, aim.z);

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

    // Root XZ translation is stripped from Dodge_* clips at load time, so the
    // burst below is the sole world translation and stays aligned with the collider.
    this.velocity.set(direction.x * DODGE.speed, 0, direction.z * DODGE.speed);
    this.dodging = true;
    this.dodgeTime = 0;
    this.dodgeCooldown = DODGE.cooldown;
    this.invulnerable = DODGE.invulnerable;
    this.blocking = false;
    this.attack = null;
    this.hitTargets.clear();

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

    this.rig.animator.play(clip, { once: true, fade: 0.06, clamp: true });
  }

  private updateDodge(delta: number): void {
    if (!this.dodging) return;

    this.dodgeTime += delta;
    const friction = Math.exp(-7 * delta);
    this.velocity.x *= friction;
    this.velocity.z *= friction;

    if (this.dodgeTime >= DODGE.duration) this.dodging = false;
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
