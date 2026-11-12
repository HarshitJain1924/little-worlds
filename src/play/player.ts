import * as THREE from 'three';
import type { CharacterRig } from './character';
import type { ThirdPersonCamera } from './camera';
import type { InputController } from './input';
import type { Blocker, World } from './world';
import { ARENA } from './world';

export const ATTACK = {
  duration: 0.52,
  cooldown: 0.6,
  /** Portion of the swing where the blade can connect. */
  hitStart: 0.36,
  hitEnd: 0.52,
  range: 2.4,
  /** Half-angle of the damage cone. */
  arc: Math.PI * 0.34,
  damage: 26,
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

  /** Fired when the swing reaches its damage window. */
  onAttackHit: ((position: THREE.Vector3, forward: THREE.Vector3) => void) | null = null;

  private readonly velocity = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  private grounded = true;
  private verticalSpeed = 0;
  private airTime = 0;
  private speed = 0;
  private attacking = false;
  private attackTime = 0;
  private hitResolved = false;
  private cooldown = 0;
  private lockTimer = 0;

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
    return this.attacking;
  }

  /** Facing direction on the ground plane. */
  facing(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  update(delta: number, input: InputController, camera: ThirdPersonCamera): void {
    this.cooldown = Math.max(0, this.cooldown - delta);
    this.lockTimer = Math.max(0, this.lockTimer - delta);

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

    if (this.grounded && input.takeJump() && this.lockTimer <= 0 && !this.attacking) {
      this.grounded = false;
      this.verticalSpeed = JUMP_SPEED;
      this.airTime = 0;
      this.rig.animator.play('Jump_Start', { once: true, fade: 0.08, clamp: true });
      this.lockTimer = 0.1;
    }

    if (input.takeAttack() && this.cooldown <= 0 && !this.attacking && this.grounded && this.lockTimer <= 0) {
      this.startAttack();
    }

    // Holding a swing slows the character down instead of freezing them.
    const speedFactor = this.attacking ? 0.22 : 1;
    const targetSpeed = (move.run ? RUN_SPEED : WALK_SPEED) * inputLength * speedFactor;

    const accel = this.grounded ? 13 : 4.5;
    const blend = 1 - Math.exp(-accel * delta);
    this.velocity.x += (this.direction.x * targetSpeed - this.velocity.x) * blend;
    this.velocity.z += (this.direction.z * targetSpeed - this.velocity.z) * blend;

    this.position.x += this.velocity.x * delta;
    this.position.z += this.velocity.z * delta;

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    if (!this.attacking && this.direction.lengthSq() > 0.01) {
      const targetYaw = Math.atan2(this.direction.x, this.direction.z);
      let difference = targetYaw - this.yaw;
      difference = Math.atan2(Math.sin(difference), Math.cos(difference));
      this.yaw += difference * (1 - Math.exp(-13 * delta));
    }

    this.applyGroundAndGravity(delta);
    this.clampToArena();
    pushOutOfBlockers(this.position, this.world.blockers, BODY_RADIUS);

    this.updateAttack(delta);
    this.updateLocomotion();

    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    this.rig.update(delta);
  }

  takeDamage(amount: number, from: THREE.Vector3): void {
    if (!this.alive) return;

    this.health = Math.max(0, this.health - amount);
    this.rig.flash(0.16);

    if (this.health <= 0) {
      this.alive = false;
      this.attacking = false;
      this.rig.animator.setSwingPhase(null);
      this.rig.animator.play('Death_A', { once: true, fade: 0.1, clamp: true });
      return;
    }

    this.lockTimer = 0.26;
    this.rig.animator.play('Hit_A', { once: true, fade: 0.06, clamp: true });

    const knockback = this.position.clone().sub(from).setY(0);
    if (knockback.lengthSq() > 0.0001) {
      knockback.normalize().multiplyScalar(3.6);
      this.velocity.x += knockback.x;
      this.velocity.z += knockback.z;
    }
  }

  reset(): void {
    this.health = this.maxHealth;
    this.alive = true;
    this.attacking = false;
    this.attackTime = 0;
    this.cooldown = 0;
    this.lockTimer = 0;
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.verticalSpeed = 0;
    this.yaw = Math.PI;
    this.position.set(ARENA.spawn.x, this.world.heightAt(ARENA.spawn.x, ARENA.spawn.z), ARENA.spawn.z);
    this.rig.animator.setSwingPhase(null);
    this.rig.animator.play('Idle_A', { fade: 0.1 });
  }

  private startAttack(): void {
    this.attacking = true;
    this.attackTime = 0;
    this.hitResolved = false;
    this.cooldown = ATTACK.cooldown;
    this.rig.animator.setSwingPhase(0);
  }

  private updateAttack(delta: number): void {
    if (!this.attacking) return;

    this.attackTime += delta;
    const phase = Math.min(1, this.attackTime / ATTACK.duration);
    this.rig.animator.setSwingPhase(phase);

    if (!this.hitResolved && phase >= ATTACK.hitStart) {
      this.hitResolved = true;
      this.onAttackHit?.(this.position, this.facing(new THREE.Vector3()));
    }

    if (this.attackTime >= ATTACK.duration) {
      this.attacking = false;
      this.rig.animator.setSwingPhase(null);
    }
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
    if (this.attacking) return;
    if (!this.grounded) return;
    if (this.lockTimer > 0.05) return;

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
