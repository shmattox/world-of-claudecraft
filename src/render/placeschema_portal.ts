// The PlaceSchema portal (PLACE-954), in the art the realm picks with PLACESCHEMA_PORTAL_ART
// (PLACE-1026, sent with the sidecar status):
//   default  PlaceSchema's standard portal, the Hub's: a round window on the destination edged by a
//            flat glowing amber band, its halo and a pool of light at its foot. Ported from open-place
//            world-kit/src/portal-ring.ts (buildPortalRing), sized to the walk-in gate.
//   custom   WoC's own rift gate (door_portal.ts buildRiftGateBody), scaled to the same gate; the
//            default ring stands in until its model has loaded.
// The window shows the destination's own picture (its manifest preview), or the PlaceSchema mark until
// it arrives. Drawing only: the server notices the walk-in and carries everything out
// (sim/placeschema_portal.ts holds the spots and the gate's width). Drawn only while the realm has a
// PlaceSchema sidecar (the link status has arrived).

import * as THREE from 'three';
import {
  type PortalArt,
  placeSchemaLinked,
  placeSchemaPortalArt,
  portalDestinationName,
  portalDestinationPicture,
} from '../placeschema_skin_state';
import { PLACESCHEMA_PORTAL_BLOCK as BLOCK, PLACESCHEMA_PORTALS } from '../sim/placeschema_portal';
import { buildRiftGateBody } from './door_portal';
import { GFX } from './gfx';

const LOGO_URL = '/placeschema/logo-white.png';
/** The walk-in gate is two blocks either side of its centre line (sim/placeschema_portal.ts). */
const GATE_WIDTH = 4 * BLOCK;
// The Hub ring's proportions (portal-ring.ts): lip = 0.1 of the opening, depth = 0.02, so the
// ring's outer edge (opening/2 + lip) lands on the gate's edge.
const OPENING = GATE_WIDTH / 1.2;
const LIP = OPENING * 0.1;
const DEPTH = OPENING * 0.02;
const AMBER = 0xff9a2e; // the Hub's house colour

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// The window: the destination's picture cover-cropped into the round opening, or the PlaceSchema mark
// on black until it arrives. Back faces mirror naturally, like one physical image.
const WINDOW_FRAGMENT = /* glsl */ `
  uniform sampler2D uLogo;
  uniform float uHasLogo;
  uniform sampler2D uPreview;
  uniform float uHasPreview;
  uniform float uPreviewAspect;
  varying vec2 vUv;
  void main() {
    vec3 col = vec3(0.0);
    if (uHasPreview > 0.5) {
      vec2 q = vUv;
      if (uPreviewAspect > 1.0) q.x = 0.5 + (q.x - 0.5) / uPreviewAspect;
      else q.y = 0.5 + (q.y - 0.5) * uPreviewAspect;
      col = texture2D(uPreview, q).rgb;
    } else if (uHasLogo > 0.5) {
      vec2 l = (vUv - 0.5) / 0.55 + 0.5;
      if (l.x > 0.0 && l.x < 1.0 && l.y > 0.0 && l.y < 1.0) col = vec3(texture2D(uLogo, l).a);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

// The band's light bleeding into the air around it (portal-ring.ts glowMaterial): tight to the band,
// a lobe travelling round the outside only, never over the picture.
const GLOW_FRAGMENT = /* glsl */ `
  uniform vec3 uColour;
  uniform float uPeak;
  uniform float uStrength;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float d = (r - uPeak) / uPeak;
    float fall = d < 0.0 ? 320.0 : 170.0;
    float wave = 0.86 + 0.14 * sin(atan(p.y, p.x) * 3.0 + uTime * 1.1);
    float amp = d > 0.0 ? wave : 1.0;
    gl_FragColor = vec4(uColour, exp(-d * d * fall) * uStrength * amp);
  }
