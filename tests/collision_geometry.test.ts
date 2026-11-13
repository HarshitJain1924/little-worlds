import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { BoxObstacle, CameraObstacle, CylinderObstacle } from '../src/play/collision.ts';
import {
  contactPointBox,
  contactPointCylinder,
  segmentBoxEntry,
  segmentCylinderEntry,
} from '../src/play/collision.ts';
import { solveShot } from '../src/play/aim.ts';
import type { Impact, ProjectileField, ProjectileTarget } from '../src/play/projectiles.ts';
import { ARROW_BODY, ProjectilePool } from '../src/play/projectiles.ts';

const FLAT: ProjectileField = { obstacles: [], heightAt: () => 0 };

function dummyVisual(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  return {
    geometry: new THREE.SphereGeometry(0.48),
    material: new THREE.MeshBasicMaterial(),
  };
}

function makeTarget(x: number, z: number, y = 0): ProjectileTarget & { hits: number; lastHitPos: THREE.Vector3 | null } {
  return {
    position: { x, y, z },
    alive: true,
    hits: 0,
    lastHitPos: null,
    takeDamage(_damage: number, impactPoint?: { x: number; y: number; z: number }): boolean {
      this.hits += 1;
      if (impactPoint) this.lastHitPos = new THREE.Vector3(impactPoint.x, impactPoint.y, impactPoint.z);
      return true;
    },
  };
}

// -----------------------------------------------------------------------------
// 1. Exact Swept Sphere vs AABB (Box Obstacle)
// -----------------------------------------------------------------------------

test('Exact swept sphere vs AABB: face impact calculates exact entry time and contact point', () => {
  const box: BoxObstacle = {
    kind: 'box',
    minX: -2,
    maxX: 2,
    minZ: -10,
    maxZ: -5,
    bottom: 0,
    top: 4,
  };

  const radius = 0.48;
  // Head-on shot along -Z from (0, 2, 0) towards z = -20
  // Minkowski face is at maxZ + radius = -5 + 0.48 = -4.52
  const from = new THREE.Vector3(0, 2, 0);
  const to = new THREE.Vector3(0, 2, -10);
  const t = segmentBoxEntry(from.x, from.y, from.z, to.x, to.y, to.z, box, radius);

  // Travel distance is 10m, so entry at z = -4.52 is t = 4.52 / 10 = 0.452
  assert.ok(Math.abs(t - 0.452) < 1e-5, `Expected t=0.452, got ${t}`);

  const hitPos = new THREE.Vector3().lerpVectors(from, to, t);
  const contact = { x: 0, y: 0, z: 0 };
  contactPointBox(hitPos.x, hitPos.y, hitPos.z, box, contact);

  assert.equal(contact.x, 0);
  assert.equal(contact.y, 2);
  assert.equal(contact.z, -5); // Front face
});

