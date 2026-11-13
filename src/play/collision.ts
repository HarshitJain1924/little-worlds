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
  bottom?: number;
  top?: number;
  minY?: number;
  maxY?: number;
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
 * Helper to test entry into a cylinder edge of a Minkowski-expanded AABB.
 * Edge is parallel to axis W, situated at (edgeU, edgeV) in the other two coordinates.
 */
function intersectEdge(
  fromU: number,
  fromV: number,
  fromW: number,
  du: number,
  dv: number,
  dw: number,
  edgeU: number,
  edgeV: number,
  minW: number,
  maxW: number,
  isMinU: boolean,
  boundU: number,
  isMinV: boolean,
  boundV: number,
  radius: number,
  bestT: number,
): number {
  const d2 = du * du + dv * dv;
  if (d2 < EPSILON) return bestT;

  const ou = fromU - edgeU;
  const ov = fromV - edgeV;
  const b = 2 * (ou * du + ov * dv);
  if (b >= 0) return bestT;

  const c = ou * ou + ov * ov - radius * radius;
  if (c < 0) return bestT;

  const disc = b * b - 4 * d2 * c;
  if (disc < -1e-9) return bestT;

  const safeDisc = Math.max(0, disc);
  const t = (-b - Math.sqrt(safeDisc)) / (2 * d2);
  if (t < 0 || t >= bestT) return bestT;

  const w = fromW + dw * t;
  if (w < minW - EPSILON || w > maxW + EPSILON) return bestT;

  const u = fromU + du * t;
  const v = fromV + dv * t;
  if (isMinU ? u > boundU + EPSILON : u < boundU - EPSILON) return bestT;
  if (isMinV ? v > boundV + EPSILON : v < boundV - EPSILON) return bestT;

  return t;
}

/**
 * Helper to test entry into a corner sphere of a Minkowski-expanded AABB.
 */