`;

/** A radial wash laid on the ground, stretched along the through-axis (portal-ring.ts baseGlow). */
function poolTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const wash = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  wash.addColorStop(0, 'rgba(255,154,46,0.5)');
  wash.addColorStop(0.45, 'rgba(255,154,46,0.12)');
  wash.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** One letter cut into the band (portal-ring.ts glyphPlane): highlight on the lower groove wall,
 *  shadow on the upper, a recessed floor darker than the band. Canvas, so no font file to fetch. */
function glyphPlane(ch: string, size: number): THREE.Mesh | null {
  const px = 128;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const CAP = 0.6;
  const fontPx = Math.round((CAP * px) / 0.72);
  ctx.font = `600 ${fontPx}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const y = px / 2 + (CAP * px) / 2;
  const o = fontPx * 0.03;
  const face = new THREE.Color(AMBER);
  ctx.fillStyle = face.clone().lerp(new THREE.Color(0xffffff), 0.65).getStyle();
  ctx.fillText(ch, px / 2, y + o);
  ctx.fillStyle = face.clone().multiplyScalar(0.18).getStyle();
  ctx.fillText(ch, px / 2, y - o * 0.7);
  ctx.fillStyle = face.clone().multiplyScalar(0.5).getStyle();
  ctx.fillText(ch, px / 2, y);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }),
  );
  mesh.renderOrder = 4; // over the band and its halo
  return mesh;
}

/** The destination's name arced across the top of the band, left to right (portal-ring.ts). */
function arcedTitle(text: string, radius: number, cap: number): THREE.Group {
  const group = new THREE.Group();
  const shown = text.toUpperCase();
  const step = (cap * 1.3) / radius;
  const span = (shown.length - 1) * step;
  [...shown].forEach((ch, i) => {
    if (!ch.trim()) return;
    const glyph = glyphPlane(ch, cap / 0.6);
    if (!glyph) return;
    const theta = Math.PI / 2 + span / 2 - i * step;
    glyph.position.set(Math.cos(theta) * radius, Math.sin(theta) * radius, 0);
    glyph.rotation.z = theta - Math.PI / 2;
    group.add(glyph);
  });
  return group;
}

interface Shared {
  window: THREE.ShaderMaterial;
  glows: THREE.ShaderMaterial[];
  lip: THREE.Material;
  pool: THREE.MeshBasicMaterial;
}

/** The Hub's ring at the gate's size: flat lip, round window, halo each side, pool of light, and the
 *  destination's name carved on both faces of the band. */
function buildRing(m: Shared, name: string | null): THREE.Group {
  const group = new THREE.Group();
  group.name = 'placeschema-portal';
  const ring = new THREE.Group();
  const r = OPENING / 2;
  ring.position.y = r - OPENING * 0.03; // the window's foot just below the ground, as the Hub's
  group.add(ring);
  const face = new THREE.Shape();
  face.absarc(0, 0, r + LIP, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, r, 0, Math.PI * 2, true);
  face.holes.push(hole);
  const lipGeo = new THREE.ExtrudeGeometry(face, {
    depth: DEPTH,
    bevelEnabled: false,
    curveSegments: 96,
  });
  lipGeo.translate(0, 0, -DEPTH / 2);
  const lip = new THREE.Mesh(lipGeo, m.lip);
  lip.name = 'rim';
  ring.add(lip);
  const win = new THREE.Mesh(new THREE.CircleGeometry(r, 64), m.window);
  win.name = 'placeschema-portal-sheet';
  ring.add(win);
  if (name)
    for (const facing of [1, -1]) {
      const title = arcedTitle(name, r + LIP * 0.47, LIP * 0.7);
      title.position.z = facing * (DEPTH / 2 + 0.006);
      if (facing < 0) title.rotation.y = Math.PI;
      ring.add(title);
    }
  const span = (r + LIP) * 2 * 1.16;
  for (const [i, z] of [DEPTH + 0.03, -(DEPTH + 0.03)].entries()) {
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(span, span), m.glows[i]);
    glow.position.z = z;
    glow.renderOrder = z > 0 ? 3 : 1;
    ring.add(glow);
  }
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(span * 1.2, span * 1.2 * 2.2), m.pool);
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.03;
  pool.renderOrder = 1;
  group.add(pool);
  return group;
}

/** WoC's own rift gate, scaled so its width fits the walk-in gate; null until its model loads. */
function buildCustom(): THREE.Group | null {
  const built = buildRiftGateBody(!GFX.standardMaterials);
  if (!built) return null;
  const box = new THREE.Box3().setFromObject(built.body);
  const width = Math.max(box.max.x - box.min.x, 1e-3);
  const group = new THREE.Group();
  group.name = 'placeschema-portal';
  built.body.scale.setScalar(Math.min(1, GATE_WIDTH / width));
  group.add(built.body);
  return group;
}

