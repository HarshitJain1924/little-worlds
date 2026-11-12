import * as THREE from 'three';

/**
 * Flipbook combat VFX built from the SEAMPROOF 2048 px sprite sheets.
 *
 * Each sheet is an 8x8 atlas of 256 px cells, authored at 60 fps. The pack ships
 * 48-frame one-shots that finish early (trailing cells are fully transparent),
 * so every effect declares its real frame window instead of playing the sheet.
 *
 * Instances are pooled: geometry, mesh, material and texture are created once
 * per pool slot and only the texture offset and transform change per frame, so
 * a hit never allocates. Texture clones share their `source`, which keeps one
 * GPU upload per sheet no matter how many instances sample it.
 */

export type VfxKind =
  | 'slashLight'
  | 'slashHeavy'
  | 'impact'
  | 'impactHeavy'
  | 'landing'
  | 'dodgeDust';

type QualityTier = 'low' | 'medium' | 'high';

interface FlipbookDef {
  sheet: string;
  /** First and last cell actually containing pixels (8x8 grid, row-major). */
  first: number;
  last: number;
  /** Authored playback rate of the sheet. */
  fps: number;
  /** Additional timing scale applied on top of the authored rate. */
  speed: number;
  /** Width of the card in metres; the atlas cell is square. */
  size: number;
  /** Light effects add; dust and smoke must alpha-blend. */
  additive: boolean;
  /** Alpha-weighted centre of the drawn effect, normalized (x from left, y from top). */
  anchor: readonly [number, number];
  /** Track the weapon hand every frame instead of staying at the spawn point. */
  followHand?: boolean;
  /** Lie flat on the ground. */
  ground?: boolean;
  /** Extra metres above the anchor point. */
  lift?: number;
  /** Metres along the player's facing, for hand-tracked slashes. */
  forward?: number;
  /** In-plane roll in radians (billboards only). */
  roll?: number;
}

const GRID = 8;

const SHEETS = {
  slash: './vfx/slash_arc.png',
  ember: './vfx/ember_puff.png',
  dust: './vfx/landing_puff.png',
} as const;

/**
 * Frame windows measured from the delivered PNGs (max alpha per cell):
 *   slash_arc    content 0..33, peak at 8, nothing after 34
 *   ember_puff   content 0..41, peak at 2
 *   landing_puff content 0..42, peak at 25
 * The windows below stop at the last frame that still contributes, and the
 * slash starts at 2 because cells 0..1 are a single growing spark.
 */
const DEFS: Record<VfxKind, FlipbookDef> = {
  slashLight: {
    sheet: SHEETS.slash,
    first: 2,
    last: 20,
    fps: 60,
    speed: 1,
    size: 2.3,
    additive: true,
    anchor: [0.594, 0.347],
    followHand: true,
    forward: 0.5,
    lift: 0.22,
    roll: -0.18,
  },
  slashHeavy: {
    sheet: SHEETS.slash,
    first: 2,
    last: 24,
    fps: 60,
    speed: 0.92,
    size: 3.1,
    additive: true,
    anchor: [0.594, 0.347],
    followHand: true,
    forward: 0.55,
    lift: 0.3,
    roll: -0.7,
  },
  impact: {
    sheet: SHEETS.ember,
    first: 0,
    last: 41,
    fps: 60,
    speed: 1.15,
    size: 1.5,
    additive: true,
    anchor: [0.498, 0.557],
    lift: 0.9,
  },
  impactHeavy: {
    sheet: SHEETS.ember,
    first: 0,
    last: 41,
    fps: 60,
    speed: 1,
    size: 2.2,
    additive: true,
    anchor: [0.498, 0.557],
    lift: 1,
  },
  landing: {
    sheet: SHEETS.dust,
    first: 0,
    last: 42,
    fps: 60,
    speed: 1.1,
    size: 2.2,
    additive: false,
    anchor: [0.492, 0.603],
    ground: true,
    lift: 0.04,
  },
  dodgeDust: {
    sheet: SHEETS.dust,
    first: 0,
    last: 24,
    fps: 60,
    speed: 1.5,
    size: 1.25,
    additive: false,
    anchor: [0.492, 0.603],
    ground: true,
    lift: 0.03,
  },
};