function intersectCorner(
  fromX: number,
  fromY: number,
  fromZ: number,
  dx: number,
  dy: number,
  dz: number,
  dLen2: number,
  cx: number,
  cy: number,
  cz: number,
  isMinX: boolean,
  boundX: number,
  isMinY: boolean,
  boundY: number,
  isMinZ: boolean,
  boundZ: number,
  radius: number,
  bestT: number,
): number {
  const ox = fromX - cx;
  const oy = fromY - cy;
  const oz = fromZ - cz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  if (b >= 0) return bestT;

  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c < 0) return bestT;

  const disc = b * b - 4 * dLen2 * c;
  if (disc < -1e-9) return bestT;

  const safeDisc = Math.max(0, disc);
  const t = (-b - Math.sqrt(safeDisc)) / (2 * dLen2);
  if (t < 0 || t >= bestT) return bestT;

  const x = fromX + dx * t;
  const y = fromY + dy * t;
  const z = fromZ + dz * t;
  if (isMinX ? x > boundX + EPSILON : x < boundX - EPSILON) return bestT;
  if (isMinY ? y > boundY + EPSILON : y < boundY - EPSILON) return bestT;
  if (isMinZ ? z > boundZ + EPSILON : z < boundZ - EPSILON) return bestT;

  return t;
}

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

  const boxBottom = box.bottom ?? box.minY ?? 0;
  const boxTop = box.top ?? box.maxY ?? 0;

  if (padding <= 0) {
    let entry = 0;
    let exit = 1;

    for (let axis = 0; axis < 3; axis += 1) {
      let origin: number;
      let delta: number;
      let min: number;
      let max: number;

      if (axis === 0) {
        origin = fromX;
        delta = dx;
        min = box.minX;
        max = box.maxX;
      } else if (axis === 1) {
        origin = fromY;
        delta = dy;
        min = boxBottom;
        max = boxTop;
      } else {
        origin = fromZ;
        delta = dz;
        min = box.minZ;
        max = box.maxZ;
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

  // Exact continuous swept-sphere vs AABB (Minkowski sum with sphere of radius R).
  const R = padding;

  // Check if start point is already inside or touching the Minkowski sum
  const cx = Math.max(box.minX, Math.min(box.maxX, fromX));
  const cy = Math.max(boxBottom, Math.min(boxTop, fromY));
  const cz = Math.max(box.minZ, Math.min(box.maxZ, fromZ));
  const ox = fromX - cx;
  const oy = fromY - cy;
  const oz = fromZ - cz;
  if (ox * ox + oy * oy + oz * oz <= R * R + 1e-10) {
    return 0;
  }

  const dLen2 = dx * dx + dy * dy + dz * dz;
  if (dLen2 < 1e-12) {
    return 1;
  }

  // Slab test on the outer bounding box ([min - R, max + R]) for early rejection
  let entry = 0;
  let exit = 1;
  let entryAxis = -1;

  // X slab
  if (Math.abs(dx) < EPSILON) {
    if (fromX < box.minX - R || fromX > box.maxX + R) return 1;
  } else {
    let near = (box.minX - R - fromX) / dx;
    let far = (box.maxX + R - fromX) / dx;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > entry) {
      entry = near;
      entryAxis = 0;
    }
    if (far < exit) exit = far;
    if (entry > exit) return 1;
  }

  // Y slab
  if (Math.abs(dy) < EPSILON) {
    if (fromY < boxBottom - R || fromY > boxTop + R) return 1;
  } else {
    let near = (boxBottom - R - fromY) / dy;
    let far = (boxTop + R - fromY) / dy;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > entry) {
      entry = near;
      entryAxis = 1;
    }
    if (far < exit) exit = far;
    if (entry > exit) return 1;
  }

  // Z slab
  if (Math.abs(dz) < EPSILON) {
    if (fromZ < box.minZ - R || fromZ > box.maxZ + R) return 1;
  } else {
    let near = (box.minZ - R - fromZ) / dz;
    let far = (box.maxZ + R - fromZ) / dz;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > entry) {
      entry = near;
      entryAxis = 2;
    }
    if (far < exit) exit = far;
    if (entry > exit) return 1;
  }

  if (entry > exit || entry > 1 || exit < 0) return 1;

  // If entry point lands on one of the 6 flat rectangular faces of the Minkowski sum:
  if (entryAxis >= 0 && entry >= 0 && entry <= 1) {
    const hx = fromX + dx * entry;
    const hy = fromY + dy * entry;
    const hz = fromZ + dz * entry;
    if (entryAxis === 0) {
      if (
        hy >= boxBottom - EPSILON &&
        hy <= boxTop + EPSILON &&
        hz >= box.minZ - EPSILON &&
        hz <= box.maxZ + EPSILON
      ) {
        return entry;
      }
    } else if (entryAxis === 1) {
      if (
        hx >= box.minX - EPSILON &&
        hx <= box.maxX + EPSILON &&
        hz >= box.minZ - EPSILON &&
        hz <= box.maxZ + EPSILON
      ) {
        return entry;
      }
    } else if (entryAxis === 2) {
      if (
        hx >= box.minX - EPSILON &&
        hx <= box.maxX + EPSILON &&
        hy >= boxBottom - EPSILON &&
        hy <= boxTop + EPSILON
      ) {
        return entry;
      }
    }
  }

  // Otherwise, the entry must be on one of the 12 edge cylinders or 8 corner spheres.
  let bestT = 1;

  // 4 Edges parallel to Z (u = X, v = Y, w = Z)
  bestT = intersectEdge(fromX, fromY, fromZ, dx, dy, dz, box.minX, boxBottom, box.minZ, box.maxZ, true, box.minX, true, boxBottom, R, bestT);
  bestT = intersectEdge(fromX, fromY, fromZ, dx, dy, dz, box.minX, boxTop, box.minZ, box.maxZ, true, box.minX, false, boxTop, R, bestT);
  bestT = intersectEdge(fromX, fromY, fromZ, dx, dy, dz, box.maxX, boxBottom, box.minZ, box.maxZ, false, box.maxX, true, boxBottom, R, bestT);
  bestT = intersectEdge(fromX, fromY, fromZ, dx, dy, dz, box.maxX, boxTop, box.minZ, box.maxZ, false, box.maxX, false, boxTop, R, bestT);

  // 4 Edges parallel to X (u = Y, v = Z, w = X)
  bestT = intersectEdge(fromY, fromZ, fromX, dy, dz, dx, boxBottom, box.minZ, box.minX, box.maxX, true, boxBottom, true, box.minZ, R, bestT);
  bestT = intersectEdge(fromY, fromZ, fromX, dy, dz, dx, boxBottom, box.maxZ, box.minX, box.maxX, true, boxBottom, false, box.maxZ, R, bestT);
  bestT = intersectEdge(fromY, fromZ, fromX, dy, dz, dx, boxTop, box.minZ, box.minX, box.maxX, false, boxTop, true, box.minZ, R, bestT);
  bestT = intersectEdge(fromY, fromZ, fromX, dy, dz, dx, boxTop, box.maxZ, box.minX, box.maxX, false, boxTop, false, box.maxZ, R, bestT);

  // 4 Edges parallel to Y (u = X, v = Z, w = Y)
  bestT = intersectEdge(fromX, fromZ, fromY, dx, dz, dy, box.minX, box.minZ, boxBottom, boxTop, true, box.minX, true, box.minZ, R, bestT);
  bestT = intersectEdge(fromX, fromZ, fromY, dx, dz, dy, box.minX, box.maxZ, boxBottom, boxTop, true, box.minX, false, box.maxZ, R, bestT);
  bestT = intersectEdge(fromX, fromZ, fromY, dx, dz, dy, box.maxX, box.minZ, boxBottom, boxTop, false, box.maxX, true, box.minZ, R, bestT);
  bestT = intersectEdge(fromX, fromZ, fromY, dx, dz, dy, box.maxX, box.maxZ, boxBottom, boxTop, false, box.maxX, false, box.maxZ, R, bestT);

  // 8 Corners
  bestT = intersectCorner(fromX, fromY, fromZ, dx, dy, dz, dLen2, box.minX, boxBottom, box.minZ, true, box.minX, true, boxBottom, true, box.minZ, R, bestT);
  bestT = intersectCorner(fromX, fromY, fromZ, dx, dy, dz, dLen2, box.minX, boxBottom, box.maxZ, true, box.minX, true, boxBottom, false, box.maxZ, R, bestT);
  bestT = intersectCorner(fromX, fromY, fromZ, dx, dy, dz, dLen2, box.minX, boxTop, box.minZ, true, box.minX, false, boxTop, true, box.minZ, R, bestT);
  bestT = intersectCorner(fromX, fromY, fromZ, dx, dy, dz, dLen2, box.minX, boxTop, box.maxZ, true, box.minX, false, boxTop, false, box.maxZ, R, bestT);
  bestT = intersectCorner(fromX, fromY, fromZ, dx, dy, dz, dLen2, box.maxX, boxBottom, box.minZ, false, box.maxX, true, boxBottom, true, box.minZ, R, bestT);
  bestT = intersectCorner(fromX, fromY, fromZ, dx, dy, dz, dLen2, box.maxX, boxBottom, box.maxZ, false, box.maxX, true, boxBottom, false, box.maxZ, R, bestT);
  bestT = intersectCorner(fromX, fromY, fromZ, dx, dy, dz, dLen2, box.maxX, boxTop, box.minZ, false, box.maxX, false, boxTop, true, box.minZ, R, bestT);
  bestT = intersectCorner(fromX, fromY, fromZ, dx, dy, dz, dLen2, box.maxX, boxTop, box.maxZ, false, box.maxX, false, boxTop, false, box.maxZ, R, bestT);

  return bestT;
}