export class PlaceSchemaPortals {
  readonly group = new THREE.Group();
  private readonly shared: Shared;
  /** the art the gates are drawn in; 'pending-custom' = custom asked, the ring standing in */
  private built: PortalArt | 'pending-custom' | null = null;
  private lastTry = Number.NEGATIVE_INFINITY;
  private inited = false;
  /** the destination name the rings carry */
  private name: string | null = null;
  /** the destination picture shown (or being loaded) */
  private picture: string | null = null;

  constructor(private readonly ground: (x: number, z: number) => number) {
    this.group.name = 'placeschema-portals';
    this.group.visible = false;
    const glow = () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uColour: { value: new THREE.Color(AMBER) },
          uPeak: { value: 1 / 1.16 },
          uStrength: { value: 0.42 },
          uTime: { value: 0 },
        },
        vertexShader: VERTEX,
        fragmentShader: GLOW_FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    this.shared = {
      window: new THREE.ShaderMaterial({
        uniforms: {
          uLogo: { value: null },
          uHasLogo: { value: 0 },
          uPreview: { value: null },
          uHasPreview: { value: 0 },
          uPreviewAspect: { value: 1 },
        },
        vertexShader: VERTEX,
        fragmentShader: WINDOW_FRAGMENT,
        side: THREE.DoubleSide,
      }),
      glows: [glow(), glow()],
      lip: new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: AMBER,
        emissiveIntensity: 1.5,
        roughness: 0.5,
        metalness: 0,
      }),
      pool: new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    };
  }

  /** Draw every gate in the realm's art. Custom whose model has not loaded keeps the ring. */
  private build(art: PortalArt): void {
    if (!this.inited) {
      this.inited = true;
      this.shared.pool.map = poolTexture();
      new THREE.TextureLoader().load(LOGO_URL, (logo) => {
        this.shared.window.uniforms.uLogo.value = logo;
        this.shared.window.uniforms.uHasLogo.value = 1;
      });
    }
    const gates = PLACESCHEMA_PORTALS.map(() => (art === 'custom' ? buildCustom() : null));
    const ready = art !== 'custom' || gates.every(Boolean);
    if (!ready && this.built === 'pending-custom') return; // the ring already stands in
    this.built = ready ? art : 'pending-custom';
    // ponytail: the old gates' geometry is not disposed; the art changes once per session at most
    this.group.clear();
    PLACESCHEMA_PORTALS.forEach((spot, i) => {
      const portal = (ready && gates[i]) || buildRing(this.shared, this.name);
      portal.position.set(spot.x, this.ground(spot.x, spot.z) - 0.05, spot.z);
      portal.rotation.y = spot.facing;
      this.group.add(portal);
    });
  }

  /** Once a frame: built on the first (hidden, so it is ready before it is needed), shown once the
   *  sidecar has answered, the halo animated. A custom gate waiting on its model is retried each second. */
  update(time: number): void {
    const art = placeSchemaPortalArt();
    if (portalDestinationName() !== this.name) {
      this.name = portalDestinationName();
      if (this.built !== 'custom') this.built = null; // re-cut the rings with the name
    }
    if (this.built !== art && !(this.built === 'pending-custom' && time - this.lastTry < 1)) {
      this.lastTry = time;
      this.build(art);
    }
    const on = placeSchemaLinked() !== null;
    this.group.visible = on;
    if (!on) return;
    for (const g of this.shared.glows) g.uniforms.uTime.value = time;
    const want = portalDestinationPicture();
    if (want && want !== this.picture) {
      this.picture = want;
      const u = this.shared.window.uniforms;
      new THREE.TextureLoader().setCrossOrigin('anonymous').load(want, (pic) => {
        if (this.picture !== want) return pic.dispose();
        pic.colorSpace = THREE.SRGBColorSpace;
        (u.uPreview.value as THREE.Texture | null)?.dispose();
        const img = pic.image as { width: number; height: number };
        u.uPreview.value = pic;
        u.uPreviewAspect.value = img.width / Math.max(1, img.height);
        u.uHasPreview.value = 1;
      });
    }
  }
}