test('Exact swept sphere vs AABB: corner clearance when 3D distance exceeds radius', () => {
  // Box starts at minX = 1.0, maxX = 5.0, from z = -10.5 to z = -9.5
  const wall: BoxObstacle = {
    kind: 'box',
    minX: 1.0,
    maxX: 5.0,
    minZ: -10.5,
    maxZ: -9.5,
    bottom: 0,
    top: 5.0,
  };

  const radius = 0.48;
  // Projectile travels parallel to the wall at x = 0.70, y = 1.5, moving in -Z
  // Horizontal separation to corner (x = 1.0) is deltaX = 0.30m
  // Segment terminates at z = -9.05m
  // At z = -9.05, deltaZ to corner (z = -9.5) is 0.45m
  // True 3D distance is sqrt(0.30^2 + 0.45^2) = sqrt(0.09 + 0.2025) = sqrt(0.2925) ~= 0.5408 > 0.48m
  // The naive rectangular expansion (-9.5 + 0.48 = -9.02) would falsely collide at z = -9.02
  // Swept sphere MUST CLEAR!
  const from = new THREE.Vector3(0.70, 1.5, 0);
  const to = new THREE.Vector3(0.70, 1.5, -9.05);

  const t = segmentBoxEntry(from.x, from.y, from.z, to.x, to.y, to.z, wall, radius);
  assert.equal(t, 1, 'Orb must clear the corner when true 3D distance > radius');

  // Verify in runtime ProjectilePool: on the first frame reaching z = -9.05m,
  // the orb clears without triggering an obstacle impact!
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, { obstacles: [wall], heightAt: () => 0 }, { arcaneOrb: dummyVisual() }, 4);
  let impact: Impact | null = null;
  pool.spawn({
    origin: from,
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 65,
    maxRange: 9.05, // Range ends at -9.05m
    kind: 'arcaneOrb',
    radius,
    explosive: true,
  });
  // Frame 1: travels to -9.05m without hitting the corner
  pool.update(0.6, [], (imp) => { impact = imp; });
  assert.equal(impact, null, 'Must clear the corner on this segment without obstacle collision');

  // Frame 2: projectile reaches maxRange and retires with kind: 'expired'
  pool.update(0.1, [], (imp) => { impact = imp; });
  assert.ok(impact, 'Impact emitted on expiration');
  assert.equal(impact!.kind, 'expired', 'Trajectory must expire at maxRange without striking wall corner');
});

test('Exact swept sphere vs AABB: corner collision when 3D distance enters radius', () => {
  const wall: BoxObstacle = {
    kind: 'box',
    minX: 1.0,
    maxX: 5.0,
    minZ: -10.5,
    maxZ: -9.5,
    bottom: 0,
    top: 5.0,
  };

  const radius = 0.48;
  // Projectile travels parallel to the wall at x = 0.70, y = 1.5, moving in -Z
  // Horizontal separation is deltaX = 0.30m
  // Corner is at (1.0, 1.5, -9.5)
  // Distance to corner equals 0.48 when deltaX^2 + deltaZ^2 = 0.48^2
  // 0.09 + deltaZ^2 = 0.2304 => deltaZ = sqrt(0.1404) ~= 0.37469988
  // Expected contact z = -9.5 + 0.37469988 = -9.12530012
  const from = new THREE.Vector3(0.70, 1.5, 0);
  const to = new THREE.Vector3(0.70, 1.5, -9.20); // Extends past -9.1253m

  const t = segmentBoxEntry(from.x, from.y, from.z, to.x, to.y, to.z, wall, radius);
  assert.ok(t < 1, 'Orb must collide with corner when true 3D distance <= radius');

  const hitZ = from.z + (to.z - from.z) * t;
  const expectedZ = -9.5 + Math.sqrt(radius * radius - 0.30 * 0.30);
  assert.ok(Math.abs(hitZ - expectedZ) < 1e-4, `Expected hitZ ~= ${expectedZ}, got ${hitZ}`);

  // Contact point on the box should be clamped to the corner edge (1.0, 1.5, -9.5)
  const contact = { x: 0, y: 0, z: 0 };
  contactPointBox(from.x, from.y, hitZ, wall, contact);
  assert.ok(Math.abs(contact.x - 1.0) < 1e-5);
  assert.ok(Math.abs(contact.y - 1.5) < 1e-5);
  assert.ok(Math.abs(contact.z - (-9.5)) < 1e-5);
});

test('Exact swept sphere vs AABB: starting inside Minkowski volume returns 0', () => {
  const box: BoxObstacle = {
    kind: 'box',
    minX: -1,
    maxX: 1,
    minZ: -1,
    maxZ: 1,
    bottom: 0,
    top: 2,
  };
  const radius = 0.5;

  // Origin is at (1.2, 1.0, 0): distance to maxX (1.0) is 0.2 < 0.5 (inside padded volume)
  const t = segmentBoxEntry(1.2, 1.0, 0, 5, 1.0, 0, box, radius);
  assert.equal(t, 0, 'Starting inside Minkowski sum returns 0');
});

