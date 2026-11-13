

// ---- minimal DOM ----------------------------------------------------------
class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.listeners = new Map(); this.style = {}; this.hidden = false;
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.firstElementChild = null; this.captured = 0;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (const fn of this.listeners.get(event.type) ?? []) fn(event);
    return true;
  }
  setPointerCapture() { this.captured += 1; }
  requestPointerLock() { return Promise.resolve(); }
}
const docListeners = new Map();
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  innerWidth: 1280, innerHeight: 720,
};
globalThis.document = {
  pointerLockElement: null,
  addEventListener(type, fn) { if (!docListeners.has(type)) docListeners.set(type, []); docListeners.get(type).push(fn); },
};
const fireDoc = (type) => { for (const fn of docListeners.get(type) ?? []) fn({ type }); };

const { InputController } = await import('./src/play/input.ts');

const canvas = new El('canvas');
const attack = new El('button');
const heavy = new El('button');
const block = new El('button');
const dodge = new El('button');
const lock = new El('button');
const input = new InputController(canvas, attack, null, lock, { heavy, block, dodge });

const ev = (type, props) => ({ type, pointerType: 'mouse', pointerId: 1, clientX: 0, clientY: 0, preventDefault() {}, ...props });

// Enter pointer lock the way the browser would.
document.pointerLockElement = canvas;
fireDoc('pointerlockchange');
console.log('pointer locked:', input.isPointerLocked);

// Hold RMB (aim), then click LMB (fire).
canvas.dispatchEvent(ev('pointerdown', { button: 2 }));
console.log('after RMB down → isBlocking:', input.isBlocking());
canvas.dispatchEvent(ev('pointerdown', { button: 0 }));
console.log('after LMB down while aiming → takeAttack:', input.takeAttack());
console.log('after LMB down while aiming → isBlocking still:', input.isBlocking());

// Same thing through the touch buttons (mobile parity).
block.dispatchEvent(ev('pointerdown', { pointerType: 'touch', button: 0 }));
console.log('\ntouch: block down → isBlocking:', input.isBlocking());
attack.dispatchEvent(ev('pointerdown', { pointerType: 'touch', button: 0 }));
console.log('touch: attack button → takeAttack:', input.takeAttack());
block.dispatchEvent(ev('pointerup', { pointerType: 'touch', button: 0 }));
console.log('touch: block up → isBlocking:', input.isBlocking());
