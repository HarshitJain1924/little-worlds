import * as THREE from 'three';
import type { CameraObstacle } from './collision';
import { nearestObstruction } from './collision';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export interface CameraBounds {
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
}

export interface CameraOptions {
  obstacles?: readonly CameraObstacle[];
  heightAt?: (x: number, z: number) => number;
}

/** How far the camera may be swung sideways while a target is locked. */
const LOCK_YAW_LIMIT = 1.0;
/** How fast a manual lock offset relaxes back to the framing angle. */
const LOCK_RECENTER_RATE = 0.3;
const RECENTER_DELAY = 1.2;
/**
 * Recentering only follows travel within this angle of the view direction, so
 * backpedalling (180 degrees) and strafing (90) never drag the camera around.
 */
const RECENTER_MAX_ANGLE = 1.0;

/**
 * Third-person action camera.
 *
 * Yaw and pitch are independent and driven by pointer-lock mouse movement; the
 * boom is traced against the world's collision proxies so walls and trunks pull
 * the camera in immediately and release it smoothly. When a target is locked the
 * rig frames both characters while still accepting a limited manual orbit.
 */
export class ThirdPersonCamera {
  readonly camera: THREE.PerspectiveCamera;

  /** Radians of rotation per pixel of mouse movement. */
  sensitivity = 0.0026;

  yaw = 0;
  pitch = 0.32;

  private targetYaw = 0;
  private targetPitch = 0.32;

  /** Player-chosen follow distance (wheel), before lock/zoom multipliers. */
  private followDistance = 8.2;
  private zoomScale = 1;
  private boom = 8.2;
  private boomCurrent = 8.2;

  private readonly focus = new THREE.Vector3();
  private readonly focusTarget = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();

  private readonly obstacles: readonly CameraObstacle[];
  private readonly heightAt: (x: number, z: number) => number;

  private lockTarget: { x: number; z: number } | null = null;
  private lockYawOffset = 0;
  private timeSinceLook = RECENTER_DELAY;

  private shakeAmount = 0;
  private shakeTime = 0;

  readonly bounds: CameraBounds = {
    minDistance: 3.2,
    maxDistance: 12,
    minPitch: -0.35,
    maxPitch: 1.15,
  };

  /** Height of the focus point above the character's feet. */
  readonly eyeHeight = 1.5;

