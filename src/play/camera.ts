import * as THREE from 'three';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export interface CameraBounds {
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
}

/**
 * Third-person follow camera. Yaw/pitch come from drag input, the rig is damped
 * toward the character, and the boom shortens when the ground would occlude it.
 */
export class ThirdPersonCamera {
  readonly camera: THREE.PerspectiveCamera;

  /** Sits opposite the character's facing, so the player is seen from behind. */
  yaw = 0;
  pitch = 0.34;

  private targetYaw = 0;
  private targetPitch = 0.34;
  private targetDistance = 7.6;
  private distance = 7.6;
  private currentBoom = 7.6;

  private readonly focus = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private shakeAmount = 0;
  private shakeTime = 0;

  readonly bounds: CameraBounds = {
    minDistance: 3.2,
    maxDistance: 11,
    minPitch: -0.22,
    maxPitch: 1.05,
  };

  constructor(aspect: number) {
    // Far plane sits beyond the sky dome (radius 420) so the gradient is not clipped.
    this.camera = new THREE.PerspectiveCamera(48, aspect, 0.2, 640);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  rotate(dx: number, dy: number): void {
    this.targetYaw -= dx * 0.0055;
    this.targetPitch = clamp(this.targetPitch + dy * 0.0042, this.bounds.minPitch, this.bounds.maxPitch);
  }

  /** Jump the rig to an angle immediately (used by the scripted test hooks). */
  snap(yaw: number, pitch?: number): void {
    this.yaw = yaw;
    this.targetYaw = yaw;
    if (pitch !== undefined) {
      this.pitch = pitch;
      this.targetPitch = pitch;
    }
  }

  zoom(amount: number): void {
    this.targetDistance = clamp(
      this.targetDistance * Math.exp(amount),
      this.bounds.minDistance,
      this.bounds.maxDistance,
    );
  }

  shake(amount: number): void {
    this.shakeAmount = Math.min(0.42, this.shakeAmount + amount);
  }

  /** Camera-relative movement basis, flattened to the ground plane. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
  }

  update(
    delta: number,
    player: THREE.Vector3,
    heightAt: (x: number, z: number) => number,
  ): void {
    const smoothing = 1 - Math.exp(-delta * 12);
    this.yaw += (this.targetYaw - this.yaw) * smoothing;
    this.pitch += (this.targetPitch - this.pitch) * smoothing;
    this.distance += (this.targetDistance - this.distance) * smoothing;

    // Follow the character's chest, not their feet, so the head stays framed.
    const focusTarget = this.probe.set(player.x, player.y + 1.55, player.z);
    this.focus.lerp(focusTarget, 1 - Math.exp(-delta * 14));

    const cosPitch = Math.cos(this.pitch);
    this.desired.set(
      this.focus.x + Math.sin(this.yaw) * cosPitch * this.distance,
      this.focus.y + Math.sin(this.pitch) * this.distance,
      this.focus.z + Math.cos(this.yaw) * cosPitch * this.distance,
    );

    // Pull the boom in when the ground would come between camera and player.
    let allowed = this.distance;
    for (let step = 1; step <= 6; step += 1) {
      const t = step / 6;
      this.probe.lerpVectors(this.focus, this.desired, t);
      const floor = heightAt(this.probe.x, this.probe.z) + 0.55;
      if (this.probe.y < floor) {
        allowed = Math.max(this.bounds.minDistance * 0.55, this.distance * t - 0.6);
        break;
      }
    }

    this.currentBoom += (allowed - this.currentBoom) * (1 - Math.exp(-delta * 18));

    const boomCos = Math.cos(this.pitch);
    this.camera.position.set(
      this.focus.x + Math.sin(this.yaw) * boomCos * this.currentBoom,
      this.focus.y + Math.sin(this.pitch) * this.currentBoom,
      this.focus.z + Math.cos(this.yaw) * boomCos * this.currentBoom,
    );

    const ground = heightAt(this.camera.position.x, this.camera.position.z) + 0.5;
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