test('Exact swept sphere vs AABB: tangent ray contact and zero-length segment', () => {
  const box: BoxObstacle = {
    kind: 'box',
    minX: 0,
    maxX: 2,
    minZ: 0,
    maxZ: 2,
    bottom: 0,
    top: 2,
  };
  const radius = 0.5;

  // Tangent ray along face at x = -0.5: travels along Z from z = -5 to +5
  // Distance from x = -0.5 to minX (0) is exactly 0.5 (radius)
  const tTangent = segmentBoxEntry(-0.5, 1.0, -5, -0.5, 1.0, 5, box, radius);
  assert.ok(tTangent < 1, 'Tangent contact enters volume');
  assert.ok(Math.abs(tTangent - 0.5) < 1e-3, `Expected tangent entry near t=0.5, got ${tTangent}`);

  // Zero-length segment outside volume
  const tZero = segmentBoxEntry(10, 10, 10, 10, 10, 10, box, radius);
  assert.equal(tZero, 1, 'Zero-length segment outside volume returns 1');
});

// -----------------------------------------------------------------------------
// 2. Correct Segment vs Vertical Cylinder
// -----------------------------------------------------------------------------

test('Segment vs Cylinder: vertical downward plunge enters top cap', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 3.0,
  };

  // Thin arrow (radius 0) plunging straight down from (0, 10, 0) to (0, -2, 0)
  // Distance is 12m. Enters top cap at y = 3.0 (travelled 7m -> t = 7/12)
  const tArrow = segmentCylinderEntry(0, 10, 0, 0, -2, 0, cylinder, 0);
  assert.ok(Math.abs(tArrow - 7 / 12) < 1e-5, `Arrow top cap entry expected ${7 / 12}, got ${tArrow}`);

  // Padded orb (radius 0.5) plunging straight down: enters expanded top cap at y = 3.0 + 0.5 = 3.5
  // Travelled 6.5m -> t = 6.5 / 12
  const tOrb = segmentCylinderEntry(0, 10, 0, 0, -2, 0, cylinder, 0.5);
  assert.ok(Math.abs(tOrb - 6.5 / 12) < 1e-5, `Orb top cap entry expected ${6.5 / 12}, got ${tOrb}`);

  // Surface contact point on cylinder should be (0, 3.0, 0)
  const contact = { x: 0, y: 0, z: 0 };
  contactPointCylinder(0, 3.5, 0, cylinder, contact);
  assert.equal(contact.x, 0);
  assert.equal(contact.y, 3.0);
  assert.equal(contact.z, 0);
});

test('Segment vs Cylinder: vertical upward approach enters bottom cap', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 1.0,
    top: 4.0,
  };

  // Upward approach from y = -5 to y = 5 (deltaY = 10)
  // Radius 0: enters bottom cap at y = 1.0 (travelled 6m -> t = 0.6)
  const tArrow = segmentCylinderEntry(0, -5, 0, 0, 5, 0, cylinder, 0);
  assert.ok(Math.abs(tArrow - 0.6) < 1e-5, `Arrow bottom cap entry expected 0.6, got ${tArrow}`);

  // Radius 0.4: enters bottom cap at y = 1.0 - 0.4 = 0.6 (travelled 5.6m -> t = 0.56)
  const tOrb = segmentCylinderEntry(0, -5, 0, 0, 5, 0, cylinder, 0.4);
  assert.ok(Math.abs(tOrb - 0.56) < 1e-5, `Orb bottom cap entry expected 0.56, got ${tOrb}`);
});

