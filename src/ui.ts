import { QUALITY } from './config';
import type { QualityName } from './config';

const statsElement = document.querySelector<HTMLDivElement>('#stats');
const qualityElement = document.querySelector<HTMLDivElement>('#quality');
const loadingElement = document.querySelector<HTMLDivElement>('#loading');
const loadingFill = document.querySelector<HTMLSpanElement>('#loading-fill');
const loadingLabel = document.querySelector<HTMLParagraphElement>('#loading-label');

export interface Stats {
  update: (values: { fps: number | null; frameMs: number | null; drawCalls: number; triangles: number }, preset: QualityName) => void;
}

export function createStats(context: { antialias: boolean }): Stats {
  let fps: number | null = null;
  let frameMs: number | null = null;
  let drawCalls = 0;
  let triangles = 0;

  const render = (preset: QualityName) => {
    if (!statsElement) return;
    statsElement.textContent = [
      `fps    ${fps === null ? '  —' : fps.toFixed(0).padStart(3)}  (${frameMs === null ? '—' : frameMs.toFixed(1)} ms)`,
      `draws  ${drawCalls}`,
      `tris   ${(triangles / 1000).toFixed(1)}k`,
      // MSAA is decided when the WebGL context is created and cannot change after,
      // so it is shown as the real context state, not as a preset property.
      `preset ${QUALITY[preset].label.toLowerCase()} · aa ${context.antialias ? 'on' : 'off'}`,
    ].join('\n');
  };

  return {
    update(values, preset) {
      fps = values.fps;
      frameMs = values.frameMs;
      drawCalls = values.drawCalls;
      triangles = values.triangles;
      render(preset);
    },
  };
}

export function createQualityControl(
  current: QualityName,
  onChange: (name: QualityName) => void,
): (name: QualityName) => void {
  const buttons = new Map<QualityName, HTMLButtonElement>();

  if (qualityElement) {
    for (const name of Object.keys(QUALITY) as QualityName[]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = QUALITY[name].label;
      button.setAttribute('aria-pressed', String(name === current));
      button.addEventListener('click', () => onChange(name));
      qualityElement.append(button);
      buttons.set(name, button);
    }
  }

  return (name) => {
    for (const [key, button] of buttons) {
      button.setAttribute('aria-pressed', String(key === name));
    }
  };
}

export function setLoading(progress: number, label?: string): void {
  if (loadingFill) loadingFill.style.width = `${Math.round(progress * 100)}%`;
  if (label && loadingLabel) loadingLabel.textContent = label;
}

export function hideLoading(): void {
  if (!loadingElement) return;
  loadingElement.classList.add('is-hidden');
  // Remove it entirely afterwards: CSS transitions do not run in a background
  // tab, and a half-faded overlay would sit over the scene.
  window.setTimeout(() => loadingElement.remove(), 500);
}
