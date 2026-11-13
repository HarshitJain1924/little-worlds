import * as THREE from 'three';
import type { CameraObstacle } from './collision';
import {
  contactPointBox,
  contactPointCylinder,
  contactPointGround,
  segmentBoxEntry,
  segmentCylinderEntry,
} from './collision';
import type { ProjectileField, ProjectileTarget } from './projectiles';
import { ARROW_BODY } from './projectiles';

/**
 * One ray, solved against the same world a real arrow flies through.
 *
 * This exists so the reticle cannot lie: the preview calls exactly this, and so
 * does the shot that leaves the bow. Body proxies, obstacle proxies, ground and
 * range come from the projectile module's own constants, and enemy hits use the
 * full-length segment test rather than a sampled point, so a body cannot be
 * "near the reticle" and still register.
 *
 * No scene raycast, no allocation: `out` is the only thing written.
 */

export type AimKind = 'enemy' | 'obstacle' | 'ground' | 'range';

export interface AimSolution {
  kind: AimKind;
  /** Body that the ray actually enters, or null for geometry and thin air. */
  target: ProjectileTarget | null;
  /** Metres along the ray to `out`. */
  distance: number;
}

/** Terrain refinement: coarse march, then a short bisection. */
const GROUND_STEP = 1;
const GROUND_REFINE = 6;

const cylinder = {
  kind: 'cylinder' as const,
  x: 0,
  z: 0,
  radius: ARROW_BODY.radius,
  bottom: 0,
  top: 0,
};

/**
 * @param out receives the impact (or range-limit) point, in the same space as
 * `origin` — world space at the call sites.
 */
export function solveShot(
  origin: Readonly<THREE.Vector3>,
  direction: Readonly<THREE.Vector3>,
  field: ProjectileField,
  targets: readonly ProjectileTarget[],
  maxRange: number,
  out: THREE.Vector3,
  radius = 0,
): AimSolution {
  const dirY = direction.y;

  // Obstacles and bodies are tested along the whole ray: no sampling, so no
  // tunnelling and no difference from the per-frame segments the pool uses.
  let hitT = 1;
  let kind: AimKind = 'range';
  let struck: ProjectileTarget | null = null;
  let struckObstacle: CameraObstacle | null = null;

  const toX = origin.x + direction.x * maxRange;
  const toY = origin.y + direction.y * maxRange;
  const toZ = origin.z + direction.z * maxRange;

  const obstaclePadding = Math.max(0.02, radius);
  for (const obstacle of field.obstacles) {
    const t =
      obstacle.kind === 'box'
        ? segmentBoxEntry(origin.x, origin.y, origin.z, toX, toY, toZ, obstacle, obstaclePadding)
        : segmentCylinderEntry(origin.x, origin.y, origin.z, toX, toY, toZ, obstacle, obstaclePadding);
    if (t < hitT) {
      hitT = t;
      kind = 'obstacle';
      struckObstacle = obstacle;
    }
  }

  for (const target of targets) {
    if (!target.alive) continue;

    cylinder.x = target.position.x;
    cylinder.z = target.position.z;
    cylinder.bottom = target.position.y + ARROW_BODY.bottom;
    cylinder.top = target.position.y + ARROW_BODY.top;
    cylinder.radius = ARROW_BODY.radius;

    const targetT = segmentCylinderEntry(
      origin.x,
      origin.y,
      origin.z,
      toX,
      toY,
      toZ,
      cylinder,
      radius,
    );
    // Ties go to the body, exactly as in the projectile pool.
    if (targetT <= hitT && targetT < 1) {
      hitT = targetT;
      kind = 'enemy';
      struck = target;
      struckObstacle = null;
    }
  }

  // Terrain has no proxy. March the ray and bisect the first descending
  // crossing; the projectile stops on the same crossing when it gets there.
  if (dirY < -1e-4) {
    const limit = hitT * maxRange;
    let previous = 0;
    for (let distance = GROUND_STEP; distance <= limit; distance += GROUND_STEP) {
      if (origin.y + dirY * distance > field.heightAt(origin.x + direction.x * distance, origin.z + direction.z * distance) + radius) {
        previous = distance;
        continue;
      }

      let low = previous;
      let high = distance;
      for (let i = 0; i < GROUND_REFINE; i += 1) {
        const middle = (low + high) * 0.5;
        const x = origin.x + direction.x * middle;
        const z = origin.z + direction.z * middle;
        if (origin.y + dirY * middle <= field.heightAt(x, z) + radius) high = middle;
        else low = middle;
      }

      const groundT = high / maxRange;
      if (groundT < hitT) {
        hitT = groundT;
        kind = 'ground';
        struck = null;
        struckObstacle = null;
      }
      break;
    }
  }

  const distance = hitT * maxRange;
  out.copy(origin).addScaledVector(direction, distance);
  if (radius > 0 && kind !== 'range') {
    if (kind === 'ground') {
      const groundY = field.heightAt(out.x, out.z);
      contactPointGround(out.x, out.z, groundY, out);
    } else if (kind === 'obstacle' && struckObstacle) {
      if (struckObstacle.kind === 'box') {
        contactPointBox(out.x, out.y, out.z, struckObstacle, out);
      } else {
        contactPointCylinder(out.x, out.y, out.z, struckObstacle, out);
      }
    } else if (kind === 'enemy' && struck) {
      cylinder.x = struck.position.x;
      cylinder.z = struck.position.z;
      cylinder.bottom = struck.position.y + ARROW_BODY.bottom;
      cylinder.top = struck.position.y + ARROW_BODY.top;
      cylinder.radius = ARROW_BODY.radius;
      contactPointCylinder(out.x, out.y, out.z, cylinder, out);
    }
  }

  return { kind, target: kind === 'enemy' ? struck : null, distance };
}
