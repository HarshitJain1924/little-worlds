import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Player } from '../src/play/player.ts';
import { profileFor } from '../src/play/movesets.ts';

function makeRig(): { root: THREE.Object3D; animator: { playing: string; play: (name: string) => void; clipDuration: () => number }; update: () => void; flash: () => void } {
  const animator = {
    playing: 'Idle_A',
    play(name: string): void { this.playing = name; },
    clipDuration: (): number => 1.33,
  };
  return {
    root: new THREE.Object3D(),
    animator,
    update: (): void => {},
    flash: (): void => {},
  };
}

function makeInput(): {
  aim: boolean;
  heavyHeld: boolean;
  heavyEdge: boolean;
  attackEdge: boolean;
  readMove: () => { x: number; y: number; run: boolean };
  takeJump: () => boolean;
  takeDodge: () => boolean;
  takeHeavy: () => boolean;
  takeAttack: () => boolean;
  isBlocking: () => boolean;
  isHeavyHeld: () => boolean;
} {
  const input = {
    aim: false,
    heavyHeld: false,
    heavyEdge: false,
    attackEdge: false,
    readMove: (): { x: number; y: number; run: boolean } => ({ x: 0, y: 0, run: false }),
    takeJump: (): boolean => false,
    takeDodge: (): boolean => false,
    takeHeavy(): boolean {
      const edge = input.heavyEdge;
      input.heavyEdge = false;
      return edge;
    },
    takeAttack(): boolean {
      const edge = input.attackEdge;
      input.attackEdge = false;
      return edge;
    },
    isBlocking: (): boolean => input.aim,
    isHeavyHeld: (): boolean => input.heavyHeld,
  };
  return input;
}

test('Ranger charge keeps draw, releases, then returns to aim idle', () => {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles: [] };
  const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor('ranger'));
  const camera = { forward: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, -1) };
  const input = makeInput();

  input.aim = true;
  input.heavyHeld = true;
  input.heavyEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Ranged_Bow_Draw');
  assert.equal(player.isCharging, true);

  // Locomotion must not overwrite the authored draw while the key remains down.
  for (let i = 0; i < 20; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Ranged_Bow_Draw');

  input.heavyHeld = false;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Ranged_Bow_Release');
  assert.equal(player.isCharging, false);

  for (let i = 0; i < 60; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAttacking, false);
  assert.equal(rig.animator.playing, 'Ranged_Bow_Aiming_Idle');
});
