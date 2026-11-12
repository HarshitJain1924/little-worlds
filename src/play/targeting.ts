/**
 * Target selection for the action-RPG camera.
 *
 * A small registered list of candidates is scored on distance, camera angle,
 * player facing and line of sight. Scoring runs on an interval (not per render
 * frame), and visibility uses the world's analytic collision proxies rather than
 * a scene-wide raycast.
 */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Targetable {
  readonly position: Point3;
  readonly alive: boolean;
}

export interface TargetScoring {
  player: Point3;
  /** Camera forward projected on the ground plane. */
  cameraForward: { x: number; z: number };
  /** Character facing on the ground plane. */
  playerForward: { x: number; z: number };
  maxRange: number;
  maxAngle: number;
}

export interface TargetTrackerConfig {
  maxRange: number;
  /** Distance at which an existing lock is dropped. */
  releaseRange: number;
  /** Half-angle of the acceptance cone around the camera forward. */
  maxAngle: number;
  /** Seconds between full re-scoring passes. */
  perceptionInterval: number;
  /** Seconds a target may be out of sight before the lock breaks. */
  lostSightGrace: number;
  isVisible: (from: Point3, to: Point3) => boolean;
}

const DEFAULTS: TargetTrackerConfig = {
  maxRange: 16,
  releaseRange: 22,
  maxAngle: Math.PI * 0.55,
  perceptionInterval: 0.2,
  lostSightGrace: 1.2,
  isVisible: () => true,
};

const angleBetween = (ax: number, az: number, bx: number, bz: number): number => {
  const aLength = Math.hypot(ax, az);
  const bLength = Math.hypot(bx, bz);
  if (aLength < 1e-5 || bLength < 1e-5) return 0;
  const cosine = (ax * bx + az * bz) / (aLength * bLength);
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
};

/**
 * Higher is better. Returns -1 when the candidate is outside the acceptance
 * cone or range, so callers can skip it entirely.
 */
export function scoreTarget(
  target: Targetable,
  scoring: TargetScoring,
  visible: boolean,
): number {
  if (!target.alive) return -1;

  const dx = target.position.x - scoring.player.x;
  const dz = target.position.z - scoring.player.z;
  const distance = Math.hypot(dx, dz);

  if (distance > scoring.maxRange) return -1;

  const cameraAngle = angleBetween(scoring.cameraForward.x, scoring.cameraForward.z, dx, dz);
  if (cameraAngle > scoring.maxAngle) return -1;

  // Out of sight is still selectable, but heavily deprioritised; a target that
  // is merely behind a bush should not beat one standing in the open.
  const distanceScore = 1 - distance / scoring.maxRange;
  const cameraScore = 1 - cameraAngle / scoring.maxAngle;
  const facingScore = 1 - angleBetween(scoring.playerForward.x, scoring.playerForward.z, dx, dz) / Math.PI;

  const score = distanceScore * 0.45 + cameraScore * 0.35 + facingScore * 0.2;
  return visible ? score : score * 0.3;
}

export class TargetTracker<T extends Targetable> {
  private readonly config: TargetTrackerConfig;
  private readonly targets: T[] = [];
  private readonly ranked: { target: T; score: number }[] = [];

  private softTarget: T | null = null;
  private lockedTarget: T | null = null;
  private lockIndex = 0;
  private sightTimer = 0;
  private perceptionTimer = 0;

  /** Increases as a lock is held; the HUD fades the indicator in with it. */
  lockAge = 0;

  constructor(config: Partial<TargetTrackerConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  register(target: T): void {
    if (!this.targets.includes(target)) this.targets.push(target);
  }

  unregister(target: T): void {
    const index = this.targets.indexOf(target);
    if (index >= 0) this.targets.splice(index, 1);
    if (this.softTarget === target) this.softTarget = null;
    if (this.lockedTarget === target) this.release();
  }

  get soft(): T | null {
    return this.softTarget;
  }

  get locked(): T | null {
    return this.lockedTarget;
  }

  get isLocked(): boolean {
    return this.lockedTarget !== null;
  }

  /** The target an attack should prefer: hard lock, then soft lock. */
  get preferred(): T | null {
    return this.lockedTarget ?? this.softTarget;
  }

  update(scoring: TargetScoring, delta: number): void {
    this.perceptionTimer += delta;

    if (this.lockedTarget) {
      this.lockAge += delta;
      this.validateLock(scoring, delta);
    } else {
      this.lockAge = Math.max(0, this.lockAge - delta * 4);
    }

    if (this.perceptionTimer < this.config.perceptionInterval) return;
    this.perceptionTimer = 0;

    this.rescore(scoring);

    if (!this.lockedTarget) {
      this.softTarget = this.ranked[0]?.target ?? null;
      this.lockIndex = 0;
      return;
    }

    // Keep the lock's index aligned so `cycle` walks from the active target.
    const index = this.ranked.findIndex((entry) => entry.target === this.lockedTarget);
    if (index >= 0) this.lockIndex = index;
  }

  /** Lock the best target, or release the current lock. */
  toggleLock(scoring: TargetScoring): T | null {
    if (this.lockedTarget) {
      this.release();
      return null;
    }

    this.rescore(scoring);
    const candidate = this.ranked[0]?.target ?? this.softTarget;
    if (candidate && candidate.alive) {
      this.lockedTarget = candidate;
      this.softTarget = candidate;
      this.lockAge = 0;
      this.sightTimer = 0;
      this.lockIndex = 0;
    }
    return this.lockedTarget;
  }

  /** Walk to the next valid candidate while locked. */
  cycle(scoring: TargetScoring): T | null {
    if (!this.lockedTarget) return this.toggleLock(scoring);

    this.rescore(scoring);
    if (this.ranked.length === 0) {
      this.release();
      return null;
    }

    this.lockIndex = (this.lockIndex + 1) % this.ranked.length;
    this.lockedTarget = this.ranked[this.lockIndex].target;
    this.lockAge = 0;
    this.sightTimer = 0;
    return this.lockedTarget;
  }

  release(): void {
    this.lockedTarget = null;
    this.lockAge = 0;
    this.sightTimer = 0;
  }

  private rescore(scoring: TargetScoring): void {
    this.ranked.length = 0;

    for (const target of this.targets) {
      const visible = this.config.isVisible(scoring.player, target.position);
      const score = scoreTarget(target, scoring, visible);
      if (score >= 0) this.ranked.push({ target, score });
    }

    this.ranked.sort((a, b) => b.score - a.score);
  }

  /** Drops the lock when the target dies, escapes, or stays hidden too long. */
  private validateLock(scoring: TargetScoring, delta: number): boolean {
    const target = this.lockedTarget;
    if (!target) return false;

    if (!target.alive) {
      this.release();
      return false;
    }

    const distance = Math.hypot(
      target.position.x - scoring.player.x,
      target.position.z - scoring.player.z,
    );

    if (distance > this.config.releaseRange) {
      this.release();
      return false;
    }

    if (this.config.isVisible(scoring.player, target.position)) {
      this.sightTimer = 0;
      return true;
    }

    this.sightTimer += delta;
    if (this.sightTimer > this.config.lostSightGrace) {
      this.release();
      return false;
    }

    return true;
  }
}