/** Pool slots per effect, and what each quality tier is allowed to keep. */
const CAPACITY: Record<QualityTier, Record<VfxKind, number>> = {
  low: { slashLight: 0, slashHeavy: 0, impact: 0, impactHeavy: 0, landing: 0, dodgeDust: 0 },
  medium: { slashLight: 1, slashHeavy: 1, impact: 2, impactHeavy: 1, landing: 1, dodgeDust: 0 },
  high: { slashLight: 2, slashHeavy: 2, impact: 3, impactHeavy: 2, landing: 2, dodgeDust: 1 },
};

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

interface Instance {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.Texture;
  def: FlipbookDef;
  active: boolean;
  elapsed: number;
  frame: number;
  size: number;
  base: THREE.Vector3;
  yaw: number;
}

export class CombatVfx {
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly loader = new THREE.TextureLoader();
  private readonly sources = new Map<string, THREE.Texture>();
  private readonly pools = new Map<VfxKind, Instance[]>();

  private readonly offset = new THREE.Vector3();
  private readonly hand = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly roll = new THREE.Quaternion();

  private quality: QualityTier = 'high';

  constructor(
    scene: THREE.Scene,
    private readonly sampleHand: (out: THREE.Vector3) => void,
  ) {
    this.group.name = 'combat-vfx';
    scene.add(this.group);
  }

  setQuality(level: QualityTier): void {
    this.quality = level;

    // Retire anything the new tier no longer allows, and re-filter the textures
    // so medium drops mipmaps (the only tier that does).
    for (const [kind, pool] of this.pools) {
      const limit = CAPACITY[level][kind];
      for (let i = 0; i < pool.length; i += 1) {
        const instance = pool[i];
        if (i >= limit) this.retire(instance);
        this.applyTextureSettings(instance.texture);
      }
    }

    if (level === 'low') {
      this.clear();
      return;
    }

    // Warm the sheets at the first tier that can use them, so the first swing
    // does not pop a bare white quad while the PNG is still decoding.
    this.preload();
  }

  /** Nothing on low; otherwise the three selected sheets only. */
  private preload(): void {
    if (this.quality === 'low') return;
    for (const url of Object.values(SHEETS)) this.source(url);
  }

  spawn(kind: VfxKind, position: THREE.Vector3, yaw = 0): void {
    const limit = CAPACITY[this.quality][kind];
    if (limit <= 0) return;

    const source = this.source(DEFS[kind].sheet);
    // Still decoding: skip rather than show an untextured white card.
    if (!source.image) return;

    const pool = this.poolFor(kind, limit);
    const available = Math.min(limit, pool.length);

    let instance: Instance | null = null;
    for (let i = 0; i < available; i += 1) {
      if (!pool[i].active) {
        instance = pool[i];
        break;
      }
    }

    if (!instance) {
      // Exhausted: reuse whichever slot is furthest through its animation. The
      // oldest effect is the least missed, and the pool never grows past its cap.
      instance = pool[0];
      for (let i = 1; i < available; i += 1) {
        if (pool[i].elapsed > instance.elapsed) instance = pool[i];
      }
    }

    instance.def = DEFS[kind];
    instance.size = DEFS[kind].size;
    instance.base.copy(position);
    instance.yaw = yaw;
    instance.elapsed = 0;
    instance.active = true;
    instance.mesh.visible = true;
    instance.mesh.scale.setScalar(instance.size);
    this.applyFrame(instance, DEFS[kind].first);
  }

  update(delta: number, camera: THREE.Camera): void {
    if (this.quality === 'low') return;

    for (const pool of this.pools.values()) {
      for (const instance of pool) {
        if (!instance.active) continue;

        instance.elapsed += delta * instance.def.speed;
        const index = instance.def.first + Math.floor(instance.elapsed * instance.def.fps);

        if (index > instance.def.last) {
          this.retire(instance);
          continue;
        }

        if (index !== instance.frame) this.applyFrame(instance, index);
        this.place(instance, camera);
      }
    }
  }

