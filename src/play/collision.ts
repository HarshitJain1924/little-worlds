/**
 * Cheap analytic collision used by the camera and by line-of-sight checks.
 *
 * The scene is not raycast: the world registers a small set of convex proxies
 * (boxes for walls, pillars and crates, vertical cylinders for tree trunks), and
 * every query is a closed-form segment/volume test. Cost is O(proxies) with no
 * allocation, so it can run every frame and for each candidate target.
 */

export interface BoxObstacle {
  kind: 'box';
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  bottom: number;
  top: number;
}

export interface CylinderObstacle {
  kind: 'cylinder';
  x: number;
  z: number;
  radius: number;
  bottom: number;
  top: number;
}

export type CameraObstacle = BoxObstacle | CylinderObstacle;

const EPSILON = 1e-6;

/**
 * Entry parameter t in [0,1] along from->to, or 1 when the segment never enters
 * the volume. Starting inside the volume yields 0.
 */
export function segmentBoxEntry(
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
  box: BoxObstacle,
  padding = 0,
): number {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dz = toZ - fromZ;

  let entry = 0;
  let exit = 1;

  // Slab test, unrolled over scalars: this runs for every camera boom and every
  // attack line-of-sight check, so it allocates nothing.
  for (let axis = 0; axis < 3; axis += 1) {
    let origin: number;
    let delta: number;
    let min: number;
    let max: number;

    if (axis === 0) {
      origin = fromX;
      delta = dx;
      min = box.minX - padding;
      max = box.maxX + padding;
    } else if (axis === 1) {
      origin = fromY;
      delta = dy;
      min = box.bottom - padding;
      max = box.top + padding;
    } else {
      origin = fromZ;
      delta = dz;
      min = box.minZ - padding;
      max = box.maxZ + padding;
    }

    if (Math.abs(delta) < EPSILON) {
      if (origin < min || origin > max) return 1;
      continue;
    }

    let near = (min - origin) / delta;
    let far = (max - origin) / delta;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }

    if (near > entry) entry = near;
    if (far < exit) exit = far;
    if (entry > exit) return 1;
  }

  return entry;
}

/** Same contract as segmentBoxEntry, for a vertical cylinder. */
export function segmentCylinderEntry(
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
  cylinder: CylinderObstacle,
  padding = 0,
): number {
  const radius = cylinder.radius + padding;
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const ox = fromX - cylinder.x;
  const oz = fromZ - cylinder.z;

  const a = dx * dx + dz * dz;
  const c = ox * ox + oz * oz - radius * radius;

  let t: number;
  if (a < EPSILON) {
    if (c > 0) return 1;
    t = 0;
  } else if (c <= 0) {
    // Already inside the footprint.
    t = 0;
  } else {
    const b = 2 * (ox * dx + oz * dz);
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return 1;
    t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t < 0 || t > 1) return 1;
  }

  // The segment may clear the trunk by passing above it.
  const y = fromY + (toY - fromY) * t;
  if (y < cylinder.bottom - padding || y > cylinder.top + padding) {
    // No entry at that height: the first contact is past the top, so treat the
    // volume as clear for camera purposes.
    return 1;
  }

  return t;
}

/** Nearest blocking t along the segment, 1 when the path is clear. */
export function nearestObstruction(
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
  obstacles: readonly CameraObstacle[],
  padding = 0,
): number {
  let nearest = 1;

  for (const obstacle of obstacles) {
    const t =
      obstacle.kind === 'box'
        ? segmentBoxEntry(fromX, fromY, fromZ, toX, toY, toZ, obstacle, padding)
        : segmentCylinderEntry(fromX, fromY, fromZ, toX, toY, toZ, obstacle, padding);
    if (t < nearest) nearest = t;
  }

  return nearest;
}

/**
 * Line of sight between two points, ignoring obstacles that both ends are
 * already inside (the camera often sits on the far side of nothing).
 */
export interface PlanarBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Pushes a ground-plane position out of any blocker it overlaps, along the
 * shallowest escape axis. Shared by the player and enemies so both respect the
 * same walls, pillars and crates.
 */
export function resolveBlockers(
  position: { x: number; z: number },
  blockers: readonly PlanarBox[],
  radius: number,
): void {
  for (const blocker of blockers) {
    if (
      position.x < blocker.minX - radius ||
      position.x > blocker.maxX + radius ||
      position.z < blocker.minZ - radius ||
      position.z > blocker.maxZ + radius
    ) {
      continue;
    }

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

export function hasLineOfSight(
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
  obstacles: readonly CameraObstacle[],
  padding = 0,
): boolean {
  // nearestObstruction returns 1 for a clear path; anything less means a proxy
  // sits between the two points.
  return nearestObstruction(fromX, fromY, fromZ, toX, toY, toZ, obstacles, padding) >= 1;
}