test('Segment vs Cylinder: diagonal approach entering cap vs side', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 2.0,
    bottom: 0,
    top: 2.0,
  };

  // Approach 1: Starts inside horizontal radius (x=0, z=0.5) but above top (y=6), diving diagonally to (0, 0, 1.5)
  // Enters top cap at y = 2.0
  const tCap = segmentCylinderEntry(0, 6, 0.5, 0, 0, 1.5, cylinder, 0);
  assert.ok(tCap < 1, 'Must enter top cap');
  const hitY = 6 + (0 - 6) * tCap;
  assert.ok(Math.abs(hitY - 2.0) < 1e-4, `Expected hitY = 2.0, got ${hitY}`);

  // Approach 2: Starts far in Z (z=10) and dives down from y=4 to y=1 at z=0
  // Enters side wall of cylinder (radius 2.0)
  const tSide = segmentCylinderEntry(0, 4, 10, 0, 1, 0, cylinder, 0);
  assert.ok(tSide < 1, 'Must enter cylinder side');
  const hitZ = 10 + (0 - 10) * tSide;
  assert.ok(Math.abs(hitZ - 2.0) < 1e-4, `Expected hitZ = 2.0 on side, got ${hitZ}`);
});

test('Segment vs Cylinder: starting inside volume and zero horizontal movement outside', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };

  // Inside
  assert.equal(segmentCylinderEntry(0, 1, 0, 0, 1, 10, cylinder, 0), 0);
  assert.equal(segmentCylinderEntry(0, 2.3, 0, 0, 10, 0, cylinder, 0.5), 0); // within padding above top

  // Zero horizontal movement outside footprint (x=5, z=5)
  assert.equal(segmentCylinderEntry(5, 10, 5, 5, -10, 5, cylinder, 0.5), 1);
});

// -----------------------------------------------------------------------------
// 3. Consistency between solveShot() and ProjectilePool.update()
// -----------------------------------------------------------------------------

test('Aim solveShot and runtime ProjectilePool agree on identical box and cylinder geometry', () => {
  const wall: BoxObstacle = {
    kind: 'box',
    minX: -2,
    maxX: 2,
    minZ: -12,
    maxZ: -10,
    bottom: 0,
    top: 4,
  };
  const tree: CylinderObstacle = {
    kind: 'cylinder',
    x: 3,
    z: -8,
    radius: 0.6,
    bottom: 0,
    top: 6,
  };
  const field: ProjectileField = { obstacles: [wall, tree], heightAt: () => 0 };

  const enemy = makeTarget(3, -8, 0); // Same position as tree to test nearest ordering
  const enemies = [enemy];

  // Shot 1: Arcane orb aimed at wall
  const origin = new THREE.Vector3(0, 1.5, 0);
  const direction = new THREE.Vector3(0, 0, -1);
  const orbRadius = 0.48;
  const maxRange = 30;

  const aimPoint = new THREE.Vector3();
  const aimSol = solveShot(origin, direction, field, [], maxRange, aimPoint, orbRadius);
  assert.equal(aimSol.kind, 'obstacle');

  // Runtime pool shot
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, field, { arcaneOrb: dummyVisual() }, 4);
  let poolImpact: Impact | null = null;
  pool.spawn({
    origin,
    direction,
    speed: 25,
    damage: 65,
    maxRange,
    kind: 'arcaneOrb',
    radius: orbRadius,
    explosive: true,
  });
  pool.update(1.0, [], (imp) => { poolImpact = imp; });

  assert.ok(poolImpact);
  assert.equal(poolImpact!.kind, 'obstacle');
  assert.ok(
    aimPoint.distanceTo(poolImpact!.position) < 1e-4,
    `solveShot (${aimPoint.toArray()}) and pool (${poolImpact!.position.toArray()}) must produce identical contact position`,
  );
});

test('High-speed projectile segment does not tunnel through thin obstacles', () => {
  const thinWall: BoxObstacle = {
    kind: 'box',
    minX: -5,
    maxX: 5,
    minZ: -10.05,
    maxZ: -9.95, // 0.10m thick wall
    bottom: 0,
    top: 5,
  };
  const field: ProjectileField = { obstacles: [thinWall], heightAt: () => 0 };
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, field, { arcaneOrb: dummyVisual() }, 4);

  // Speed 300 m/s: a single frame of 0.1s travels 30m, jumping straight across the 0.1m wall
  let impact: Impact | null = null;
  pool.spawn({
    origin: new THREE.Vector3(0, 1.5, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 300,
    damage: 65,
    maxRange: 50,
    kind: 'arcaneOrb',
    radius: 0.48,
    explosive: true,
  });
  pool.update(0.1, [], (imp) => { impact = imp; });

  assert.ok(impact, 'Must not tunnel through thin wall');
  assert.equal(impact!.kind, 'obstacle');
  assert.ok(Math.abs(impact!.position.z - (-9.95)) < 1e-3);
});

