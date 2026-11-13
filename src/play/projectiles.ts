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

export type ProjectileKind = 'arrow' | 'magicLight' | 'magicHeavy';

export interface ProjectileVisual {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  offset?: number;
}

/** Shared geometry and material for every arrow in the pool. */
export type ArrowVisual = ProjectileVisual;
export type ProjectileVisualMap = Partial<Record<ProjectileKind, ProjectileVisual>>;

export interface Shot {
  origin: Readonly<THREE.Vector3>;
  /** Unit direction of travel. */
  direction: Readonly<THREE.Vector3>;
  speed: number;
  damage: number;
  maxRange: number;
  kind?: ProjectileKind;
}

export type ImpactKind = 'target' | 'obstacle' | 'ground' | 'expired';

export interface Impact {
  kind: ImpactKind;
  shotKind: ProjectileKind;
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
  meshes: Map<ProjectileKind, THREE.Mesh>;
  activeMesh: THREE.Mesh | null;
  kind: ProjectileKind;
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
  private readonly visuals = new Map<ProjectileKind, ProjectileVisual>();
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

  constructor(
    scene: THREE.Scene,
    field: ProjectileField,
    visual: ProjectileVisual | ProjectileVisualMap,
    capacity = DEFAULT_CAPACITY,
  ) {
    this.field = field;
    this.group.name = 'projectiles';
    scene.add(this.group);

    const isSingle = 'geometry' in visual;
    if (isSingle) {
      this.visuals.set('arrow', {
        geometry: visual.geometry,
        material: visual.material,
        offset: visual.offset ?? -ARROW_HALF_LENGTH,
      });
    } else {
      for (const [k, v] of Object.entries(visual) as [ProjectileKind, ProjectileVisual | undefined][]) {
        if (!v) continue;
        const defaultOffset = k === 'arrow' ? -ARROW_HALF_LENGTH : 0;
        this.visuals.set(k, {
          geometry: v.geometry,
          material: v.material,
          offset: v.offset ?? defaultOffset,
        });
      }
    }

    if (!this.visuals.has('arrow')) {
      const fallback = this.visuals.values().next().value;
      if (fallback) this.visuals.set('arrow', fallback);
    }

    for (let i = 0; i < capacity; i += 1) {
      const meshes = new Map<ProjectileKind, THREE.Mesh>();
      for (const [kind, def] of this.visuals) {
        const mesh = new THREE.Mesh(def.geometry, def.material);
        mesh.visible = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        this.group.add(mesh);
        meshes.set(kind, mesh);
      }

      this.arrows.push({
        meshes,
        activeMesh: null,
        kind: 'arrow',
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
   * Fires a projectile. Returns false only when every slot is somehow unavailable,
   * which the recycling rule below makes practically impossible.
   */
  spawn(shot: Shot): boolean {
    const arrow = this.arrows.find((entry) => !entry.active) ?? this.farthest();
    if (!arrow) return false;

    // When recycling an active slot (or changing kinds), ensure all previous meshes are hidden
    for (const mesh of arrow.meshes.values()) {
      mesh.visible = false;
    }
    arrow.activeMesh = null;

    const kind = shot.kind ?? 'arrow';
    arrow.kind = kind;
    arrow.active = true;
    arrow.travelled = 0;
    arrow.speed = shot.speed;
    arrow.damage = shot.damage;
    arrow.maxRange = shot.maxRange;
    arrow.direction.copy(shot.direction).normalize();
    arrow.tip.copy(shot.origin);

    const activeMesh = arrow.meshes.get(kind) ?? arrow.meshes.get('arrow');
    if (activeMesh) {
      arrow.activeMesh = activeMesh;
      activeMesh.visible = true;
      activeMesh.quaternion.setFromUnitVectors(FORWARD, arrow.direction);
      this.place(arrow);
    }
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
        onImpact({
          kind: 'expired',
          shotKind: arrow.kind,
          position: arrow.tip,
          damage: arrow.damage,
          target: null,
        });
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
        onImpact({
          kind,
          shotKind: arrow.kind,
          position: arrow.tip,
          damage: arrow.damage,
          target: struck,
        });
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
    for (const visual of this.visuals.values()) {
      visual.geometry.dispose();
      visual.material.dispose();
    }
    this.visuals.clear();
  }

  private place(arrow: Arrow): void {
    const visual = this.visuals.get(arrow.kind) ?? this.visuals.get('arrow');
    const offset = visual?.offset ?? 0;
    if (arrow.activeMesh) {
      arrow.activeMesh.position.copy(arrow.tip).addScaledVector(arrow.direction, offset);
    }
  }

  private retire(arrow: Arrow): void {
    arrow.active = false;
    for (const mesh of arrow.meshes.values()) {
      mesh.visible = false;
    }
    arrow.activeMesh = null;
  }

  private farthest(): Arrow | undefined {
    let chosen: Arrow | undefined;
    for (const arrow of this.arrows) {
      if (!chosen || arrow.travelled > chosen.travelled) chosen = arrow;
    }
    return chosen;
  }
}
