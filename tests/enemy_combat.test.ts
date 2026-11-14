import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Enemy, separateEnemyBodies, type EnemyConfig, updateEnemyEncounter } from '../src/play/enemy.ts';

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

function makeEnemy(spawnZ = 0, obstacles: unknown[] = []): { enemy: Enemy; rig: ReturnType<typeof makeRig> } {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles };
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
  assert.ok(
    Math.abs(enemy.windupProgress - (1 / 60) / config.attackStrike!) < 1e-6,
    'gameplay wind-up must include the same first frame as the attack animation',
  );
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
  enemy.update(enemy.recoveryRemaining, new THREE.Vector3(0, 0, -1.5), true);
  assert.equal(enemy.state, 'attack');
  const updatesBeforeImpact = rig.animator.updates;
  enemy.update(0.6, new THREE.Vector3(0, 0, -1.5), true);
  assert.equal(hits, 1);
  assert.ok(updatesAtHit > updatesBeforeImpact, 'impact must follow the animation mixer update');
  assert.equal(updatesAtHit, rig.animator.updates);
});

test('Enemy recovery stays bounded, staggered, and remains punishable', () => {
  const { enemy } = makeEnemy();
  const player = new THREE.Vector3(0, 0, -1.5);
  enterAttack(enemy, player);

  enemy.update(0.61, player, true);
  enemy.update(0.4, player, true);
  assert.equal(enemy.state, 'chase', 'completed swing should release into recovery/chase');
  assert.ok(enemy.recoveryRemaining >= config.attackCooldown * 0.9);
  assert.ok(enemy.recoveryRemaining <= config.attackCooldown * 1.25);

  enemy.update(enemy.recoveryRemaining - 0.001, player, true);
  assert.equal(enemy.state, 'chase', 'cooldown should keep the enemy out of a second swing');
  enemy.update(0.002, player, true);
  assert.equal(enemy.state, 'attack', 'attack becomes available at the recovery boundary');
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

test('Enemy impacts respect walls, range, player death, interruption, and reset', () => {
  const wall = { kind: 'box' as const, minX: -1, maxX: 1, minZ: -1.0, maxZ: -0.5, bottom: 0, top: 3 };
  const blocked = makeEnemy(0, [wall]);
  const blockedPlayer = new THREE.Vector3(0, 0, -1.5);
  let blockedHits = 0;
  blocked.enemy.onHitPlayer = () => { blockedHits += 1; };
  enterAttack(blocked.enemy, blockedPlayer);
  blocked.enemy.update(0.6, blockedPlayer, true);
  assert.equal(blockedHits, 0, 'attacks must not hit through walls');

  const outOfRange = makeEnemy();
  const distantPlayer = new THREE.Vector3(0, 0, -1.5);
  let rangeHits = 0;
  outOfRange.enemy.onHitPlayer = () => { rangeHits += 1; };
  enterAttack(outOfRange.enemy, distantPlayer);
  distantPlayer.z = -3.2;
  outOfRange.enemy.update(0.6, distantPlayer, true);
  assert.equal(rangeHits, 0, 'attacks must not hit beyond their valid range');

  const deadPlayer = makeEnemy();
  const deadPlayerPosition = new THREE.Vector3(0, 0, -1.5);
  let deadPlayerHits = 0;
  deadPlayer.enemy.onHitPlayer = () => { deadPlayerHits += 1; };
  enterAttack(deadPlayer.enemy, deadPlayerPosition);
  deadPlayer.enemy.update(0.6, deadPlayerPosition, false);
  assert.equal(deadPlayerHits, 0, 'dead players must not receive pending damage');

  const reset = makeEnemy();
  const resetPlayer = new THREE.Vector3(0, 0, -1.5);
  let resetHits = 0;
  reset.enemy.onHitPlayer = () => { resetHits += 1; };
  enterAttack(reset.enemy, resetPlayer);
  reset.enemy.reset();
  assert.equal(reset.enemy.state, 'idle');
  assert.equal(reset.enemy.isWindingUp, false);
  reset.enemy.update(0.6, resetPlayer, true);
  assert.equal(resetHits, 0, 'reset must clear pending attack impact state');
});

test('Enemy encounter limits pressure and separates approaching bodies', () => {
  const enemies = [makeEnemy(0).enemy, makeEnemy(0.2).enemy, makeEnemy(0.4).enemy];
  const player = new THREE.Vector3(0, 0, -1.5);
  let attackObserved = false;

  for (let frame = 0; frame < 240; frame += 1) {
    updateEnemyEncounter(enemies, 1 / 60, player, true);
    separateEnemyBodies(enemies);

    const active = enemies.filter((enemy) => enemy.alive && enemy.state === 'attack').length;
    assert.ok(active <= 1, `encounter pressure exceeded one attacker: ${active}`);
    if (active > 0) attackObserved = true;

    for (let i = 0; i < enemies.length; i += 1) {
      for (let j = i + 1; j < enemies.length; j += 1) {
        const distance = enemies[i].position.distanceTo(enemies[j].position);
        assert.ok(distance >= 0.95 - 1e-6, `enemy bodies stacked at ${distance}`);
      }
    }
  }

  assert.equal(attackObserved, true, 'the pressure gate must not deadlock the encounter');
});

test('Enemy attack opportunities release after death and interruption', () => {
  const first = makeEnemy(0).enemy;
  const second = makeEnemy(0.2).enemy;
  const player = new THREE.Vector3(0, 0, -1.5);
  updateEnemyEncounter([first, second], 1 / 60, player, true);
  updateEnemyEncounter([first, second], 1 / 60, player, true);
  assert.equal(first.state, 'attack');
  assert.equal(second.state, 'chase');

  first.takeDamage(200, new THREE.Vector3(0, 0, 1));
  updateEnemyEncounter([first, second], 1 / 60, player, true);
  assert.equal(second.state, 'attack', 'a dead attacker must release the pressure slot');

  const interrupted = makeEnemy(0).enemy;
  const waiting = makeEnemy(0.2).enemy;
  updateEnemyEncounter([interrupted, waiting], 1 / 60, player, true);
  updateEnemyEncounter([interrupted, waiting], 1 / 60, player, true);
  assert.equal(interrupted.state, 'attack');
  interrupted.takeDamage(5, new THREE.Vector3(0, 0, 1));
  updateEnemyEncounter([interrupted, waiting], 1 / 60, player, true);
  assert.equal(waiting.state, 'attack', 'an interrupted attacker must release the pressure slot');
});