/**
 * Squared 3D distance from a point along a segment to a cylinder rim circle.
 */
function rimDistSq(
  t: number,
  h2: number,
  h1: number,
  h0: number,
  p0y: number,
  dy: number,
  Rc: number,
): number {
  const u = h2 * t * t + h1 * t + h0;
  const deltaH = Math.sqrt(Math.max(0, u)) - Rc;
  const y = p0y + dy * t;
  return deltaH * deltaH + y * y;
}

/**
 * Derivative of squared distance to the rim circle with respect to parameter t.
 * This is used only on intervals where the horizontal clamp is inactive
 * (sqrt(u) >= Rc), where the distance function is convex.
 */
function rimFPrime(
  t: number,
  h2: number,
  h1: number,
  h0: number,
  d2: number,
  p0DotD: number,
  Rc: number,
): number {
  const u = Math.max(1e-30, h2 * t * t + h1 * t + h0);
  const sqrtU = Math.sqrt(u);
  const uPrime = 2 * h2 * t + h1;
  const wPrime = 2 * (d2 * t + p0DotD);
  return wPrime - Rc * (uPrime / sqrtU);
}

function addQuadraticRoots(
  roots: number[],
  a: number,
  b: number,
  c: number,
  low: number,
  high: number,
): void {
  if (Math.abs(a) < 1e-14) {
    if (Math.abs(b) >= 1e-14) {
      const t = -c / b;
      if (t > low && t < high) roots.push(t);
    }
    return;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return;
  const sqrtDiscriminant = Math.sqrt(Math.max(0, discriminant));
  const t1 = (-b - sqrtDiscriminant) / (2 * a);
  const t2 = (-b + sqrtDiscriminant) / (2 * a);
  if (t1 > low && t1 < high) roots.push(t1);
  if (t2 > low && t2 < high && Math.abs(t2 - t1) > 1e-14) roots.push(t2);
}

/**
 * Exact continuous swept-sphere vs cylinder rim quarter-torus intersection.
 * Finds the earliest parameter t in [tIn, tOut] where distance to the rim circle is <= R.
 * Splits the interval at every change in the active distance region. On each
 * rounded-rim interval, the squared distance is convex because rho >= Rc;
 * derivative bisection therefore finds that interval's global minimum, after
 * which a second bracket finds the earliest threshold crossing.
 */
function intersectCylinderRim(
  fromX: number,
  fromY: number,
  fromZ: number,
  dx: number,
  dy: number,
  dz: number,
  cylX: number,
  cylZ: number,
  Rc: number,
  yCap: number,
  capSide: 1 | -1,
  R: number,
  tIn: number,
  tOut: number,
): number {
  const p0x = fromX - cylX;
  const p0z = fromZ - cylZ;
  const p0y = fromY - yCap;

  const h2 = dx * dx + dz * dz;
  const h1 = 2 * (p0x * dx + p0z * dz);
  const h0 = p0x * p0x + p0z * p0z;

  const d2 = dx * dx + dy * dy + dz * dz;
  const p0DotD = p0x * dx + p0y * dy + p0z * dz;

  const low = tIn;
  const high = tOut;
  const radiusSq = Rc * Rc;
  const thresholdSq = R * R;
  const roots = [low, high];

  // The formula with the horizontal clamp changes at rho = Rc. The cap-side
  // formula changes at y = 0 relative to the selected rim circle.
  addQuadraticRoots(roots, h2, h1, h0 - radiusSq, low, high);
  if (Math.abs(dy) >= 1e-14) {
    const capCrossing = -p0y / dy;
    if (capCrossing > low && capCrossing < high) roots.push(capCrossing);
  }
  roots.sort((a, b) => a - b);

  const uniqueRoots: number[] = [];
  for (const root of roots) {
    if (uniqueRoots.length === 0 || Math.abs(root - uniqueRoots[uniqueRoots.length - 1]) > 1e-13) {
      uniqueRoots.push(root);
    }
  }

  const isRimRegion = (t: number): boolean => {
    const u = h2 * t * t + h1 * t + h0;
    const y = p0y + dy * t;
    return u >= radiusSq - 1e-12 && capSide * y >= -1e-12;
  };

  // Check exact region boundaries as they are reached. This includes a
  // tangent that occurs exactly at a clamp transition, while preserving the
  // earliest contact from the preceding interval.
  if (
    isRimRegion(uniqueRoots[0]) &&
    rimDistSq(uniqueRoots[0], h2, h1, h0, p0y, dy, Rc) <= thresholdSq + 1e-10
  ) {
    return uniqueRoots[0];
  }
  for (let interval = 0; interval + 1 < uniqueRoots.length; interval += 1) {
    const a = uniqueRoots[interval];
    const b = uniqueRoots[interval + 1];
    const mid = (a + b) * 0.5;
    if (!isRimRegion(mid)) {
      if (
        isRimRegion(b) &&
        rimDistSq(b, h2, h1, h0, p0y, dy, Rc) <= thresholdSq + 1e-10
      ) {
        return b;
      }
      continue;
    }

    const fPrimeA = rimFPrime(a, h2, h1, h0, d2, p0DotD, Rc);
    const fPrimeB = rimFPrime(b, h2, h1, h0, d2, p0DotD, Rc);
    let tStar: number;
    if (fPrimeA >= 0) {
      tStar = a;
    } else if (fPrimeB <= 0) {
      tStar = b;
    } else {
      let left = a;
      let right = b;
      for (let i = 0; i < 64; i += 1) {
        const candidate = (left + right) * 0.5;
        if (rimFPrime(candidate, h2, h1, h0, d2, p0DotD, Rc) <= 0) left = candidate;
        else right = candidate;
      }
      tStar = (left + right) * 0.5;
    }

    if (rimDistSq(tStar, h2, h1, h0, p0y, dy, Rc) > thresholdSq + 1e-10) {
      if (
        isRimRegion(b) &&
        rimDistSq(b, h2, h1, h0, p0y, dy, Rc) <= thresholdSq + 1e-10
      ) {
        return b;
      }
      continue;
    }

    let left = a;
    if (rimDistSq(left, h2, h1, h0, p0y, dy, Rc) <= thresholdSq + 1e-10) return left;
    let right = tStar;
    for (let i = 0; i < 64; i += 1) {
      const candidate = (left + right) * 0.5;
      if (rimDistSq(candidate, h2, h1, h0, p0y, dy, Rc) <= thresholdSq + 1e-10) right = candidate;
      else left = candidate;
    }
    return right;
  }

  return 1;
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
  const R = Math.max(0, padding);
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dz = toZ - fromZ;

  // Step 1: Distance check for start point
  const ox = fromX - cylinder.x;
  const oz = fromZ - cylinder.z;
  const dXZ = Math.hypot(ox, oz);
  const deltaH = Math.max(0, dXZ - cylinder.radius);
  let deltaV = 0;
  if (fromY > cylinder.top) deltaV = fromY - cylinder.top;
  else if (fromY < cylinder.bottom) deltaV = cylinder.bottom - fromY;

  const startDistSq = deltaH * deltaH + deltaV * deltaV;
  if (startDistSq <= R * R + 1e-10) {
    return 0;
  }

  const dLen2 = dx * dx + dy * dy + dz * dz;
  if (dLen2 < 1e-12) {
    return 1;
  }

  // Step 2: Unrounded bounding cylinder slab test (radius = cylinder.radius + R, vertical = [bottom - R, top + R])
  const Rside = cylinder.radius + R;
  const yMin = cylinder.bottom - R;
  const yMax = cylinder.top + R;

  let tVin = 0;
  let tVout = 1;
  if (Math.abs(dy) < EPSILON) {
    if (fromY < yMin - EPSILON || fromY > yMax + EPSILON) return 1;
  } else {
    let t1 = (yMin - fromY) / dy;
    let t2 = (yMax - fromY) / dy;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tVin) tVin = t1;
    if (t2 < tVout) tVout = t2;
    if (tVin > tVout) return 1;
  }

  const a = dx * dx + dz * dz;
  let tHin = 0;
  let tHout = 1;
  if (a < EPSILON) {
    const c = ox * ox + oz * oz - Rside * Rside;
    if (c > EPSILON) return 1;
  } else {
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - Rside * Rside;
    const disc = b * b - 4 * a * c;
    if (disc < -1e-9) return 1;
    const safeDisc = Math.max(0, disc);
    const sqrtDisc = Math.sqrt(safeDisc);
    tHin = (-b - sqrtDisc) / (2 * a);
    tHout = (-b + sqrtDisc) / (2 * a);
  }

  const tIn = Math.max(tVin, tHin);
  const tOut = Math.min(tVout, tHout);

  if (tIn > tOut + EPSILON || tOut < -EPSILON || tIn > 1 + EPSILON) return 1;

  // If padding is 0, the bounding cylinder is the exact cylinder.
  if (R <= 0) {
    return Math.max(0, tIn);
  }

  // With padding > 0:
  const clampIn = Math.max(0, tIn);
  const clampOut = Math.min(1, tOut);
  if (clampIn > clampOut) return 1;

  // Check if entry point is on the uncurved cylindrical side
  if (tIn >= tVin - EPSILON && tIn <= tVout + EPSILON) {
    const yAtEntry = fromY + dy * tIn;
    if (yAtEntry >= cylinder.bottom - EPSILON && yAtEntry <= cylinder.top + EPSILON) {
      return clampIn;
    }
  }

  // Check if entry point is on the flat top or bottom cap
  if (tIn >= tHin - EPSILON && tIn <= tHout + EPSILON) {
    const xAtEntry = fromX + dx * tIn - cylinder.x;
    const zAtEntry = fromZ + dz * tIn - cylinder.z;
    if (xAtEntry * xAtEntry + zAtEntry * zAtEntry <= cylinder.radius * cylinder.radius + EPSILON) {
      return clampIn;
    }
  }

  // If entry point lands on the rounded torus rim:
  // Determine which rim was approached and solve exact continuous collision:
  const yAtEntry = fromY + dy * clampIn;
  const primaryCap = yAtEntry >= cylinder.top ? cylinder.top : cylinder.bottom;

  let tRim = intersectCylinderRim(
    fromX,
    fromY,
    fromZ,
    dx,
    dy,
    dz,
    cylinder.x,
    cylinder.z,
    cylinder.radius,
    primaryCap,
    primaryCap === cylinder.top ? 1 : -1,
    R,
    clampIn,
    clampOut,
  );

  if (tRim === 1) {
    const secondaryCap = primaryCap === cylinder.top ? cylinder.bottom : cylinder.top;
    tRim = intersectCylinderRim(
      fromX,
      fromY,
      fromZ,
      dx,
      dy,
      dz,
      cylinder.x,
      cylinder.z,
      cylinder.radius,
      secondaryCap,
      secondaryCap === cylinder.top ? 1 : -1,
      R,
      clampIn,
      clampOut,
    );
  }

  return tRim;
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

/**
 * Calculates the contact point on the surface of a box obstacle closest to a query point (e.g. sphere center).
 * If the point is outside, orthogonal projection clamps it to the nearest surface point.
 * If the point is strictly inside, it is pushed to the closest face along the shallowest escape axis.
 */
export function contactPointBox(
  pointX: number,
  pointY: number,
  pointZ: number,
  box: BoxObstacle,
  out: { x: number; y: number; z: number },
): void {
  const boxBottom = box.bottom ?? box.minY ?? 0;
  const boxTop = box.top ?? box.maxY ?? 0;

  if (
    pointX >= box.minX &&
    pointX <= box.maxX &&
    pointY >= boxBottom &&
    pointY <= boxTop &&
    pointZ >= box.minZ &&
    pointZ <= box.maxZ
  ) {
    const dMinX = pointX - box.minX;
    const dMaxX = box.maxX - pointX;
    const dBottom = pointY - boxBottom;
    const dTop = boxTop - pointY;
    const dMinZ = pointZ - box.minZ;
    const dMaxZ = box.maxZ - pointZ;
    const minDistance = Math.min(dMinX, dMaxX, dBottom, dTop, dMinZ, dMaxZ);

    out.x = pointX;
    out.y = pointY;
    out.z = pointZ;

    if (minDistance === dMinX) out.x = box.minX;
    else if (minDistance === dMaxX) out.x = box.maxX;
    else if (minDistance === dBottom) out.y = boxBottom;
    else if (minDistance === dTop) out.y = boxTop;
    else if (minDistance === dMinZ) out.z = box.minZ;
    else out.z = box.maxZ;
    return;
  }

  out.x = Math.max(box.minX, Math.min(box.maxX, pointX));
  out.y = Math.max(boxBottom, Math.min(boxTop, pointY));
  out.z = Math.max(box.minZ, Math.min(box.maxZ, pointZ));
}

/**
 * Calculates the contact point on the surface of a vertical cylinder obstacle closest to a query point.
 * If the point is outside, clamps horizontally to the cylinder perimeter and vertically to [bottom, top].
 * If the point is strictly inside, pushes to the closest boundary (side wall or top/bottom cap).
 */
export function contactPointCylinder(
  pointX: number,
  pointY: number,
  pointZ: number,
  cylinder: CylinderObstacle,
  out: { x: number; y: number; z: number },
): void {
  const dx = pointX - cylinder.x;
  const dz = pointZ - cylinder.z;
  const d = Math.hypot(dx, dz);

  if (d <= cylinder.radius && pointY >= cylinder.bottom && pointY <= cylinder.top) {
    const dWall = cylinder.radius - d;
    const dBottom = pointY - cylinder.bottom;
    const dTop = cylinder.top - pointY;
    const minDistance = Math.min(dWall, dBottom, dTop);

    if (minDistance === dBottom) {
      out.x = pointX;
      out.y = cylinder.bottom;
      out.z = pointZ;
      return;
    }
    if (minDistance === dTop) {
      out.x = pointX;
      out.y = cylinder.top;
      out.z = pointZ;
      return;
    }
    const scale = d > 1e-6 ? cylinder.radius / d : 1;
    out.x = cylinder.x + (d > 1e-6 ? dx * scale : cylinder.radius);
    out.y = pointY;
    out.z = cylinder.z + (d > 1e-6 ? dz * scale : 0);
    return;
  }

  const scale = d > 1e-6 ? Math.min(d, cylinder.radius) / d : 0;
  out.x = cylinder.x + dx * scale;
  out.y = Math.max(cylinder.bottom, Math.min(cylinder.top, pointY));
  out.z = cylinder.z + dz * scale;
}

/**
 * Projects a point onto the terrain ground height at that (x, z) coordinate.
 */
export function contactPointGround(
  pointX: number,
  pointZ: number,
  groundY: number,
  out: { x: number; y: number; z: number },
): void {
  out.x = pointX;
  out.y = groundY;
  out.z = pointZ;
}
