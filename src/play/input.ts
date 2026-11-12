/**
 * Keyboard, mouse and touch input.
 *
 * Mouse: left-drag to look, left-click to attack, right-hold to block, wheel to zoom.
 * Keyboard: WASD move, Shift run, Space jump, J light, K heavy, F block, C/L dodge.
 * Touch: left half is a virtual stick, right half looks, two fingers pinch-zoom.
 */

const STICK_RADIUS = 52;

export interface MoveInput {
  /** Camera-relative strafe, -1..1. */
  x: number;
  /** Camera-relative forward, -1..1. */
  y: number;
  run: boolean;
}

export interface LookDelta {
  x: number;
  y: number;
}

export class InputController {
  readonly touchCapable = window.matchMedia('(pointer: coarse)').matches;

  /** Direct state injection for scripted verification; unused by real input. */
  readonly virtual = { x: 0, y: 0, run: false, block: false };

  private readonly held = new Set<string>();
  private attackQueued = false;
  private heavyQueued = false;
  private dodgeQueued = false;
  private jumpQueued = false;
  private mouseBlock = false;
  private lookX = 0;
  private lookY = 0;
  private zoomQueued = 0;

  private stickId: number | null = null;
  private readonly stickOrigin = { x: 0, y: 0 };
  private readonly stickVector = { x: 0, y: 0 };

  private lookId: number | null = null;
  private readonly lookLast = { x: 0, y: 0 };
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;
  private tapCandidate: { x: number; y: number; time: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly attackButton: HTMLButtonElement | null,
    private readonly stickElement: HTMLElement | null,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this.attackButton?.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.attackQueued = true;
    });
  }

  readMove(): MoveInput {
    let x = 0;
    let y = 0;

    if (this.held.has('w') || this.held.has('arrowup')) y += 1;
    if (this.held.has('s') || this.held.has('arrowdown')) y -= 1;
    if (this.held.has('a') || this.held.has('arrowleft')) x -= 1;
    if (this.held.has('d') || this.held.has('arrowright')) x += 1;

    x += this.stickVector.x + this.virtual.x;
    y += this.stickVector.y + this.virtual.y;

    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }

    return { x, y, run: this.held.has('shift') || this.virtual.run };
  }

  queueAttack(): void {
    this.attackQueued = true;
  }

  queueHeavy(): void {
    this.heavyQueued = true;
  }

  queueDodge(): void {
    this.dodgeQueued = true;
  }

  queueJump(): void {
    this.jumpQueued = true;
  }

  takeLook(): LookDelta {
    const delta = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return delta;
  }

  takeZoom(): number {
    const zoom = this.zoomQueued;
    this.zoomQueued = 0;
    return zoom;
  }

  takeAttack(): boolean {
    const queued = this.attackQueued;
    this.attackQueued = false;
    return queued;
  }

  takeHeavy(): boolean {
    const queued = this.heavyQueued;
    this.heavyQueued = false;
    return queued;
  }

  takeDodge(): boolean {
    const queued = this.dodgeQueued;
    this.dodgeQueued = false;
    return queued;
  }

  takeJump(): boolean {
    const queued = this.jumpQueued;
    this.jumpQueued = false;
    return queued;
  }

  isBlocking(): boolean {
    return this.held.has('f') || this.mouseBlock || this.virtual.block;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();

    if (key === ' ') {
      event.preventDefault();
      if (!this.held.has(' ')) this.jumpQueued = true;
    }
    if (key === 'j' && !this.held.has('j')) this.attackQueued = true;
    if (key === 'k' && !this.held.has('k')) this.heavyQueued = true;
    if ((key === 'c' || key === 'l') && !this.held.has(key)) this.dodgeQueued = true;

    this.held.add(key);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.key.toLowerCase());
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.mouseBlock = false;
    this.stickId = null;
    this.lookId = null;
    this.touches.clear();
    this.stickVector.x = 0;
    this.stickVector.y = 0;
    this.hideStick();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events (and a few browsers) reject capture; dragging
      // still works while the pointer stays over the canvas, which fills the viewport.
    }

    if (event.pointerType === 'touch') {
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (this.touches.size >= 2) {
        this.pinchDistance = this.touchSpan();
        return;
      }

      if (event.clientX < window.innerWidth * 0.5 && this.stickId === null) {
        this.stickId = event.pointerId;
        this.stickOrigin.x = event.clientX;
        this.stickOrigin.y = event.clientY;
        this.stickVector.x = 0;
        this.stickVector.y = 0;
        this.showStick();
        return;
      }

      this.lookId = event.pointerId;
      this.lookLast.x = event.clientX;
      this.lookLast.y = event.clientY;
      return;
    }

    if (event.button === 2) {
      this.mouseBlock = true;
      return;
    }

    this.lookId = event.pointerId;
    this.lookLast.x = event.clientX;
    this.lookLast.y = event.clientY;
    this.tapCandidate = event.button === 0 ? { x: event.clientX, y: event.clientY, time: performance.now() } : null;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      if (this.touches.has(event.pointerId)) {
        this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      if (this.touches.size >= 2) {
        const span = this.touchSpan();
        if (this.pinchDistance > 0 && span > 0) this.zoomQueued += (this.pinchDistance - span) * 0.004;
        this.pinchDistance = span;
        return;
      }

      if (event.pointerId === this.stickId) {
        const dx = event.clientX - this.stickOrigin.x;
        const dy = event.clientY - this.stickOrigin.y;
        const length = Math.hypot(dx, dy);
        const scale = length > STICK_RADIUS ? STICK_RADIUS / length : 1;
        this.stickVector.x = (dx * scale) / STICK_RADIUS;
        this.stickVector.y = (-dy * scale) / STICK_RADIUS;
        this.moveKnob(dx * scale, dy * scale);
        return;
      }
    }

    if (event.pointerId === this.lookId) {
      this.lookX += event.clientX - this.lookLast.x;
      this.lookY += event.clientY - this.lookLast.y;
      this.lookLast.x = event.clientX;
      this.lookLast.y = event.clientY;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      this.touches.delete(event.pointerId);
      if (this.touches.size < 2) this.pinchDistance = 0;

      if (event.pointerId === this.stickId) {
        this.stickId = null;
        this.stickVector.x = 0;
        this.stickVector.y = 0;
        this.hideStick();
      }
      if (event.pointerId === this.lookId) this.lookId = null;
      return;
    }

    if (event.button === 2) {
      this.mouseBlock = false;
      return;
    }

    // A left click that never moved is an attack, not a camera drag.
    if (this.tapCandidate && event.pointerId === this.lookId) {
      const dx = event.clientX - this.tapCandidate.x;
      const dy = event.clientY - this.tapCandidate.y;
      const quick = performance.now() - this.tapCandidate.time < 350;
      if (Math.hypot(dx, dy) < 6 && quick) this.attackQueued = true;
    }
    this.tapCandidate = null;
    if (event.pointerId === this.lookId) this.lookId = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomQueued += event.deltaY * 0.0022;
  };

  private touchSpan(): number {
    const [first, second] = [...this.touches.values()];
    if (!first || !second) return 0;
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  private showStick(): void {
    if (!this.stickElement) return;
    this.stickElement.hidden = false;
    this.stickElement.style.left = `${this.stickOrigin.x}px`;
    this.stickElement.style.top = `${this.stickOrigin.y}px`;
    this.moveKnob(0, 0);
  }

  private moveKnob(dx: number, dy: number): void {
    const knob = this.stickElement?.firstElementChild as HTMLElement | null;
    if (!knob) return;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  private hideStick(): void {
    if (this.stickElement) this.stickElement.hidden = true;
  }
}
