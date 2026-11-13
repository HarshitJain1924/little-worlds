import * as THREE from 'three';
import { nearestObstruction, segmentCylinderEntry } from './collision';
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

  const obstaclePadding = Math.max(0.02, radius);
  const obstacleT = nearestObstruction(
    origin.x,
    origin.y,
    origin.z,
    origin.x + direction.x * maxRange,
    origin.y + direction.y * maxRange,
    origin.z + direction.z * maxRange,
    field.obstacles,
    obstaclePadding,
  );
  if (obstacleT < hitT) {
    hitT = obstacleT;
    kind = 'obstacle';
  }

  for (const target of targets) {
    if (!target.alive) continue;

    cylinder.x = target.position.x;
    cylinder.z = target.position.z;
    cylinder.bottom = target.position.y + ARROW_BODY.bottom;
    cylinder.top = target.position.y + ARROW_BODY.top;

    const targetT = segmentCylinderEntry(
      origin.x,
      origin.y,
      origin.z,
      origin.x + direction.x * maxRange,
      origin.y + direction.y * maxRange,
      origin.z + direction.z * maxRange,
      cylinder,
      radius,
    );
    // Ties go to the body, exactly as in the projectile pool.
    if (targetT <= hitT && targetT < 1) {
      hitT = targetT;
      kind = 'enemy';
      struck = target;
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
      }
      break;
    }
  }

  const distance = hitT * maxRange;
  out.copy(origin).addScaledVector(direction, distance);
  if (radius > 0 && kind !== 'range') {
    if (kind === 'ground') {
      out.y = field.heightAt(out.x, out.z);
    } else {
      out.addScaledVector(direction, radius);
    }
  }

  return { kind, target: kind === 'enemy' ? struck : null, distance };
}
