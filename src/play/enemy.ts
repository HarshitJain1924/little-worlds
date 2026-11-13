import * as THREE from 'three';
import type { CharacterRig } from './character';
import { hasLineOfSight, resolveBlockers } from './collision';
import type { World } from './world';
import { ARENA } from './world';

export interface EnemyConfig {
  label: string;
  maxHealth: number;
  speed: number;
  damage: number;
  aggroRadius: number;
  attackRange: number;
  attackCooldown: number;
  attackClip?: string;
  /** Authored clip time (seconds) when the enemy weapon reaches the player. */
  attackStrike?: number;
  attackTimeScale?: number;
}

export type EnemyState = 'idle' | 'chase' | 'attack' | 'hurt' | 'dead';

const DEFAULT_ATTACK_CLIP = 'Melee_1H_Attack_Slice_Diagonal';
const DEFAULT_ATTACK_STRIKE = 0.4;
const PATROL_RADIUS = 5;
const BODY_RADIUS = 0.45;
/** Chest height used for attack line-of-sight checks. */
const CHEST = 1.2;

export class Enemy {
  readonly rig: CharacterRig;
  readonly position = new THREE.Vector3();
  readonly config: EnemyConfig;

  health: number;
  state: EnemyState = 'idle';
  alive = true;

  onHitPlayer: ((damage: number, from: THREE.Vector3, attacker: Enemy) => void) | null = null;

  private readonly home = new THREE.Vector3();
  private readonly patrolTarget = new THREE.Vector3();
  private readonly chaseTarget = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly toPlayer = new THREE.Vector3();

  /** Which side this skeleton prefers to circle on, so a pair does not stack. */
  private readonly flankSign: number;

  private yaw = 0;
  private stateTimer = 0;
  private patrolTimer = 0;
  private cooldown = 0;
  private hurtTimer = 0;
  private attackLanded = false;
  private speed = 0;

