import * as THREE from 'three';
const { Player } = await import('./src/play/player.ts');
const { profileFor } = await import('./src/play/movesets.ts');

const played = [];
const rig = {
  root: new THREE.Object3D(),
  animator: {
    play(name) { played.push(name); this.current = name; },
    clipDuration: () => 1.33,
    get playing() { return this.current ?? ''; },
  },
  update() {},
  flash() {},
  dispose() {},
};

const world = { heightAt: () => 0, blockers: [], obstacles: [] };
const camera = { forward: (out) => out.set(0, 0, 1) };

const player = new Player(rig, world, { x: 0, z: 0 }, profileFor('ranger'));
let shots = 0;
player.onRangedShot = (attack) => { shots += 1; lastShot = attack.clip; };
let lastShot = null;

let block = false;
let attackFrame = -1;
const input = {
  readMove: () => ({ x: 0, y: 0, run: false }),
  takeJump: () => false,
  takeDodge: () => false,
  takeHeavy: () => false,
  takeAttack: () => false,
  isBlocking: () => block,
};

block = true;
for (let frame = 0; frame < 90; frame += 1) {
  input.takeAttack = () => frame === 10;
  player.update(1 / 60, input, camera);
  if (frame === 9) console.log('pre-press: aiming=', player.isAiming, 'clip=', player.rig.animator.playing);
  if (frame === 10) console.log('press frame: attacking=', player.isAttacking, 'clip=', player.rig.animator.playing);
  if (frame === 11) console.log('post frame: clip=', player.rig.animator.playing, 'shots=', shots);
}
console.log('shots fired while aiming held:', shots, 'clip:', lastShot);
console.log('aiming at end:', player.isAiming, 'clip at end:', player.rig.animator.playing);
console.log('clips played:', [...new Set(played)].join(', '));

// heavy while aiming
block = true;
let heavyShots = 0;
player.onRangedShot = () => { heavyShots += 1; };
for (let frame = 0; frame < 60; frame += 1) {
  input.takeAttack = () => false;
  input.takeHeavy = () => frame === 5;
  player.update(1 / 60, input, camera);
}
console.log('heavy shots while aiming:', heavyShots);
