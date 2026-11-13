import * as THREE from 'three';
import type { CameraObstacle } from './collision';
import { nearestObstruction, segmentCylinderEntry } from './collision';

/**
 * Pooled arrow projectiles.
 *
 * Deliberately independent of the player controller and of enemy AI: anything
 * with a position and a `takeDamage` method can be hit, and the only world data
 * used is the same small set of analytic collision proxies the camera and
 * targeting already test against. No scene raycasts, no per-frame allocation.
 *
 * Flight is a straight segment per update. Collision is tested against the whole
 * segment rather than the end point, so an arrow travelling 5 m in one long
 * frame cannot tunnel through a body or a wall.
 */

export interface ProjectileTarget {
  readonly position: { x: number; y: number; z: number };
  readonly alive: boolean;
  takeDamage(amount: number, from: { x: number; y: number; z: number }): boolean;
}

export interface ProjectileField {
  readonly obstacles: readonly CameraObstacle[];
  heightAt: (x: number, z: number) => number;
}

/** Shared geometry and material for every arrow in the pool. */
export interface ArrowVisual {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface Shot {
  origin: Readonly<THREE.Vector3>;
  /** Unit direction of travel. */
  direction: Readonly<THREE.Vector3>;
  speed: number;
  damage: number;
  maxRange: number;
}

export type ImpactKind = 'target' | 'obstacle' | 'ground' | 'expired';

export interface Impact {
  kind: ImpactKind;
  /** Impact point. Reused between calls — copy it if it is kept. */
  position: THREE.Vector3;
  damage: number;
  /** The body that was struck, or null for geometry and timeouts. */
  target: ProjectileTarget | null;
}

/** Half of the authored arrow's length: the mesh origin sits at its middle. */
export const ARROW_HALF_LENGTH = 0.63;
/**
 * Body proxy an arrow can hit, in metres around the target's feet. Shared with
 * the aim preview so the reticle and the real flight agree by construction.
 */
export const ARROW_BODY = { radius: 0.5, bottom: 0.15, top: 1.8 } as const;
const DEFAULT_CAPACITY = 16;
const FORWARD = new THREE.Vector3(0, 0, 1);

interface Arrow {
  mesh: THREE.Mesh;
  readonly tip: THREE.Vector3;
  readonly direction: THREE.Vector3;
  active: boolean;
  speed: number;
  damage: number;
  maxRange: number;
  travelled: number;
}

export class ProjectilePool {
  private readonly arrows: Arrow[] = [];
  private readonly group = new THREE.Group();
  private readonly field: ProjectileField;
  private readonly visual: ArrowVisual;
  private readonly position = new THREE.Vector3();
  private readonly next = new THREE.Vector3();
  private readonly cylinder = {
    kind: 'cylinder' as const,
    x: 0,
    z: 0,
    radius: ARROW_BODY.radius,
    bottom: 0,
    top: 0,
  };

  constructor(scene: THREE.Scene, field: ProjectileField, visual: ArrowVisual, capacity = DEFAULT_CAPACITY) {
    this.field = field;
    this.visual = visual;
    this.group.name = 'projectiles';
    scene.add(this.group);

    for (let i = 0; i < capacity; i += 1) {
      const mesh = new THREE.Mesh(visual.geometry, visual.material);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this.arrows.push({
        mesh,
        tip: new THREE.Vector3(),
        direction: new THREE.Vector3(),
        active: false,
        speed: 0,
        damage: 0,
        maxRange: 0,
        travelled: 0,
      });
    }
  }

  get activeCount(): number {
    let count = 0;
    for (const arrow of this.arrows) if (arrow.active) count += 1;
    return count;
  }

