import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { CameraObstacle } from '../src/play/collision.ts';
import type { Impact, ProjectileField, ProjectileTarget } from '../src/play/projectiles.ts';
import { ProjectilePool } from '../src/play/projectiles.ts';
import { solveShot } from '../src/play/aim.ts';

const FLAT: ProjectileField = { obstacles: [], heightAt: () => 0 };

function makePool(field: ProjectileField = FLAT, capacity = 16): ProjectilePool {
  const scene = new THREE.Scene();
  return new ProjectilePool(
    scene,
    field,
    { geometry: new THREE.BoxGeometry(0.08, 0.08, 1.26), material: new THREE.MeshBasicMaterial() },
    capacity,
  );
}

interface FakeTarget extends ProjectileTarget {
  damage: number;
  hits: number;
}

function makeTarget(x: number, z: number, y = 0): FakeTarget {
  const target: FakeTarget = {
    position: { x, y, z },
    alive: true,
    damage: 0,
    hits: 0,
    takeDamage(amount: number): boolean {
      target.damage += amount;
      target.hits += 1;
      return true;
    },
  };
  return target;
}

const collect = (log: Impact[]): ((impact: Impact) => void) => (impact) => {
  log.push({ ...impact, position: impact.position.clone() });
};

test('an arrow travels at its shot speed and stops on the body it reaches', () => {
  const pool = makePool();
  const target = makeTarget(0, -10);
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 18,
    maxRange: 40,
  });

  // 0.25 s at 20 m/s is 5 m: two thirds of the way, no hit yet.
  pool.update(0.25, [target], collect(impacts));
  assert.equal(impacts.length, 0);
  assert.equal(pool.activeCount, 1);

  // The next 0.25 s reaches the body.
  pool.update(0.25, [target], collect(impacts));
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].kind, 'target');
  assert.equal(impacts[0].target, target);
  assert.ok(Math.abs(impacts[0].position.z + 10) < 0.6, `impact at z=${impacts[0].position.z}`);
  assert.equal(target.damage, 18);
  assert.equal(target.hits, 1);
  assert.equal(pool.activeCount, 0);
});

test('segment collision stops a fast arrow from tunnelling through a body', () => {
  const pool = makePool();
  const target = makeTarget(0, -5);
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    // One 0.1 s step covers 30 m, far past the body.
    speed: 300,
    damage: 34,
    maxRange: 55,
  });

  pool.update(0.1, [target], collect(impacts));

  assert.equal(target.hits, 1, 'the whole segment is tested, not the end point');
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].kind, 'target');
  assert.ok(Math.abs(impacts[0].position.z + 5) < 0.7);
});

test('a wall between the arrow and its target stops the arrow', () => {
  const wall: CameraObstacle = {
    kind: 'box',
    minX: -3,
    maxX: 3,
    minZ: -4,
    maxZ: -3,
    bottom: 0,
    top: 3,
  };
  const pool = makePool({ obstacles: [wall], heightAt: () => 0 });
  const target = makeTarget(0, -8);
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 40,
    damage: 18,
    maxRange: 40,
  });

  pool.update(0.25, [target], collect(impacts));

  assert.equal(target.hits, 0, 'no damage through cover');
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].kind, 'obstacle');
  assert.ok(impacts[0].position.z > -3.05 && impacts[0].position.z < -2.9, `stopped at z=${impacts[0].position.z}`);
  assert.equal(pool.activeCount, 0);
});

test('an arrow that reaches the ground is stopped and retired', () => {
  const pool = makePool();
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 2, 0),
    // Pitched down: this is the case a horizontal-only aim would get wrong.
    direction: new THREE.Vector3(0, -1, 0),
    speed: 10,
    damage: 18,
    maxRange: 40,
  });

  pool.update(0.05, [], collect(impacts));
  assert.equal(impacts.length, 0, 'still airborne');

  pool.update(0.4, [], collect(impacts));
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].kind, 'ground');
  assert.ok(impacts[0].position.y < 0.1);
  assert.equal(pool.activeCount, 0);
});

test('expired arrows clean themselves up', () => {
  const pool = makePool({ obstacles: [], heightAt: () => -100 });
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 5, 0),
    direction: new THREE.Vector3(0, 0, 1),
    speed: 10,
    damage: 18,
    maxRange: 5,
  });

  for (let i = 0; i < 10; i += 1) pool.update(0.1, [], collect(impacts));

  assert.equal(pool.activeCount, 0, 'nothing is left flying');
  assert.equal(impacts.filter((impact) => impact.kind === 'expired').length, 1);
});

test('clear() retires arrows in flight and the pool recycles its slots', () => {
  const pool = makePool(FLAT, 2);

  const fire = (): void => {
    pool.spawn({
      origin: new THREE.Vector3(0, 1, 0),
      direction: new THREE.Vector3(1, 0, 0),
      speed: 5,
      damage: 18,
      maxRange: 40,
    });
  };

  fire();
  fire();
  assert.equal(pool.activeCount, 2);

  // A third shot reuses a slot rather than growing the pool.
  fire();
  assert.equal(pool.activeCount, 2);

  pool.clear();
  assert.equal(pool.activeCount, 0);
});

test('dead bodies are not hit and a suppressed hit is reported as no damage', () => {
  const pool = makePool();
  const dead = makeTarget(0, -3);
  dead.alive = false;
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 18,
    maxRange: 40,
  });

  pool.update(0.5, [dead], collect(impacts));

  assert.equal(dead.hits, 0);
  assert.equal(impacts.filter((impact) => impact.kind === 'target').length, 0);
});

test('aim preview chooses the same nearest feature as projectile collision', () => {
  const wall: CameraObstacle = {
    kind: 'box', minX: -2, maxX: 2, minZ: -4, maxZ: -3, bottom: 0, top: 3,
  };
  const field: ProjectileField = { obstacles: [wall], heightAt: () => 0 };
  const target = makeTarget(0, -8, 0);
  const point = new THREE.Vector3();

  const wallShot = solveShot(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), field, [target], 20, point,
  );
  assert.equal(wallShot.kind, 'obstacle');
  assert.equal(wallShot.target, null);
  assert.ok(point.z > -3.1 && point.z < -2.9);

  const clearPoint = new THREE.Vector3();
  const clearShot = solveShot(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), FLAT, [target], 20, clearPoint,
  );
  assert.equal(clearShot.kind, 'enemy');
  assert.equal(clearShot.target, target);
  assert.ok(clearShot.distance < 8, 'the body is selected before the range limit');
});
