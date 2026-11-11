import * as THREE from 'three';
import { CAMERA } from './config';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Elevated 3/4 orbit camera: drag to rotate, wheel or pinch to zoom, keys as an alternative. */
export class OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;

  private yaw = CAMERA.yaw;
  private pitch = CAMERA.pitch;
  private distance = CAMERA.distance;

  private targetYaw = CAMERA.yaw;
  private targetPitch = CAMERA.pitch;
  private targetDistance = CAMERA.distance;

  private readonly target = new THREE.Vector3(...CAMERA.target);
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;
  /** Extra pull-back so the island fits narrow (portrait) viewports. */
  private fitScale = 1;

  constructor(private readonly canvas: HTMLCanvasElement, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);
    this.setAspect(aspect);
    this.positionCamera();
    this.attach();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();

    // Fit the island's footprint into the narrower of the two field-of-view axes.
    const verticalHalf = (CAMERA.fov * Math.PI) / 360;
    const horizontalHalf = Math.atan(Math.tan(verticalHalf) * aspect);
    const fitDistance = CAMERA.fitRadius / Math.sin(Math.min(verticalHalf, horizontalHalf));
    this.fitScale = Math.min(2.1, Math.max(1, fitDistance / CAMERA.distance));
  }

  update(delta: number): void {
    const smoothing = 1 - Math.exp(-delta * 11);
    this.yaw += (this.targetYaw - this.yaw) * smoothing;
    this.pitch += (this.targetPitch - this.pitch) * smoothing;
    this.distance += (this.targetDistance - this.distance) * smoothing;
    this.positionCamera();
  }

  reset(): void {
    this.targetYaw = CAMERA.yaw;
    this.targetPitch = CAMERA.pitch;
    this.targetDistance = CAMERA.distance;
  }

  private positionCamera(): void {
    const cosPitch = Math.cos(this.pitch);
    const distance = this.distance * this.fitScale;
    this.camera.position.set(
      this.target.x + distance * cosPitch * Math.sin(this.yaw),
      this.target.y + distance * Math.sin(this.pitch),
      this.target.z + distance * cosPitch * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.target);
  }

  private attach(): void {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2) this.pinchDistance = this.currentPinch();
    });

    canvas.addEventListener('pointermove', (event) => {
      const previous = this.pointers.get(event.pointerId);
      if (!previous) return;

      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (this.pointers.size >= 2) {
        const pinch = this.currentPinch();
        if (this.pinchDistance > 0 && pinch > 0) {
          this.targetDistance = clamp(
            this.targetDistance * (this.pinchDistance / pinch),
            CAMERA.minDistance,
            CAMERA.maxDistance,
          );
        }
        this.pinchDistance = pinch;
        return;
      }

      this.targetYaw -= dx * 0.0055;
      this.targetPitch = clamp(this.targetPitch - dy * 0.0042, CAMERA.minPitch, CAMERA.maxPitch);
    });

    const release = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinchDistance = 0;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.targetDistance = clamp(
          this.targetDistance * Math.exp(event.deltaY * 0.0011),
          CAMERA.minDistance,
          CAMERA.maxDistance,
        );
      },
      { passive: false },
    );

    window.addEventListener('keydown', (event) => {
      switch (event.key) {
        case 'ArrowLeft':
        case 'a':
        case 'A':
          this.targetYaw += 0.16;
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          this.targetYaw -= 0.16;
          break;
        case 'ArrowUp':
        case 'w':
        case 'W':
          this.targetPitch = clamp(this.targetPitch + 0.08, CAMERA.minPitch, CAMERA.maxPitch);
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          this.targetPitch = clamp(this.targetPitch - 0.08, CAMERA.minPitch, CAMERA.maxPitch);
          break;
        case '+':
        case '=':
          this.targetDistance = clamp(this.targetDistance * 0.9, CAMERA.minDistance, CAMERA.maxDistance);
          break;
        case '-':
        case '_':
          this.targetDistance = clamp(this.targetDistance * 1.1, CAMERA.minDistance, CAMERA.maxDistance);
          break;
        case 'r':
        case 'R':
          this.reset();
          break;
        default:
          break;
      }
    });
  }

  private currentPinch(): number {
    const [first, second] = [...this.pointers.values()];
    if (!first || !second) return 0;
    return Math.hypot(first.x - second.x, first.y - second.y);
  }
}