test('Nearest collision ordering: obstacle in front blocks shot, enemy in front is struck', () => {
  const wall: BoxObstacle = {
    kind: 'box',
    minX: -2,
    maxX: 2,
    minZ: -6,
    maxZ: -5,
    bottom: 0,
    top: 4,
  };
  const targetBehind = makeTarget(0, -10, 0);
  const targetInFront = makeTarget(0, -3, 0);

  // Case A: Wall at -5m protects target behind at -10m
  const poolA = new ProjectilePool(new THREE.Scene(), { obstacles: [wall], heightAt: () => 0 }, { arcaneOrb: dummyVisual() }, 4);
  let impactA: Impact | null = null;
  poolA.spawn({
    origin: new THREE.Vector3(0, 1.5, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 65,
    maxRange: 30,
    kind: 'arcaneOrb',
    radius: 0.48,
    explosive: true,
  });
  poolA.update(1.0, [targetBehind], (imp) => { impactA = imp; });
  assert.equal(impactA!.kind, 'obstacle');
  assert.equal(targetBehind.hits, 0);

  // Case B: Target at -3m is struck before wall at -5m
  const poolB = new ProjectilePool(new THREE.Scene(), { obstacles: [wall], heightAt: () => 0 }, { arcaneOrb: dummyVisual() }, 4);
  let impactB: Impact | null = null;
  poolB.spawn({
    origin: new THREE.Vector3(0, 1.5, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 65,
    maxRange: 30,
    kind: 'arrow',
    radius: 0.48,
    explosive: false,
  });
  poolB.update(1.0, [targetInFront, targetBehind], (imp) => { impactB = imp; });
  assert.equal(impactB!.kind, 'target');
  assert.equal(targetInFront.hits, 1);
});

// -----------------------------------------------------------------------------
// 4. Exact Continuous Swept-Sphere vs Cylinder Rim Tests
// -----------------------------------------------------------------------------

test('Exact tangent contact on the rounded upper rim', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const R = 0.5;

  // Upper rim circle is at y = 2.0, radius 1.0.
  // At height y = 2.3, deltaY = 0.3.
  // Distance to circle equals R = 0.5 when (rho - 1.0)^2 + 0.3^2 = 0.5^2 = 0.25
  // (rho - 1.0)^2 = 0.16 => rho = 1.40.
  // Horizontal ray parallel to Z at x = 1.40, y = 2.3, from z = 1.0 to z = -1.0
  // Closest approach is at z = 0 (t = 0.5), where rho = 1.40, distance = exactly 0.5!
  const t = segmentCylinderEntry(1.40, 2.3, 1.0, 1.40, 2.3, -1.0, cylinder, R);
  assert.ok(t < 1, 'Exact tangent contact must register a collision');
  assert.ok(Math.abs(t - 0.5) < 1e-4, `Expected tangent entry near t=0.5, got ${t}`);

  // Contact point on cylinder surface should be clamped to the rim at (1.0, 2.0, 0)
  const contact = { x: 0, y: 0, z: 0 };
  contactPointCylinder(1.40, 2.3, 0, cylinder, contact);
  assert.ok(Math.abs(contact.x - 1.0) < 1e-5);
  assert.ok(Math.abs(contact.y - 2.0) < 1e-5);
  assert.ok(Math.abs(contact.z - 0) < 1e-5);
});

test('Regression: diagonal trajectory entering upper rim and ending inside cylinder', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const R = 0.5;

  // Independent distance-to-cylinder calculation gives the first contact at
  // t = 0.42150273751850725 on the rounded upper rim.
  const t = segmentCylinderEntry(2.479, 2.686, 0.743, -0.030, 1.309, 0.030, cylinder, R);
  assert.ok(t < 1, 'Trajectory entering the expanded cylinder must collide');
  assert.ok(Math.abs(t - 0.42150273751850725) < 1e-8, `Expected earliest t≈0.4215027375, got ${t}`);
});

