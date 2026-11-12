import * as THREE from 'three';
import type { Enemy } from './enemy';

interface Bar {
  root: HTMLElement;
  fill: HTMLElement;
}

const scratch = new THREE.Vector3();

export class Hud {
  private readonly hpFill = document.querySelector<HTMLElement>('#hp-fill');
  private readonly statsEl = document.querySelector<HTMLElement>('#stats');
  private readonly barsLayer = document.querySelector<HTMLElement>('#enemy-bars');
  private readonly flashEl = document.querySelector<HTMLElement>('#flash');
  private readonly bannerEl = document.querySelector<HTMLElement>('#banner');
  private readonly objectiveEl = document.querySelector<HTMLElement>('#objective');

  private readonly bars = new Map<Enemy, Bar>();
  private flashTimer = 0;

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
  }
}