  clear(): void {
    for (const pool of this.pools.values()) {
      for (const instance of pool) this.retire(instance);
    }
  }

  dispose(): void {
    this.clear();

    for (const pool of this.pools.values()) {
      for (const instance of pool) {
        instance.mesh.material.dispose();
        instance.texture.dispose();
      }
    }
    this.pools.clear();

    for (const texture of this.sources.values()) texture.dispose();
    this.sources.clear();

    this.geometry.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }

  private poolFor(kind: VfxKind, limit: number): Instance[] {
    let pool = this.pools.get(kind);
    if (!pool) {
      pool = [];
      this.pools.set(kind, pool);
    }

    while (pool.length < limit) pool.push(this.createInstance(DEFS[kind], pool.length));
    return pool;
  }

  private createInstance(def: FlipbookDef, index: number): Instance {
    const base = this.source(def.sheet);
    // Clones share `source`, so all instances of a sheet share one GPU upload.
    const texture = base.clone();
    texture.name = `${def.sheet}#${index}`;
    texture.repeat.set(1 / GRID, 1 / GRID);
    texture.offset.set(0, 0);
    this.applyTextureSettings(texture);

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: false,
      blending: def.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    this.group.add(mesh);

    return {
      mesh,
      texture,
      def,
      active: false,
      elapsed: 0,
      frame: -1,
      size: def.size,
      base: new THREE.Vector3(),
      yaw: 0,
    };
  }

  private applyFrame(instance: Instance, index: number): void {
    instance.frame = index;
    const column = index % GRID;
    const row = Math.floor(index / GRID);
    // flipY is on, so row 0 of the atlas is the top row of the image.
    instance.texture.offset.set(column / GRID, 1 - (row + 1) / GRID);
  }

  private place(instance: Instance, camera: THREE.Camera): void {
    const mesh = instance.mesh;
    const def = instance.def;
    const size = instance.size;

    if (def.ground) {
      mesh.quaternion.setFromAxisAngle(UP, instance.yaw).multiply(FLAT);
    } else {
      mesh.quaternion.copy(camera.quaternion);
      if (def.roll) mesh.quaternion.multiply(this.roll.setFromAxisAngle(FORWARD, def.roll));
    }

    if (def.followHand) {
      this.sampleHand(this.hand);
      mesh.position.copy(this.hand);
      this.dir.set(Math.sin(instance.yaw), 0, Math.cos(instance.yaw));
      mesh.position.addScaledVector(this.dir, def.forward ?? 0);
    } else {
      mesh.position.copy(instance.base);
    }

    // Shift the card so the drawn effect's centre lands on the anchor point.
    this.offset
      .set(-(def.anchor[0] - 0.5) * size, (def.anchor[1] - 0.5) * size, 0)
      .applyQuaternion(mesh.quaternion);
    mesh.position.add(this.offset);

    if (def.lift) mesh.position.y += def.lift;
  }

  private retire(instance: Instance): void {
    instance.active = false;
    instance.mesh.visible = false;
  }

  private source(url: string): THREE.Texture {
    let texture = this.sources.get(url);
    if (texture) return texture;

    texture = this.loader.load(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    // The pack is straight, not premultiplied, alpha.
    texture.premultiplyAlpha = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(1 / GRID, 1 / GRID);
    this.applyTextureSettings(texture);
    this.sources.set(url, texture);
    return texture;
  }

  /** Mipmaps are cheap at close range but not on a 2048 atlas in a mobile tier. */
  private applyTextureSettings(texture: THREE.Texture): void {
    const mip = this.quality !== 'medium';
    if (texture.generateMipmaps !== mip) {
      texture.generateMipmaps = mip;
      texture.needsUpdate = true;
    }
    texture.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
  }
}