test('Rounded upper and lower rims remain correct after crossing into the horizontal radius', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const R = 0.5;

  // Both paths enter through a rounded rim while rho > 1, cross rho = 1,
  // and finish inside the actual cylinder. The expected t values come from
  // independently solving (rho(t) - 1)^2 + (y(t) - cap)^2 = R^2.
  const upper = segmentCylinderEntry(1.8, 2.4, 0.4, 0.2, 1.0, 0.1, cylinder, R);
  const lower = segmentCylinderEntry(1.8, -0.4, 0.4, 0.2, 1.0, 0.1, cylinder, R);
  assert.ok(Math.abs(upper - 0.21712770246755658) < 1e-8, `Expected upper-rim entry, got ${upper}`);
  assert.ok(Math.abs(lower - 0.21712770246755658) < 1e-8, `Expected lower-rim entry, got ${lower}`);
});

test('Crossing the horizontal axis outside the vertical cylinder range is a miss', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };

  const t = segmentCylinderEntry(2, 3, -2, -2, 3, 2, cylinder, 0.5);
  assert.equal(t, 1, 'Axis crossing one metre above the upper rim must miss');
});

test('Exact tangent contact on the rounded lower rim', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const R = 0.5;

  // Lower rim circle is at y = 0, radius 1.0.
  // At height y = -0.3, deltaY = -0.3.
  // Distance to circle equals R = 0.5 when rho = 1.40.
  // Horizontal ray parallel to Z at x = 1.40, y = -0.3, from z = 1.0 to z = -1.0
  // Tangent at z = 0 (t = 0.5).
  const t = segmentCylinderEntry(1.40, -0.3, 1.0, 1.40, -0.3, -1.0, cylinder, R);
  assert.ok(t < 1, 'Exact tangent contact on lower rim must register a collision');
  assert.ok(Math.abs(t - 0.5) < 1e-4, `Expected lower tangent entry near t=0.5, got ${t}`);

  // Contact point on cylinder surface clamped to lower rim at (1.0, 0, 0)
  const contact = { x: 0, y: 0, z: 0 };
  contactPointCylinder(1.40, -0.3, 0, cylinder, contact);
  assert.ok(Math.abs(contact.x - 1.0) < 1e-5);
  assert.ok(Math.abs(contact.y - 0) < 1e-5);
  assert.ok(Math.abs(contact.z - 0) < 1e-5);
});

test('Near-tangent collision with an extremely narrow contact interval', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const R = 0.5;

  // x = 1.39999 at y = 2.3: penetration depth into rim is only 0.00001m (10 micrometers)
  // Contact interval along Z is [-0.0053, 0.0053] (interval width ~ 0.0053 in parameter t)
  const t = segmentCylinderEntry(1.39999, 2.3, 1.0, 1.39999, 2.3, -1.0, cylinder, R);
  assert.ok(t < 1, 'Near-tangent penetration of 10um must be reliably detected');
  assert.ok(Math.abs(t - 0.5) < 0.01, `Expected entry near t=0.5, got ${t}`);
});

test('A trajectory that narrowly misses the rim clears with t = 1', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const R = 0.5;

  // x = 1.4005 at y = 2.3: closest approach distance is ~0.5004m > 0.50m (misses by 0.4mm)
  const t = segmentCylinderEntry(1.4005, 2.3, 1.0, 1.4005, 2.3, -1.0, cylinder, R);
  assert.equal(t, 1, 'Trajectory missing by 0.4mm must clear without collision');
});

