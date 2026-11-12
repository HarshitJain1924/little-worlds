import * as THREE from 'three';
import type { Enemy } from './enemy';

interface Bar {
  root: HTMLElement;
  fill: HTMLElement;
}

interface DamageNumber {
  el: HTMLSpanElement;
  world: THREE.Vector3;
  age: number;
  life: number;
  drift: number;
}

export type DamageKind = 'dealt' | 'taken' | 'blocked';

const scratch = new THREE.Vector3();

export class Hud {
  private readonly hpFill = document.querySelector<HTMLElement>('#hp-fill');
  private readonly statsEl = document.querySelector<HTMLElement>('#stats');
  private readonly barsLayer = document.querySelector<HTMLElement>('#enemy-bars');
  private readonly flashEl = document.querySelector<HTMLElement>('#flash');
  private readonly bannerEl = document.querySelector<HTMLElement>('#banner');
  private readonly objectiveEl = document.querySelector<HTMLElement>('#objective');
  private readonly targetEl = document.querySelector<HTMLElement>('#target');
  private readonly targetLabel = document.querySelector<HTMLElement>('#target .label');
  private readonly captureEl = document.querySelector<HTMLElement>('#capture');
  private readonly numbersLayer = document.querySelector<HTMLElement>('#damage-numbers');

  private readonly bars = new Map<Enemy, Bar>();
  private readonly numbers: DamageNumber[] = [];
  private readonly numberPool: HTMLSpanElement[] = [];
  private flashTimer = 0;
  private targetEnemy: Enemy | null = null;
  private targetLocked = false;

  register(enemy: Enemy): void {
    if (!this.barsLayer) return;

    const root = document.createElement('div');
    root.className = 'enemy-bar';
    const fill = document.createElement('span');
    root.append(fill);
    this.barsLayer.append(root);

    this.bars.set(enemy, { root, fill });
  }

  setHealth(value: number, max: number): void {
    if (!this.hpFill) return;
    const ratio = Math.max(0, Math.min(1, value / max));
    this.hpFill.style.transform = `scaleX(${ratio})`;
  }

  setStats(text: string): void {
    if (this.statsEl) this.statsEl.textContent = text;
  }

  setObjective(text: string): void {
    if (this.objectiveEl) this.objectiveEl.textContent = text;
  }

  /** Soft-selected or hard-locked target shown above the enemy. */
  setTarget(enemy: Enemy | null, locked: boolean): void {
    if (enemy !== this.targetEnemy) {
      if (this.targetLabel) this.targetLabel.textContent = enemy ? enemy.config.label : '';
    }
    this.targetEnemy = enemy;

    if (locked !== this.targetLocked) {
      this.targetEl?.classList.toggle('is-locked', locked);
      this.targetLocked = locked;
    }
  }

  setCaptureHint(visible: boolean): void {
    if (this.captureEl) this.captureEl.hidden = !visible;
  }

  showBanner(text: string | null): void {
    if (!this.bannerEl) return;
    if (text === null) {
      this.bannerEl.hidden = true;
      return;
    }
    const paragraph = this.bannerEl.querySelector('p');
    if (paragraph) paragraph.textContent = text;
    this.bannerEl.hidden = false;
  }

  flash(): void {
    if (!this.flashEl) return;
    this.flashTimer = 0.22;
    this.flashEl.style.opacity = '0.85';
  }

