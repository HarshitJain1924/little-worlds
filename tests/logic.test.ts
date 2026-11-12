import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ThirdPersonCamera } from '../src/play/camera.ts';
import type { CameraObstacle } from '../src/play/collision.ts';
import { hasLineOfSight, nearestObstruction, segmentBoxEntry, segmentCylinderEntry } from '../src/play/collision.ts';
import { TargetTracker, scoreTarget } from '../src/play/targeting.ts';
import type { TargetScoring } from '../src/play/targeting.ts';

const makeScoring = (): TargetScoring => ({
  player: { x: 0, y: 0, z: 0 },
  cameraForward: { x: 0, z: -1 },
  playerForward: { x: 0, z: -1 },
  maxRange: 15,
  maxAngle: Math.PI * 0.55,
});

let scoring = makeScoring();

const target = (x: number, z: number, alive = true) => ({ position: { x, y: 0, z }, alive });

test('box segment entry finds the near wall and ignores paths above it', () => {
  const box = { kind: 'box' as const, minX: -2, maxX: 2, minZ: 3, maxZ: 4, bottom: 0, top: 4 };

  const entry = segmentBoxEntry(0, 1, 0, 0, 1, 10, box);
  assert.ok(Math.abs(entry - 0.3) < 1e-6, `expected 0.3, got ${entry}`);

  // Above the wall: length runs over the top.
  assert.equal(segmentBoxEntry(0, 6, 0, 0, 6, 10, box), 1);

  // Parallel and outside: never enters.
  assert.equal(segmentBoxEntry(9, 1, 0, 9, 1, 10, box), 1);
});

test('cylinder entry respects trunk radius and height', () => {
  const trunk = { kind: 'cylinder' as const, x: 0, z: 5, radius: 0.5, bottom: 0, top: 6 };

  const entry = segmentCylinderEntry(0, 2, 0, 0, 2, 10, trunk);
  assert.ok(entry > 0.4 && entry < 0.5, `expected ~0.45, got ${entry}`);

  // Passing above the trunk clears it.
  assert.equal(segmentCylinderEntry(0, 8, 0, 0, 8, 10, trunk), 1);

  // Missing sideways clears it.
  assert.equal(segmentCylinderEntry(5, 2, 0, 5, 2, 10, trunk), 1);
});

test('nearest obstruction and line of sight use the nearest proxy', () => {
  const obstacles: CameraObstacle[] = [
    { kind: 'box', minX: -1, maxX: 1, minZ: 4, maxZ: 5, bottom: 0, top: 4 },
    { kind: 'cylinder', x: 0, z: 2, radius: 0.4, bottom: 0, top: 4 },
  ];

  const nearest = nearestObstruction(0, 1, 0, 0, 1, 10, obstacles);
  assert.ok(nearest < 0.25, `expected the trunk first, got ${nearest}`);
  assert.equal(hasLineOfSight(0, 1, 0, 0, 1, 10, obstacles), false);
  assert.equal(hasLineOfSight(0, 1, 0, 0, 1, 1, obstacles), true);
});

test('target scoring prefers close, visible targets in front of the camera', () => {
  scoring = makeScoring();
  const near = scoreTarget(target(0, -4), scoring, true);
  const far = scoreTarget(target(0, -12), scoring, true);
  const behind = scoreTarget(target(0, 6), scoring, true);
  const hidden = scoreTarget(target(0, -4), scoring, false);

  assert.ok(near > far, 'closer target should score higher');
  assert.equal(behind, -1, 'targets behind the camera are rejected');
  assert.ok(near > hidden, 'visible target should beat a hidden one');
  assert.equal(scoreTarget({ ...target(0, -4), alive: false }, scoring, true), -1);
  assert.equal(scoreTarget(target(0, -20), scoring, true), -1, 'out of range is rejected');
});

test('tracker selects the best target, re-ranks after a death, and releases a distant lock', () => {
  scoring = makeScoring();
  const a = target(0, -4);
  const b = target(3, -9);
  const tracker = new TargetTracker({
    maxRange: 15,
    releaseRange: 20,
    maxAngle: Math.PI * 0.6,
    perceptionInterval: 0.2,
    isVisible: () => true,
  });

  tracker.register(a);
  tracker.register(b);

  tracker.update(scoring, 0.25);
  assert.equal(tracker.soft, a);

  tracker.toggleLock(scoring);
  assert.equal(tracker.locked, a);

  a.alive = false;
  tracker.update(scoring, 0.25);
  assert.equal(tracker.locked, null, 'dead target releases the lock');
  assert.equal(tracker.soft, b);

  tracker.toggleLock(scoring);
  assert.equal(tracker.locked, b);

  // Walk far enough away that the lock must break.
  scoring.player = { x: 0, y: 0, z: 40 };
  tracker.update(scoring, 0.25);
  assert.equal(tracker.locked, null);
});