test('A trajectory starting outside enters through the rounded rim', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const R = 0.5;

  // Starts at (2.0, 3.0, 0) and dives diagonally toward (0.5, 1.5, 0)
  // Distance at start: deltaH = 2.0 - 1.0 = 1.0, deltaV = 3.0 - 2.0 = 1.0 => dist = sqrt(2) ~= 1.414 > 0.5
  // End point is inside cylinder: deltaH = 0, deltaV = 0 => dist = 0
  const t = segmentCylinderEntry(2.0, 3.0, 0, 0.5, 1.5, 0, cylinder, R);
  assert.ok(t > 0 && t < 1, `Must enter through the rounded rim, got t=${t}`);

  // At entry point, distance to rim circle (radius 1.0 at y=2.0) must equal R = 0.5
  const entryX = 2.0 + (0.5 - 2.0) * t;
  const entryY = 3.0 + (1.5 - 3.0) * t;
  const distToRim = Math.hypot(entryX - 1.0, entryY - 2.0);
  assert.ok(Math.abs(distToRim - R) < 1e-4, `Expected entry distance ${R}, got ${distToRim}`);
});

test('Regression: narrow rim collision missed by 7-sample implementation is detected', () => {
  // Constructed case where the old 7-sample fixed grid steps completely over the contact interval:
  // Cylinder at (0, 0), radius 1.0, height [0, 2.0], R = 0.5.
  // Bounding cylinder radius = 1.50. Horizontal path at y = 2.3, x = 1.3996.
  // Penetration interval is |z| <= 0.03346m.
  // Segment: z starts at 0.450 and ends at -0.639 (deltaZ = -1.089).
  // The closest approach (z = 0) occurs at t* = 0.450 / 1.089 = 0.41322.
  // The collision interval in parameter t is [0.3825, 0.4439].
  // The 7 fixed samples of the old implementation were at i/8 * tOut:
  // Sample 3 is at t = 0.3408 (z = 0.0789 > 0.0335, outside!).
  // Sample 4 is at t = 0.4543 (z = -0.0448, |-0.0448| > 0.0335, outside!).
  // The old 7-sample code saw ALL 7 samples outside and returned 1 (false miss).
  // The exact continuous root-solver detects the collision reliably.
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const R = 0.5;

  const t = segmentCylinderEntry(1.3996, 2.3, 0.450, 1.3996, 2.3, -0.639, cylinder, R);
  assert.ok(t < 1, 'Narrow collision missed by 7-sample implementation must be detected');
  assert.ok(t >= 0.38 && t <= 0.40, `Expected entry parameter near 0.385, got ${t}`);
});

test('Diagonal trajectories entering through cylinder side and caps', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.5,
    bottom: 0,
    top: 3.0,
  };
  const R = 0.48;

  // 1. Diagonal entry through top cap:
  // Segment moves diagonally downwards from (0.2, 5.0, 0.2) to (0.2, 1.0, 0.2)
  // Horizontal radius is 0.2 < 1.5 (inside top cap disk)
  // Enters top cap at y = 3.0 + 0.48 = 3.48
  const tCap = segmentCylinderEntry(0.2, 5.0, 0.2, 0.2, 1.0, 0.2, cylinder, R);
  assert.ok(tCap < 1);
  const hitYCap = 5.0 + (1.0 - 5.0) * tCap;
  assert.ok(Math.abs(hitYCap - 3.48) < 1e-4, `Expected cap hit at y=3.48, got ${hitYCap}`);

  // 2. Diagonal entry through side wall:
  // Starts far in X at x = 5.0, y = 1.5, moving diagonally to x = -2.0, y = 1.5
  // Enters side wall at x = 1.5 + 0.48 = 1.98
  const tSide = segmentCylinderEntry(5.0, 1.5, 0, -2.0, 1.5, 0, cylinder, R);
  assert.ok(tSide < 1);
  const hitXSide = 5.0 + (-2.0 - 5.0) * tSide;
  assert.ok(Math.abs(hitXSide - 1.98) < 1e-4, `Expected side hit at x=1.98, got ${hitXSide}`);
});