  /**
   * Fires an arrow. Returns false only when every slot is somehow unavailable,
   * which the recycling rule below makes practically impossible.
   */
  spawn(shot: Shot): boolean {
    const arrow = this.arrows.find((entry) => !entry.active) ?? this.farthest();
    if (!arrow) return false;

    arrow.active = true;
    arrow.travelled = 0;
    arrow.speed = shot.speed;
    arrow.damage = shot.damage;
    arrow.maxRange = shot.maxRange;
    arrow.direction.copy(shot.direction).normalize();
    arrow.tip.copy(shot.origin);

    arrow.mesh.visible = true;
    arrow.mesh.quaternion.setFromUnitVectors(FORWARD, arrow.direction);
    this.place(arrow);
    return true;
  }

  /**
   * Advances every arrow, resolving at most one impact each. `onImpact` runs
   * after damage has been applied, so it can read the target's new state.
   */
  update(delta: number, targets: readonly ProjectileTarget[], onImpact: (impact: Impact) => void): void {
    if (delta <= 0) return;

    for (const arrow of this.arrows) {
      if (!arrow.active) continue;

      const remaining = arrow.maxRange - arrow.travelled;
      if (remaining <= 0) {
        this.retire(arrow);
        onImpact({ kind: 'expired', position: arrow.tip, damage: arrow.damage, target: null });
        continue;
      }

      const step = Math.min(arrow.speed * delta, remaining);
      this.position.copy(arrow.tip);
      this.next.copy(this.position).addScaledVector(arrow.direction, step);

      // Nearest blocking feature along this segment: world proxy, body or ground.
      let hitT = 1;
      let kind: ImpactKind = 'expired';
      let struck: ProjectileTarget | null = null;

      const obstacleT = nearestObstruction(
        this.position.x,
        this.position.y,
        this.position.z,
        this.next.x,
        this.next.y,
        this.next.z,
        this.field.obstacles,
        0.02,
      );
      if (obstacleT < hitT) {
        hitT = obstacleT;
        kind = 'obstacle';
      }

      for (const target of targets) {
        if (!target.alive) continue;

        this.cylinder.x = target.position.x;
        this.cylinder.z = target.position.z;
        this.cylinder.bottom = target.position.y + ARROW_BODY.bottom;
        this.cylinder.top = target.position.y + ARROW_BODY.top;

        const targetT = segmentCylinderEntry(
          this.position.x,
          this.position.y,
          this.position.z,
          this.next.x,
          this.next.y,
          this.next.z,
          this.cylinder,
          0,
        );
        // Ties go to the body, so an arrow grazing a crate still finds the hit.
        if (targetT <= hitT && targetT < 1) {
          hitT = targetT;
          kind = 'target';
          struck = target;
        }
      }

      const ground = this.field.heightAt(this.next.x, this.next.z);
      if (this.next.y <= ground && this.position.y > this.next.y) {
        const groundT = (this.position.y - ground) / (this.position.y - this.next.y);
        if (groundT < hitT) {
          hitT = groundT;
          kind = 'ground';
          struck = null;
        }
      }

      if (hitT < 1) {
        arrow.tip.lerpVectors(this.position, this.next, hitT);
        arrow.travelled += step * hitT;

        if (kind === 'target' && struck) struck.takeDamage(arrow.damage, this.position);

        this.place(arrow);
        this.retire(arrow);
        onImpact({ kind, position: arrow.tip, damage: arrow.damage, target: struck });
        continue;
      }

      arrow.tip.copy(this.next);
      arrow.travelled += step;
      this.place(arrow);
    }
  }

  clear(): void {
    for (const arrow of this.arrows) this.retire(arrow);
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.group.clear();
    this.arrows.length = 0;
    this.visual.geometry.dispose();
    this.visual.material.dispose();
  }

  private place(arrow: Arrow): void {
    // The authored model is centred on its origin with the head at +z.
    arrow.mesh.position.copy(arrow.tip).addScaledVector(arrow.direction, -ARROW_HALF_LENGTH);
  }

  private retire(arrow: Arrow): void {
    arrow.active = false;
    arrow.mesh.visible = false;
  }

  private farthest(): Arrow | undefined {
    let chosen: Arrow | undefined;
    for (const arrow of this.arrows) {
      if (!chosen || arrow.travelled > chosen.travelled) chosen = arrow;
    }
    return chosen;
  }
}
