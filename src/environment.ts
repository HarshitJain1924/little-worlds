import * as THREE from 'three';
import { PALETTE, SITES, WORLD } from './config';
import { pondRadius, terrainHeightAt } from './terrain';

/** Gradient sky dome with a soft sun glow, drawn without fog. */
export function createSky(sunDirection: THREE.Vector3): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(PALETTE.skyTop) },
      uMid: { value: new THREE.Color(PALETTE.skyMid) },
      uHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
      uBelow: { value: new THREE.Color(PALETTE.skyBelow) },
      uSunGlow: { value: new THREE.Color(PALETTE.sunGlow) },
      uSunDir: { value: sunDirection.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uBelow;
      uniform vec3 uSunGlow;
      uniform vec3 uSunDir;
      varying vec3 vDirection;

      void main() {
        vec3 dir = normalize(vDirection);
        float h = clamp(dir.y, -1.0, 1.0);

        // The camera sits below the horizon, so most of the visible sky is the
        // first ~15 degrees: keep the gradient variation in that band.
        float up = smoothstep(-0.01, 0.3, h);

        vec3 color = mix(uHorizon, uMid, up);
        color = mix(color, uTop, smoothstep(0.25, 0.95, h));

        // Everything below the horizon is haze, not ground: give it depth so the
        // backdrop is not one flat colour.
        color = mix(color, uBelow, smoothstep(0.0, -0.55, h) * 0.85);

        float sun = max(dot(dir, normalize(uSunDir)), 0.0);
        color += uSunGlow * pow(sun, 220.0) * 1.1;
        color += uSunGlow * pow(sun, 8.0) * 0.16;

        // Slight warm lift near the horizon so the island reads as backlit.
        color += uHorizon * smoothstep(0.25, -0.05, h) * 0.1;

        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 20), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.name = 'sky';
  return mesh;
}

function cloudTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');

  // A flat-bottomed cluster of puffs reads as a cumulus cloud rather than fog.
  const puffs = 9;
  for (let i = 0; i < puffs; i += 1) {
    const t = i / (puffs - 1);
    const x = size * (0.22 + t * 0.56) + (Math.random() - 0.5) * 8;
    const y = size * (0.58 - Math.sin(t * Math.PI) * 0.2);
    const radius = 14 + Math.sin(t * Math.PI) * 16 + Math.random() * 4;

    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export interface CloudField {
  group: THREE.Group;
  update: (delta: number) => void;
  setCount: (count: number) => void;
}

/** Soft billboard clouds drifting well below the island. */
export function createClouds(): CloudField {
  const group = new THREE.Group();
  group.name = 'clouds';
  const texture = cloudTexture();
  const clouds: { sprite: THREE.Sprite; speed: number }[] = [];

  // A close deck right under the island makes the float readable.
  for (let i = 0; i < 7; i += 1) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      opacity: 0.3 + Math.random() * 0.18,
      fog: false,
    });
    const sprite = new THREE.Sprite(material);
    const angle = (i / 7) * Math.PI * 2 + Math.random() * 0.5;
    const distance = 7 + Math.random() * 9;
    sprite.position.set(Math.cos(angle) * distance, -9.4 - Math.random() * 2.2, Math.sin(angle) * distance);
    const scale = 12 + Math.random() * 8;
    sprite.scale.set(scale, scale * 0.55, 1);
    group.add(sprite);
    clouds.push({ sprite, speed: 0.18 + Math.random() * 0.22 });
  }

  for (let i = 0; i < 16; i += 1) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      opacity: 0.42 + Math.random() * 0.22,
      fog: false,
    });
    const sprite = new THREE.Sprite(material);

    const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.6;
    const distance = 14 + Math.random() * 22;
    // A cloud layer below the island sells the float; keep the upper sky clear.
    sprite.position.set(
      Math.cos(angle) * distance,
      -11 - Math.random() * 8,
      Math.sin(angle) * distance,
    );
    const scale = 8 + Math.random() * 9;
    sprite.scale.set(scale, scale * 0.62, 1);

    group.add(sprite);
    clouds.push({ sprite, speed: 0.25 + Math.random() * 0.4 });
  }

  return {
    group,
    update(delta) {
      for (const cloud of clouds) {
        cloud.sprite.position.x += cloud.speed * delta;
        if (cloud.sprite.position.x > 44) cloud.sprite.position.x = -44;
      }
    },
    setCount(count) {
      // The first entries are the close cloud deck; always keep them.
      clouds.forEach((cloud, index) => {
        cloud.sprite.visible = index < 7 || index - 7 < count;
      });
    },
  };
}

export interface Lighting {
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
  sunDirection: THREE.Vector3;
}

