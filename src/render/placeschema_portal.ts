// The PlaceSchema portal (PLACE-954), drawn as the Minecraft plugin's gate: a 4x5 nether-portal frame
// of shroomlight blocks around a swirling purple sheet carrying the PlaceSchema mark, so a player who
// came through Minecraft's portal knows this one. Drawing only: the server notices the walk-in and
// carries everything out (sim/placeschema_portal.ts holds the spots). Drawn only while the realm has
// a PlaceSchema sidecar (the link status has arrived).

import * as THREE from 'three';
import { placeSchemaLinked } from '../placeschema_skin_state';
import { PLACESCHEMA_PORTALS, PlaceSchemaPortalGate } from '../sim/placeschema_portal';

const BLOCK = 0.9; // one Minecraft block, in yards: the gate stands about 2.8 bodies tall, as in Minecraft
const LOGO_URL = '/placeschema/logo-white.png';

/** A 16x16 shroomlight face: warm orange cells with pale-gold highlights, drawn pixel by pixel. */
function shroomlightTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  const tones = ['#f08a2a', '#f49a35', '#e8762a', '#fbb54a', '#ffd27a', '#c95f22'];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const r = rnd();
      ctx.fillStyle = tones[r < 0.08 ? 4 : r < 0.2 ? 3 : r < 0.3 ? 5 : Math.floor(r * 3)];
      ctx.fillRect(x, y, 1, 1);
    }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SHEET_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// The nether sheet: pixel-quantised (16 texels per block, as Minecraft draws it) violet swirl, with
// the PlaceSchema mark in its middle. uv.x flips on back faces so the mark reads the same from both
// sides.
const SHEET_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec2 uTexels;
  uniform sampler2D uLogo;
  uniform float uHasLogo;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 uv = gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y);
    vec2 px = floor(uv * uTexels) / uTexels; // chunky texels
    vec2 p = px * uTexels / 8.0;
    float t = uTime * 0.6;
    float swirl = noise(p + vec2(t, -t * 0.7)) * 0.6 + noise(p * 2.3 - vec2(t * 1.3, t)) * 0.4;
    vec3 col = mix(vec3(0.24, 0.02, 0.48), vec3(0.62, 0.22, 0.95), swirl);
    col = mix(col, vec3(0.86, 0.62, 1.0), smoothstep(0.78, 0.95, swirl));
    float a = 0.82;
    if (uHasLogo > 0.5) {
      // the mark, square, in the sheet's middle (sheet is 2:3)
      vec2 l = (uv - vec2(0.5, 0.55)) * vec2(2.0, 3.0) / 1.25 + 0.5;
      if (l.x > 0.0 && l.x < 1.0 && l.y > 0.0 && l.y < 1.0) {
        float m = texture2D(uLogo, l).a;
        col = mix(col, vec3(1.0), m * 0.95);
        a = max(a, m);
      }
    }
    gl_FragColor = vec4(col, a);
  }
`;

function buildPortal(frameMaterial: THREE.Material, sheet: THREE.ShaderMaterial): THREE.Group {
  const group = new THREE.Group();
  group.name = 'placeschema-portal';
  const cube = new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK);
  // 4 wide x 5 tall: the bottom and top rows, and the two side columns between them
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 4; col++) {
      if (row > 0 && row < 4 && col > 0 && col < 3) continue; // the opening
      const b = new THREE.Mesh(cube, frameMaterial);
      b.position.set((col - 1.5) * BLOCK, (row + 0.5) * BLOCK, 0);
      group.add(b);
    }
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2 * BLOCK, 3 * BLOCK), sheet);
  plane.position.set(0, 2.5 * BLOCK, 0);
  plane.name = 'placeschema-portal-sheet';
  group.add(plane);
  return group;
}

export class PlaceSchemaPortals {
  readonly group = new THREE.Group();
  private readonly sheet: THREE.ShaderMaterial;
  private built = false;

  constructor(private readonly ground: (x: number, z: number) => number) {
    this.group.name = 'placeschema-portals';
    this.group.visible = false;
    this.sheet = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTexels: { value: new THREE.Vector2(32, 48) },
        uLogo: { value: null },
        uHasLogo: { value: 0 },
      },
      vertexShader: SHEET_VERTEX,
      fragmentShader: SHEET_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /** First drawn when the sidecar answers: the frame, the sheet and the mark load then. */
  private build(): void {
    this.built = true;
    const tex = shroomlightTexture();
    const frame = new THREE.MeshStandardMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.85,
      roughness: 0.9,
    });
    for (const spot of PLACESCHEMA_PORTALS) {
      const portal = buildPortal(frame, this.sheet);
      portal.position.set(spot.x, this.ground(spot.x, spot.z) - 0.05, spot.z);
      portal.rotation.y = spot.facing;
      this.group.add(portal);
    }
    new THREE.TextureLoader().load(LOGO_URL, (logo) => {
      this.sheet.uniforms.uLogo.value = logo;
      this.sheet.uniforms.uHasLogo.value = 1;
    });
  }

  /** Once a frame: show it once the sidecar has answered, and animate the sheet. */
  update(time: number): void {
    const on = placeSchemaLinked() !== null;
    if (on && !this.built) this.build();
    this.group.visible = on;
    if (on) this.sheet.uniforms.uTime.value = time;
  }
}