  constructor(aspect: number, options: CameraOptions = {}) {
    // Far plane sits beyond the sky dome (radius 420) so the gradient is not clipped.
    this.camera = new THREE.PerspectiveCamera(48, aspect, 0.2, 640);
    this.obstacles = options.obstacles ?? [];
    this.heightAt = options.heightAt ?? (() => 0);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  get distance(): number {
    return this.boomCurrent;
  }

  get isLocked(): boolean {
    return this.lockTarget !== null;
  }

  /** Mouse-look. `dx`/`dy` are raw pixels from pointer lock. */
  rotate(dx: number, dy: number): void {
    this.timeSinceLook = 0;

    if (this.lockTarget) {
      // Orbiting is allowed, but only within a sensible arc around the target.
      this.lockYawOffset = clamp(
        this.lockYawOffset - dx * this.sensitivity,
        -LOCK_YAW_LIMIT,
        LOCK_YAW_LIMIT,
      );
      this.targetPitch = clamp(
        this.targetPitch + dy * this.sensitivity * 0.8,
        this.bounds.minPitch,
        this.bounds.maxPitch,
      );
      return;
    }

    this.targetYaw -= dx * this.sensitivity;
    this.targetPitch = clamp(
      this.targetPitch + dy * this.sensitivity * 0.8,
      this.bounds.minPitch,
      this.bounds.maxPitch,
    );
  }

  /** Jump the rig to an angle immediately (used by the scripted test hooks). */
  snap(yaw: number, pitch?: number): void {
    this.yaw = yaw;
    this.targetYaw = yaw;
    this.lockYawOffset = 0;
    if (pitch !== undefined) {
      this.pitch = pitch;
      this.targetPitch = pitch;
    }
    this.boomCurrent = this.boom;
  }

  /** Wheel zoom, expressed as a scroll delta. */
  zoom(amount: number): void {
    this.zoomScale = clamp(this.zoomScale * Math.exp(amount), 0.6, 1.65);
  }

  /** Hard lock framing; null restores free camera behaviour. */
  setLockTarget(target: { x: number; z: number } | null): void {
    if (target === null) {
      this.lockYawOffset = 0;
    } else if (this.lockTarget === null) {
      this.lockYawOffset = 0;
      // Swinging into lock should not feel like a teleport.
      this.targetYaw = Math.atan2(
        -(target.x - this.focus.x),
        -(target.z - this.focus.z),
      );
    }
    this.lockTarget = target;
  }

  shake(amount: number): void {
    this.shakeAmount = Math.min(0.42, this.shakeAmount + amount);
  }

  /** Camera-relative movement basis, flattened to the ground plane. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
  }

  update(delta: number, player: THREE.Vector3, velocity?: { x: number; z: number }): void {
    this.timeSinceLook += delta;

    const smoothing = 1 - Math.exp(-delta * 12);

    if (this.lockTarget) {
      const desiredYaw = Math.atan2(
        -(this.lockTarget.x - player.x),
        -(this.lockTarget.z - player.z),
      );
      this.targetYaw = desiredYaw + this.lockYawOffset;

      // Relax a manual orbit back to the framing angle once the mouse settles.
      if (this.timeSinceLook > 0.8) {
        this.lockYawOffset *= Math.exp(-LOCK_RECENTER_RATE * delta);
      }

      const separation = Math.hypot(this.lockTarget.x - player.x, this.lockTarget.z - player.z);
      this.boom = clamp(
        clamp(4.2 + separation * 0.42, 3.8, 9.5) * this.zoomScale,
        this.bounds.minDistance,
        this.bounds.maxDistance,
      );
    } else {
      // Gentle recentering: after a pause without looking, the camera drifts
      // behind the direction of travel instead of fixing the player's back.
      if (this.timeSinceLook > RECENTER_DELAY && velocity) {
        const speed = Math.hypot(velocity.x, velocity.z);
        if (speed > 0.8) {
          const travelYaw = Math.atan2(-velocity.x, -velocity.z);
          let difference = travelYaw - this.targetYaw;
          difference = Math.atan2(Math.sin(difference), Math.cos(difference));

          // Only drift in behind forward travel. Backing up or strafing points
          // the travel vector away from the view, and following it would swing
          // the camera around (which also flips what S means) — a spin loop.
          if (Math.abs(difference) < RECENTER_MAX_ANGLE) {
            this.targetYaw += difference * (1 - Math.exp(-1.6 * delta));
          }
        }
      }
      this.boom = clamp(
        this.followDistance * this.zoomScale,
        this.bounds.minDistance,
        this.bounds.maxDistance,
      );
    }

    // Interpolate through the shortest arc, so a target on the far side of the
    // -PI / +PI seam turns one way instead of spinning all the way around.
    const yawStep = Math.atan2(
      Math.sin(this.targetYaw - this.yaw),
      Math.cos(this.targetYaw - this.yaw),
    );
    this.yaw += yawStep * smoothing;
    this.pitch += (this.targetPitch - this.pitch) * smoothing;

    // Follow the character's chest, not their feet, so the head stays framed.
    this.focusTarget.set(player.x, player.y + this.eyeHeight, player.z);

    if (this.lockTarget) {
      // Bias the framing point toward the enemy so both stay in shot.
      this.focusTarget.x += (this.lockTarget.x - player.x) * 0.22;
      this.focusTarget.z += (this.lockTarget.z - player.z) * 0.22;
      this.focusTarget.y += 0.15;
    }

    this.focus.lerp(this.focusTarget, 1 - Math.exp(-delta * 14));

    const cosPitch = Math.cos(this.pitch);
    const dirX = Math.sin(this.yaw) * cosPitch;
    const dirY = Math.sin(this.pitch);
    const dirZ = Math.cos(this.yaw) * cosPitch;

    this.desired.set(
      this.focus.x + dirX * this.boom,
      this.focus.y + dirY * this.boom,
      this.focus.z + dirZ * this.boom,
    );

    // Trace the boom against wall boxes and tree trunks: pull in at once, ease
    // back out only after the path is clear again.
    const obstruction = nearestObstruction(
      this.focus.x,
      this.focus.y,
      this.focus.z,
      this.desired.x,
      this.desired.y,
      this.desired.z,
      this.obstacles,
      0.32,
    );

    const allowed = obstruction < 1
      ? Math.max(0.9, this.boom * obstruction - 0.15)
      : this.boom;

    if (allowed < this.boomCurrent) {
      this.boomCurrent = allowed;
    } else {
      this.boomCurrent += (allowed - this.boomCurrent) * (1 - Math.exp(-delta * 4.5));
    }

    const boomCos = Math.cos(this.pitch);
    this.camera.position.set(
      this.focus.x + Math.sin(this.yaw) * boomCos * this.boomCurrent,
      this.focus.y + Math.sin(this.pitch) * this.boomCurrent,
      this.focus.z + Math.cos(this.yaw) * boomCos * this.boomCurrent,
    );

    // Never let the camera sink into the terrain, wherever it ended up.
    const ground = this.heightAt(this.camera.position.x, this.camera.position.z) + 0.45;
    if (this.camera.position.y < ground) this.camera.position.y = ground;

    if (this.shakeAmount > 0.001) {
      this.shakeTime += delta * 38;
      const wobble = this.shakeAmount * 0.5;
      this.camera.position.x += Math.sin(this.shakeTime) * wobble;
      this.camera.position.y += Math.cos(this.shakeTime * 1.7) * wobble;
      this.shakeAmount *= Math.exp(-delta * 7);
    }

    this.camera.lookAt(this.focus);
  }
}
