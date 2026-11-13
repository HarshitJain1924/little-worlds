import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Enemy, type EnemyConfig } from '../src/play/enemy.ts';

function makeRig(): {
  root: THREE.Object3D;
  animator: {
    playing: string;
    updates: number;
    play: (name: string) => void;
    clipDuration: (name: string) => number;
  };
  flash: (seconds?: number, strength?: number) => void;
  update: (delta: number) => void;
} {
  const animator = {
    playing: 'Idle_A',
    updates: 0,
    play(name: string): void {
      this.playing = name;
    },
    clipDuration: (): number => 1.0,
  };
  return {
    root: new THREE.Object3D(),
    animator,
    flash(): void {},
    update(): void {
      animator.updates += 1;
    },
  };
}

const config: EnemyConfig = {
  label: 'Test Skeleton',
  maxHealth: 100,
  speed: 2,
  damage: 12,
  aggroRadius: 10,
  attackRange: 2.5,
  attackCooldown: 1,
  attackClip: 'Melee_1H_Attack_Chop',
  attackStrike: 0.6,
  attackTimeScale: 1,
};

function makeEnemy(spawnZ = 0): { enemy: Enemy; rig: ReturnType<typeof makeRig> } {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles: [] };
  return { enemy: new Enemy(rig as never, config, { x: 0, z: spawnZ }, world as never), rig };
}

function enterAttack(enemy: Enemy, player: THREE.Vector3): void {
  enemy.update(1 / 60, player, true);
  enemy.update(1 / 60, player, true);
}

test('Enemy damage waits for the post-mixer strike frame and commits its facing', () => {
  const { enemy, rig } = makeEnemy();
  const player = new THREE.Vector3(0, 0, -1.5);
  let hits = 0;
  let updatesAtHit = 0;
  enemy.onHitPlayer = () => {
    hits += 1;
    updatesAtHit = rig.animator.updates;
  };

  enterAttack(enemy, player);
  assert.equal(enemy.state, 'attack');
  assert.equal(enemy.isWindingUp, true);
  assert.equal(hits, 0);

  enemy.update(0.5, player, true);
  assert.equal(hits, 0, 'wind-up must not damage before the authored strike');

  // Move behind the committed facing after the commitment point. The attack
  // may finish its animation, but its impact must not turn to follow the player.
  player.z = 1.5;
  enemy.update(0.11, player, true);
  assert.equal(hits, 0, 'committed attack must not rotate into a late target');

  // Start a fresh attack facing the player and verify the callback happens
  // after this frame has advanced the animation mixer.
  enemy.update(1.01, new THREE.Vector3(0, 0, -1.5), true);
  enemy.update(1.0, new THREE.Vector3(0, 0, -1.5), true);
  assert.equal(enemy.state, 'attack');
  const updatesBeforeImpact = rig.animator.updates;
  enemy.update(0.6, new THREE.Vector3(0, 0, -1.5), true);
  assert.equal(hits, 1);
  assert.ok(updatesAtHit > updatesBeforeImpact, 'impact must follow the animation mixer update');
  assert.equal(updatesAtHit, rig.animator.updates);
});

test('Enemy recovery is deterministic and remains punishable', () => {
  const { enemy } = makeEnemy();
  const player = new THREE.Vector3(0, 0, -1.5);
  enterAttack(enemy, player);

  enemy.update(0.61, player, true);
  enemy.update(0.4, player, true);
  assert.equal(enemy.state, 'chase', 'completed swing should release into recovery/chase');

  enemy.update(0.99, player, true);
  assert.equal(enemy.state, 'chase', 'cooldown should keep the enemy out of a second swing');
  enemy.update(0.02, player, true);
  assert.equal(enemy.state, 'attack', 'attack becomes available at the deterministic recovery boundary');
});

test('Enemy hit reaction interrupts attacks and death is terminal', () => {
  const { enemy, rig } = makeEnemy();
  const player = new THREE.Vector3(0, 0, -1.5);
  let hits = 0;
  enemy.onHitPlayer = () => { hits += 1; };
  enterAttack(enemy, player);

  assert.equal(enemy.takeDamage(10, new THREE.Vector3(0, 0, 1)), true);
  assert.equal(enemy.state, 'hurt');
  assert.equal(rig.animator.playing, 'Hit_A');
  enemy.update(0.32, player, true);
  assert.equal(enemy.state, 'chase');
  assert.equal(hits, 0, 'interrupted swing must not land later');

  assert.equal(enemy.takeDamage(100, new THREE.Vector3(0, 0, 1)), true);
  assert.equal(enemy.alive, false);
  assert.equal(enemy.state, 'dead');
  assert.equal(rig.animator.playing, 'Death_A');
  enemy.update(1, player, true);
  assert.equal(enemy.state, 'dead');
  assert.equal(enemy.takeDamage(1, new THREE.Vector3(0, 0, 1)), false);
});