  /** Floating combat text anchored to a world position. */
  damageNumber(
    position: { x: number; y: number; z: number },
    amount: number,
    kind: DamageKind = 'dealt',
  ): void {
    const layer = this.numbersLayer;
    if (!layer) return;

    const value = Math.max(1, Math.round(amount));
    const el = this.numberPool.pop() ?? document.createElement('span');
    el.className = `dmg ${kind}`;
    el.textContent = kind === 'taken' ? `-${value}` : kind === 'blocked' ? `${value} block` : `${value}`;
    el.style.opacity = '1';
    el.style.display = 'block';
    if (!el.parentElement) layer.append(el);

    this.numbers.push({
      el,
      world: new THREE.Vector3(position.x, position.y + 1.95, position.z),
      age: 0,
      life: 0.9,
      drift: (Math.random() - 0.5) * 0.5,
    });

    // Cap concurrent labels so a long fight cannot grow the DOM unboundedly.
    while (this.numbers.length > 16) {
      const oldest = this.numbers.shift();
      if (oldest) this.retire(oldest);
    }
  }

  update(delta: number, camera: THREE.Camera, width: number, height: number): void {
    if (this.flashTimer > 0) {
      this.flashTimer -= delta;
      if (this.flashTimer <= 0 && this.flashEl) this.flashEl.style.opacity = '0';
    }

    for (const [enemy, bar] of this.bars) {
      if (!enemy.alive) {
        bar.root.style.display = 'none';
        continue;
      }

      scratch.set(enemy.position.x, enemy.position.y + 3.1, enemy.position.z).project(camera);
      const visible = scratch.z > -1 && scratch.z < 1 && Math.abs(scratch.x) < 1.35 && Math.abs(scratch.y) < 1.5;

      if (!visible) {
        bar.root.style.display = 'none';
        continue;
      }

      bar.root.style.display = 'block';
      bar.root.style.left = `${(scratch.x * 0.5 + 0.5) * width}px`;
      bar.root.style.top = `${(-scratch.y * 0.5 + 0.5) * height}px`;
      bar.fill.style.transform = `scaleX(${Math.max(0, enemy.health / enemy.config.maxHealth)})`;
    }

    this.updateNumbers(delta, camera, width, height);
    this.updateTargetIndicator(camera, width, height);
  }

  private updateNumbers(delta: number, camera: THREE.Camera, width: number, height: number): void {
    for (let i = this.numbers.length - 1; i >= 0; i -= 1) {
      const item = this.numbers[i];
      item.age += delta;

      if (item.age >= item.life) {
        this.numbers.splice(i, 1);
        this.retire(item);
        continue;
      }

      const t = item.age / item.life;
      scratch.set(item.world.x + item.drift * t, item.world.y + t * 1.15, item.world.z).project(camera);

      if (scratch.z < -1 || scratch.z > 1 || Math.abs(scratch.x) > 1.4 || Math.abs(scratch.y) > 1.4) {
        item.el.style.display = 'none';
        continue;
      }

      item.el.style.display = 'block';
      item.el.style.left = `${(scratch.x * 0.5 + 0.5) * width}px`;
      item.el.style.top = `${(-scratch.y * 0.5 + 0.5) * height}px`;
      item.el.style.opacity = `${Math.max(0, 1 - t * t)}`;
      item.el.style.transform = `translate(-50%, -50%) scale(${(1 + (1 - t) * 0.18).toFixed(3)})`;
    }
  }

  private retire(item: DamageNumber): void {
    item.el.style.display = 'none';
    this.numberPool.push(item.el);
  }

  private updateTargetIndicator(camera: THREE.Camera, width: number, height: number): void {
    const el = this.targetEl;
    if (!el) return;

    const target = this.targetEnemy;
    if (!target || !target.alive) {
      if (!el.hidden) el.hidden = true;
      return;
    }

    scratch.set(target.position.x, target.position.y + 3.65, target.position.z).project(camera);
    const onScreen = scratch.z > -1 && scratch.z < 1 && Math.abs(scratch.x) < 1.25 && Math.abs(scratch.y) < 1.25;
    if (!onScreen) {
      if (!el.hidden) el.hidden = true;
      return;
    }

    if (el.hidden) el.hidden = false;
    el.style.left = `${(scratch.x * 0.5 + 0.5) * width}px`;
    el.style.top = `${(-scratch.y * 0.5 + 0.5) * height}px`;
  }
}
