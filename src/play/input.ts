/**
 * Keyboard, mouse and touch input.
 *
 * Mouse: click the canvas to capture the pointer, then look with free mouse
 * movement; left click attacks, right-hold blocks, wheel zooms. Escape releases
 * the pointer (handled by the browser); clicking the canvas recaptures it.
 * Keyboard: WASD move, Shift run, Space jump, J light, K heavy, F block,
 * C/L dodge, Tab lock target, Q next target.
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

  /** Fired whenever pointer capture starts or stops. */
  onPointerLockChange: ((locked: boolean) => void) | null = null;

  private readonly held = new Set<string>();
  private attackQueued = false;
  private heavyQueued = false;
  private dodgeQueued = false;
  private jumpQueued = false;
  private lockToggleQueued = false;
  private lockNextQueued = false;
  private mouseBlock = false;
  private lookX = 0;
  private lookY = 0;
  private zoomQueued = 0;

  private pointerLocked = false;
  private lockDenied = false;
  private readonly lockSupported: boolean;
  private touchBlock = false;
  private tapCandidate: { x: number; y: number; time: number } | null = null;

  private stickId: number | null = null;
  private readonly stickOrigin = { x: 0, y: 0 };
  private readonly stickVector = { x: 0, y: 0 };

  private lookId: number | null = null;
  private readonly lookLast = { x: 0, y: 0 };
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly attackButton: HTMLButtonElement | null,
    private readonly stickElement: HTMLElement | null,
    private readonly lockButton: HTMLButtonElement | null = null,
    combatButtons: {
      heavy?: HTMLButtonElement | null;
      block?: HTMLButtonElement | null;
      dodge?: HTMLButtonElement | null;
    } = {},
  ) {
    this.lockSupported = typeof canvas.requestPointerLock === 'function';

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockEvent);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
    document.addEventListener('mousemove', this.onMouseMove);

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

    this.lockButton?.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.lockToggleQueued = true;
    });

    combatButtons.heavy?.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.heavyQueued = true;
    });

    combatButtons.dodge?.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.dodgeQueued = true;
    });

    const blockButton = combatButtons.block;
    if (blockButton) {
      blockButton.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.touchBlock = true;
        // Capture so releasing outside the button still clears the guard.
        try {
          blockButton.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic or rejected capture: the release listeners still run.
        }
      });

      const release = (): void => {
        this.touchBlock = false;
      };
      blockButton.addEventListener('pointerup', release);
      blockButton.addEventListener('pointercancel', release);
      blockButton.addEventListener('lostpointercapture', release);
      blockButton.addEventListener('contextmenu', (event) => event.preventDefault());
    }
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  /**
   * True while the pointer is free, so the UI can ask for a click to resume.
   * Once the browser has refused pointer lock, drag-look is the control scheme
   * and the prompt would be misleading.
   */
  get needsCapture(): boolean {
    return this.lockSupported && !this.pointerLocked && !this.touchCapable && !this.lockDenied;
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

  queueLockToggle(): void {
    this.lockToggleQueued = true;
  }

  queueLockNext(): void {
    this.lockNextQueued = true;
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

  takeLockToggle(): boolean {
    const queued = this.lockToggleQueued;
    this.lockToggleQueued = false;
    return queued;
  }

  takeLockNext(): boolean {
    const queued = this.lockNextQueued;
    this.lockNextQueued = false;
    return queued;
  }

  isBlocking(): boolean {
    return this.held.has('f') || this.mouseBlock || this.touchBlock || this.virtual.block;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();

    if (key === 'tab') {
      // Tab would otherwise move focus out of the game.
      event.preventDefault();
      if (!this.held.has('tab')) this.lockToggleQueued = true;
    }
    if (key === 'q' && !this.held.has('q')) this.lockNextQueued = true;

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
    this.touchBlock = false;
    this.tapCandidate = null;
    this.stickId = null;
    this.lookId = null;
    this.touches.clear();
    this.stickVector.x = 0;
    this.stickVector.y = 0;
    this.hideStick();
  };

  private readonly onPointerLockEvent = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (this.pointerLocked) {
      this.lockDenied = false;
      // Pointer capture owns the view now, so drop any drag in progress.
      this.lookId = null;
      this.tapCandidate = null;
    } else {
      // Releasing capture must not leave a stuck guard or movement key.
      this.mouseBlock = false;
      this.lookId = null;
    }
    this.onPointerLockChange?.(this.pointerLocked);
  };

  private readonly onPointerLockError = (): void => {
    // Denied (usually a non-gesture request, or a sandboxed frame). Drag-look
    // is the fallback, so stop advertising capture in the HUD.
    this.pointerLocked = false;
    this.lockDenied = true;
    this.onPointerLockChange?.(false);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.lookX += event.movementX;
    this.lookY += event.movementY;
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      this.onTouchDown(event);
      return;
    }

    if (this.pointerLocked) {
      if (event.button === 0) this.attackQueued = true;
      if (event.button === 2) this.mouseBlock = true;
      return;
    }

    if (event.button === 2) {
      this.mouseBlock = true;
      return;
    }

    if (event.button !== 0) return;

    // Track the drag unconditionally: if pointer lock is unavailable or the
    // request is denied, look control must still work immediately.
    this.lookId = event.pointerId;
    this.lookLast.x = event.clientX;
    this.lookLast.y = event.clientY;
    this.tapCandidate = { x: event.clientX, y: event.clientY, time: performance.now() };

    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events reject capture; dragging still works.
    }

    // The same click also starts a capture request; its success is what makes
    // the drag inert a moment later.
    if (this.lockSupported && !this.lockDenied) this.requestLock();
  };

  private requestLock(): void {
    const request = this.canvas.requestPointerLock();
    // Newer Chrome returns a promise that rejects when the gesture is lost.
    if (request && typeof (request as Promise<void>).catch === 'function') {
      (request as Promise<void>).catch(() => {
        this.pointerLocked = false;
        this.lockDenied = true;
      });
    }
  }

  private onTouchDown(event: PointerEvent): void {
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
  }

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

    if (event.pointerId === this.lookId) this.lookId = null;

    // A click that never became a drag attacks. The click that captured the
    // pointer is excluded, so starting mouse-look never swings the sword.
    const tap = this.tapCandidate;
    this.tapCandidate = null;
    if (tap && !this.pointerLocked) {
      const moved = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
      if (moved < 6 && performance.now() - tap.time < 350) this.attackQueued = true;
    }
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