test('Starting overlap and zero-length behavior on cylinder', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const R = 0.5;

  // Starts strictly on the upper rim boundary: distance to rim circle = 0.5
  // (x = 1.40, y = 2.3, z = 0) has distance sqrt(0.4^2 + 0.3^2) = 0.5
  const tOnRim = segmentCylinderEntry(1.40, 2.3, 0, 5, 2.3, 0, cylinder, R);
  assert.equal(tOnRim, 0, 'Starting on upper rim boundary returns 0');

  // Starts on lower rim boundary
  const tOnLowerRim = segmentCylinderEntry(1.40, -0.3, 0, 5, -0.3, 0, cylinder, R);
  assert.equal(tOnLowerRim, 0, 'Starting on lower rim boundary returns 0');

  // Zero-length segment outside cylinder returns 1
  const tZero = segmentCylinderEntry(10, 10, 10, 10, 10, 10, cylinder, R);
  assert.equal(tZero, 1, 'Zero-length segment outside cylinder returns 1');
});

test('Radius-zero arrow behavior on cylinder remains exact and unchanged', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: 0,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };

  // 1. Thin arrow passes at x = 1.02, y = 2.1 (above top and outside side): must clear
  const tClear = segmentCylinderEntry(1.02, 2.1, 5, 1.02, 2.1, -5, cylinder, 0);
  assert.equal(tClear, 1, 'Thin arrow clearing cylinder must return 1');

  // 2. Thin arrow hitting top cap at y = 2.0:
  // Origin (0, 5, 0), down to (0, -1, 0). Length 6m. Enters at y = 2.0 (t = 3/6 = 0.5)
  const tCap = segmentCylinderEntry(0, 5, 0, 0, -1, 0, cylinder, 0);
  assert.ok(Math.abs(tCap - 0.5) < 1e-5, `Expected unpadded cap hit at t=0.5, got ${tCap}`);

  // 3. Thin arrow hitting side at radius 1.0:
  // Origin (5, 1.0, 0), to (-5, 1.0, 0). Enters at x = 1.0 (t = 4/10 = 0.4)
  const tSide = segmentCylinderEntry(5, 1.0, 0, -5, 1.0, 0, cylinder, 0);
  assert.ok(Math.abs(tSide - 0.4) < 1e-5, `Expected unpadded side hit at t=0.4, got ${tSide}`);
});

test('Runtime ProjectilePool and solveShot agree on rounded cylinder rim geometry and contact point', () => {
  const cylinder: CylinderObstacle = {
    kind: 'cylinder',
    x: 0,
    z: -10,
    radius: 1.0,
    bottom: 0,
    top: 2.0,
  };
  const field: ProjectileField = { obstacles: [cylinder], heightAt: () => 0 };
  const orbRadius = 0.48;

  // Shoot an arcane orb diagonally into the cylinder upper rim
  const origin = new THREE.Vector3(1.35, 2.5, 0);
  const direction = new THREE.Vector3(0, -0.05, -1).normalize();
  const maxRange = 25;

  const aimPoint = new THREE.Vector3();
  const aimSol = solveShot(origin, direction, field, [], maxRange, aimPoint, orbRadius);
  assert.equal(aimSol.kind, 'obstacle');

  // Runtime pool
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, field, { arcaneOrb: dummyVisual() }, 4);
  let poolImpact: Impact | null = null;
  pool.spawn({
    origin,
    direction,
    speed: 20,
    damage: 65,
    maxRange,
    kind: 'arcaneOrb',
    radius: orbRadius,
    explosive: true,
  });
  pool.update(1.0, [], (imp) => { poolImpact = imp; });

  assert.ok(poolImpact);
  assert.equal(poolImpact!.kind, 'obstacle');
  assert.ok(
    aimPoint.distanceTo(poolImpact!.position) < 1e-4,
    `solveShot (${aimPoint.toArray()}) and pool (${poolImpact!.position.toArray()}) must produce identical contact position`,
  );
});