  constructor(
    rig: CharacterRig,
    config: EnemyConfig,
    spawn: { x: number; z: number },
    private readonly world: World,
  ) {
    this.rig = rig;
    this.config = config;
    this.health = config.maxHealth;

    this.home.set(spawn.x, world.heightAt(spawn.x, spawn.z), spawn.z);
    this.position.copy(this.home);
    this.patrolTarget.copy(this.home);
    this.yaw = Math.PI;
    this.flankSign = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.6);
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
  }

  get isTargetable(): boolean {
    return this.alive && this.state !== 'dead';
  }

  /** True between committing to a swing and the blow actually landing. */
  get isWindingUp(): boolean {
    return this.state === 'attack' && !this.attackLanded;
  }

  /** 0 at the start of the wind-up, 1 at the strike — drives the ground telegraph. */
  get windupProgress(): number {
    if (this.state !== 'attack') return 0;

    const timeScale = this.config.attackTimeScale ?? 1;
    const strikeAt = Math.max(0.05, (this.config.attackStrike ?? DEFAULT_ATTACK_STRIKE) / timeScale);
    return Math.min(1, this.stateTimer / strikeAt);
  }

  update(delta: number, playerPosition: THREE.Vector3, playerAlive: boolean): void {
    if (!this.alive) {
      this.rig.update(delta);
      return;
    }

    this.cooldown = Math.max(0, this.cooldown - delta);
    this.toPlayer.copy(playerPosition).sub(this.position).setY(0);
    const distance = this.toPlayer.length();

    if (this.hurtTimer > 0) {
      this.hurtTimer -= delta;
      this.stateTimer += delta;
      if (this.hurtTimer <= 0) this.state = 'chase';
    } else {
      switch (this.state) {
        case 'idle':
          if (playerAlive && distance < this.config.aggroRadius) {
            this.state = 'chase';
            this.stateTimer = 0;
          } else {
            this.patrol(delta);
          }
          break;

        case 'chase':
          if (!playerAlive) {
            this.state = 'idle';
            break;
          }
          if (distance < this.config.attackRange && this.cooldown <= 0) {
            this.state = 'attack';
            this.stateTimer = 0;
            this.attackLanded = false;
            this.rig.animator.play(this.config.attackClip ?? DEFAULT_ATTACK_CLIP, {
              once: true,
              fade: 0.1,
              timeScale: this.config.attackTimeScale ?? 1,
              clamp: true,
            });
          } else {
            // Approach on a shallow arc rather than a dead-straight line, so two
            // skeletons do not stack on the same track into the player's back.
            this.chaseTarget.copy(playerPosition);
            if (distance > this.config.attackRange + 1.4 && distance > 0.001) {
              const nx = this.toPlayer.x / distance;
              const nz = this.toPlayer.z / distance;
              this.chaseTarget.x += -nz * this.flankSign * 1.2;
              this.chaseTarget.z += nx * this.flankSign * 1.2;
            }
            this.moveToward(this.chaseTarget, this.config.speed, delta);
          }
          break;

        case 'attack': {
          const clip = this.config.attackClip ?? DEFAULT_ATTACK_CLIP;
          const timeScale = this.config.attackTimeScale ?? 1;
          const strikeAt = (this.config.attackStrike ?? DEFAULT_ATTACK_STRIKE) / timeScale;
          const authored = this.rig.animator.clipDuration(clip);
          const duration = Math.max(0.35, (authored || 1.0) / timeScale);

          this.stateTimer += delta;
          if (this.stateTimer < strikeAt * 0.85) this.face(playerPosition, delta, 10);

          if (!this.attackLanded && this.stateTimer >= strikeAt) {
            this.attackLanded = true;
            // Re-check range and frontal arc at impact, not at windup.
            const forwardX = Math.sin(this.yaw);
            const forwardZ = Math.cos(this.yaw);
            const inFront =
              distance < 0.001 ||
              (this.toPlayer.x * forwardX + this.toPlayer.z * forwardZ) / distance > 0;
            // A wall or trunk between the two stops the blow, exactly like it
            // stops the camera and target selection.
            const clear = hasLineOfSight(
              this.position.x,
              this.position.y + CHEST,
              this.position.z,
              playerPosition.x,
              playerPosition.y + CHEST,
              playerPosition.z,
              this.world.obstacles,
            );

            if (distance < this.config.attackRange + 0.55 && inFront && playerAlive && clear) {
              this.onHitPlayer?.(this.config.damage, this.position, this);
            }
          }

          if (this.stateTimer >= duration) {
            // Jittered recovery so a group does not swing in lockstep, and the
            // gap between attacks stays readable.
            this.cooldown = this.config.attackCooldown * (0.9 + Math.random() * 0.35);
            this.state = 'chase';
            this.stateTimer = 0;
          }
          break;
        }

        default:
          break;
      }
    }

    if (this.state === 'chase') this.face(playerPosition, delta, 8);

    this.updateAnimation();

    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    this.rig.update(delta);
  }

  takeDamage(amount: number, from: THREE.Vector3): boolean {
    if (!this.alive) return false;

    this.health = Math.max(0, this.health - amount);
    this.rig.flash(0.16, 1);

    const knockback = this.position.clone().sub(from).setY(0);
    if (knockback.lengthSq() > 0.0001) {
      knockback.normalize().multiplyScalar(1.5);
      this.position.add(knockback);
      this.position.y = this.world.heightAt(this.position.x, this.position.z);
    }

    if (this.health <= 0) {
      this.die();
      return true;
    }

    this.state = 'hurt';
    this.hurtTimer = 0.32;
    this.stateTimer = 0;
    this.rig.animator.play('Hit_A', { once: true, fade: 0.06, clamp: true });
    return true;
  }

  reset(): void {
    this.alive = true;
    this.health = this.config.maxHealth;
    this.state = 'idle';
    this.stateTimer = 0;
    this.cooldown = 0;
    this.hurtTimer = 0;
    this.attackLanded = false;
    this.position.copy(this.home);
    this.yaw = Math.PI;
    this.rig.animator.play('Idle_A', { fade: 0.1 });
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
  }

  private die(): void {
    this.alive = false;
    this.state = 'dead';
    this.rig.animator.play('Death_A', { once: true, fade: 0.1, clamp: true });
  }

  private patrol(delta: number): void {
    this.patrolTimer -= delta;
    if (this.patrolTimer <= 0) {
      this.patrolTimer = 3 + Math.random() * 3;
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * PATROL_RADIUS;
      this.patrolTarget.set(
        this.home.x + Math.cos(angle) * radius,
        0,
        this.home.z + Math.sin(angle) * radius,
      );
    }

    this.moveToward(this.patrolTarget, this.config.speed * 0.35, delta);
    if (this.speed > 0.05) this.face(this.patrolTarget, delta, 6);
  }

  private moveToward(target: THREE.Vector3, speed: number, delta: number): void {
    this.direction.copy(target).sub(this.position).setY(0);
    const distance = this.direction.length();

    // Stop a body-width short so enemies cannot stand inside the player.
    const stopAt = target === this.patrolTarget ? 0.4 : 1.5;
    if (distance <= stopAt) {
      this.speed = 0;
      return;
    }

    this.direction.normalize();
    this.position.addScaledVector(this.direction, speed * delta);

    // Enemies are pushed out of walls and pillars by the same helper as the
    // player, so neither can occupy solid geometry.
    resolveBlockers(this.position, this.world.blockers, BODY_RADIUS);
    this.position.y = this.world.heightAt(this.position.x, this.position.z);
    this.speed = speed;

    const limit = ARENA.radius - 2;
    const radial = Math.hypot(this.position.x, this.position.z);
    if (radial > limit) {
      this.position.x *= limit / radial;
      this.position.z *= limit / radial;
    }
  }

  private face(target: THREE.Vector3, delta: number, rate: number): void {
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    if (Math.hypot(dx, dz) < 0.01) return;

    const targetYaw = Math.atan2(dx, dz);
    let difference = targetYaw - this.yaw;
    difference = Math.atan2(Math.sin(difference), Math.cos(difference));
    this.yaw += difference * (1 - Math.exp(-rate * delta));
  }

  private updateAnimation(): void {
    if (this.state === 'chase' && this.speed > 0.1) {
      const timeScale = Math.max(0.8, this.speed / 2.4);

      // They face the player while circling, so the legs travel sideways;
      // the pack's strafe run reads far better there than a forward walk.
      const forwardDot =
        Math.sin(this.yaw) * this.direction.x + Math.cos(this.yaw) * this.direction.z;
      if (this.speed > 1.2 && forwardDot < 0.55) {
        const rightDot =
          -Math.cos(this.yaw) * this.direction.x + Math.sin(this.yaw) * this.direction.z;
        this.rig.animator.play(rightDot >= 0 ? 'Running_Strafe_Right' : 'Running_Strafe_Left', {
          fade: 0.18,
          timeScale,
        });
        return;
      }

      this.rig.animator.play(this.speed > 2 ? 'Running_A' : 'Walking_A', {
        fade: 0.18,
        timeScale,
      });
      return;
    }

    if (this.state === 'attack' || this.state === 'hurt') return;

    if (this.state === 'idle' && this.speed > 0.05) {
      this.rig.animator.play('Walking_A', { fade: 0.2, timeScale: 0.7 });
      return;
    }

    this.rig.animator.play('Idle_A', { fade: 0.25 });
  }
}