export function createLighting(): Lighting {
  const sunDirection = new THREE.Vector3(...WORLD.sunDirection).normalize();
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.45);
  sun.position.copy(sunDirection).multiplyScalar(34);
  sun.target.position.set(0, -1, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 4;
  sun.shadow.camera.far = 90;
  sun.shadow.camera.left = -15;
  sun.shadow.camera.right = 15;
  sun.shadow.camera.top = 15;
  sun.shadow.camera.bottom = -15;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;

  // A neutral ground bounce: a green one tints the island's underside olive.
  const hemisphere = new THREE.HemisphereLight(0xc2d6ff, 0x6d6a83, 1.0);

  return { sun, hemisphere, sunDirection };
}

/**
 * Pond water. The disc is a little wider than the basin and every vertex carries
 * its real water depth, so the shader can drop the dry part and draw the foam
 * along the waterline the terrain actually makes.
 */
export function createWater(level: number): THREE.Mesh {
  const segments = 96;
  const rings = 10;
  const positions: number[] = [];
  const depths: number[] = [];
  const indices: number[] = [];

  const depthAt = (x: number, z: number) => level - terrainHeightAt(SITES.pond.x + x, SITES.pond.z + z);

  positions.push(0, 0, 0);
  depths.push(depthAt(0, 0));

  for (let ring = 1; ring <= rings; ring += 1) {
    const t = ring / rings;
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const radius = pondRadius(angle) * 1.22 * t;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      positions.push(x, 0, z);
      depths.push(depthAt(x, z));
    }
  }

  // Centre fan.
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    indices.push(0, 1 + next, 1 + segment);
  }

  // Bands between successive rings.
  for (let ring = 1; ring < rings; ring += 1) {
    const inner = 1 + (ring - 1) * segments;
    const outer = 1 + ring * segments;
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      indices.push(
        inner + segment,
        inner + next,
        outer + segment,
        inner + next,
        outer + next,
        outer + segment,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aDepth', new THREE.Float32BufferAttribute(depths, 1));
  geometry.setIndex(indices);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(PALETTE.waterDeep) },
      uShallow: { value: new THREE.Color(PALETTE.waterShallow) },
      uFoam: { value: new THREE.Color(PALETTE.foam) },
      uSkyColor: { value: new THREE.Color(PALETTE.skyHorizon) },
      uSunDir: { value: new THREE.Vector3(...WORLD.sunDirection).normalize() },
    },
    vertexShader: /* glsl */ `
      attribute float aDepth;
      varying float vDepth;
      varying vec3 vWorldPosition;
      void main() {
        vDepth = aDepth;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPosition = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform vec3 uFoam;
      uniform vec3 uSkyColor;
      uniform vec3 uSunDir;
      varying float vDepth;
      varying vec3 vWorldPosition;

      void main() {
        // Ground above the waterline: drop it, so the pond outline is the shape
        // the basin makes rather than the edge of this disc.
        if (vDepth < 0.0) discard;

        float waveA = sin(vWorldPosition.x * 3.1 + uTime * 1.05);
        float waveB = sin(vWorldPosition.z * 2.6 - uTime * 0.85 + vWorldPosition.x * 1.4);
        float waveC = sin((vWorldPosition.x + vWorldPosition.z) * 5.1 + uTime * 1.6);

        vec3 normal = normalize(vec3(waveA * 0.07 + waveC * 0.02, 1.0, waveB * 0.07 + waveC * 0.02));
        vec3 viewDirection = normalize(cameraPosition - vWorldPosition);

        float fresnel = pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), 2.6);

        vec3 color = mix(uDeep, uShallow, 1.0 - smoothstep(0.04, 0.7, vDepth));
        color = mix(color, uSkyColor, fresnel * 0.28);

        vec3 halfVector = normalize(normalize(uSunDir) + viewDirection);
        float specular = pow(max(dot(normal, halfVector), 0.0), 110.0);
        color += vec3(1.0, 0.97, 0.9) * specular * 0.9;

        // Foam tracks the real waterline, not a fixed radius.
        float ripple = 0.55 + 0.45 * sin(uTime * 1.7 + vWorldPosition.x * 2.4 + vWorldPosition.z * 1.9);
        float foam = smoothstep(0.1, 0.0, vDepth) * ripple;
        color = mix(color, uFoam, clamp(foam, 0.0, 1.0) * 0.55);

        gl_FragColor = vec4(color, 0.86 + fresnel * 0.1);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(SITES.pond.x, level, SITES.pond.z);
  mesh.name = 'pond-water';
  mesh.renderOrder = 2;
  return mesh;
}