test('switching targets cycles through ranked candidates', () => {
  scoring = makeScoring();
  const tracker = new TargetTracker({ maxRange: 15, perceptionInterval: 0.2, isVisible: () => true });
  const near = target(0, -3);
  const mid = target(1, -6);
  const far = target(2, -9);
  tracker.register(near);
  tracker.register(mid);
  tracker.register(far);

  tracker.update(scoring, 0.25);
  assert.equal(tracker.toggleLock(scoring), near);

  const switched = tracker.cycle(scoring);
  assert.ok(switched === mid || switched === far);
  assert.notEqual(switched, near);
});

test('a brief loss of sight does not break the lock, a long one does', () => {
  scoring = makeScoring();
  let visible = true;
  const tracker = new TargetTracker({
    maxRange: 15,
    releaseRange: 20,
    perceptionInterval: 0.2,
    lostSightGrace: 0.5,
    isVisible: () => visible,
  });
  const enemy = target(0, -5);
  tracker.register(enemy);

  tracker.update(scoring, 0.25);
  tracker.toggleLock(scoring);

  visible = false;
  tracker.update(scoring, 0.2);
  assert.equal(tracker.locked, enemy, 'grace period keeps the lock');

  tracker.update(scoring, 0.4);
  assert.equal(tracker.locked, null, 'sustained occlusion releases');
});

test('camera yaw follows mouse input and pitch stays clamped', () => {
  const camera = new ThirdPersonCamera(1.6);
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.3);
  camera.rotate(100, 0);
  camera.update(1, player);
  assert.ok(Math.abs(camera.yaw + 0.26) < 0.02, `yaw ${camera.yaw}`);

  camera.rotate(0, 100000);
  camera.update(1, player);
  assert.ok(camera.pitch <= camera.bounds.maxPitch + 1e-6);
  assert.ok(Math.abs(camera.pitch - camera.bounds.maxPitch) < 0.01);

  camera.rotate(0, -100000);
  camera.update(1, player);
  assert.ok(Math.abs(camera.pitch - camera.bounds.minPitch) < 0.01);
});

test('camera boom pulls in for an obstruction and eases back out', () => {
  const obstacles: CameraObstacle[] = [];
  const camera = new ThirdPersonCamera(1.6, { obstacles, heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.25);
  camera.update(0.016, player);
  const free = camera.distance;
  assert.ok(free > 6, `expected a long open boom, got ${free}`);

  obstacles.push({ kind: 'box', minX: -3, maxX: 3, minZ: 3.5, maxZ: 5, bottom: 0, top: 6 });
  camera.update(0.016, player);
  const blocked = camera.distance;
  assert.ok(blocked < free - 1, `obstruction should shorten the boom: ${blocked} vs ${free}`);

  obstacles.length = 0;
  for (let i = 0; i < 180; i += 1) camera.update(0.016, player);
  assert.ok(camera.distance > blocked + 1, 'boom should recover once clear');
});

test('locked camera frames the player from behind toward the target', () => {
  const camera = new ThirdPersonCamera(1.6, { heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.3);
  camera.setLockTarget({ x: 0, z: 10 });

  for (let i = 0; i < 90; i += 1) camera.update(0.016, player);

  // Camera sits on the -z side so its forward points at the enemy (+z).
  assert.ok(Math.abs(Math.abs(camera.yaw) - Math.PI) < 0.05, `yaw ${camera.yaw}`);
  const forward = camera.forward(new THREE.Vector3());
  assert.ok(forward.z > 0.95, `forward ${forward.toArray().join(',')}`);
});

test('backpedalling never recenters the camera behind the player', () => {
  const camera = new ThirdPersonCamera(1.6, { heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.32);
  const startYaw = camera.yaw;

  // At yaw 0 the camera looks along -z, so +z velocity is walking backwards.
  // Following that travel would point the camera into its own view and loop.
  for (let i = 0; i < 240; i += 1) camera.update(1 / 60, player, { x: 0, z: 1 });

  assert.ok(
    Math.abs(camera.yaw - startYaw) < 0.01,
    `backpedalling rotated the camera to ${camera.yaw.toFixed(3)}`,
  );
  assert.ok(Math.abs(camera.targetYaw - startYaw) < 0.01, 'target yaw drifted too');
});

test('recentering still follows forward/ diagonal travel', () => {
  const camera = new ThirdPersonCamera(1.6, { heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.32);

  // 45 degrees off the view direction, inside the recenter cone.
  for (let i = 0; i < 240; i += 1) camera.update(1 / 60, player, { x: 0.7, z: -0.7 });

  assert.ok(camera.yaw < -0.2, `expected the camera to drift, got ${camera.yaw.toFixed(3)}`);
});

test('wheel zoom stays inside its limits', () => {
  const camera = new ThirdPersonCamera(1.6, { heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  for (let i = 0; i < 40; i += 1) camera.zoom(1);
  for (let i = 0; i < 200; i += 1) camera.update(0.016, player);
  assert.ok(camera.distance <= camera.bounds.maxDistance + 0.01);

  for (let i = 0; i < 80; i += 1) camera.zoom(-1);
  for (let i = 0; i < 200; i += 1) camera.update(0.016, player);
  assert.ok(camera.distance >= 1.0);
});
