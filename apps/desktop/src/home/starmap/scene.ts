// Draws the star map with three.js: instanced stars, links, a nebula per cluster, far dust and
// optional bloom. It only draws; StarMap.tsx owns the frame loop, pointer and labels. The canvas
// draws the window's glass panels too, as its last pass (GlassSink): copying every frame into
// the glass layer's own context was too slow in WKWebView (P0.5-07-3).
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { MODES, STARMAP, type Mode } from "../../theme/tokens.ts";
import { glassFragment, LENS, MAX_PANELS, type GlassSink } from "../../ui/glass/renderer";
import {
  clusterCentres,
  createLayout,
  neighbours,
  step,
  settle,
  type ClusterCentre,
  type Layout,
  type StarGraph,
} from "./graph";

export interface StarLook {
  mode: Mode;
  /** The space's three colours. */
  colors: readonly string[];
  /** Painted behind the stars: the space's wallpaper. */
  background: HTMLCanvasElement | null;
}

export interface ClusterLabel {
  x: number;
  y: number;
  /** Behind the camera or the layout still moving: not shown. */
  visible: boolean;
}

export interface StarScene extends GlassSink {
  readonly layout: Layout;
  setLook(look: StarLook): void;
  setBloom(on: boolean): void;
  /** 溢光: 0–1 of the theme's strength. At 0 the pass is off, which also saves its cost. */
  setGlow(k: number): void;
  /** What the bloom pass is set to now, 0 when off; for the probe. */
  bloomStrength(): number;
  resize(w: number, h: number, dpr: number): void;
  /** Advances the layout and spin when `animate`, then draws. */
  frame(dt: number, t: number, animate: boolean): void;
  /** Where a star is on screen, in CSS px (for tests). */
  screenOf(i: number): { x: number; y: number } | null;
  /** The star under a point in CSS px, or null. */
  hit(x: number, y: number): number | null;
  setHover(i: number | null): void;
  hovered(): { index: number; links: number } | null;
  /** Where each cluster's name goes, in CSS px; only valid after frame(). */
  labels(): ClusterLabel[];
  centres(): ClusterCentre[];
  dispose(): void;
}

/** Ignored from here: the display's own pixel ratio is more than the scene behind glass needs. */
const MAX_RATIO = 1.5;
const CAMERA = { az: 24, el: 16, dist: 128, fov: 24 };
/**
 * The map sits between the two columns of home widgets, a little right of the window's centre
 * (the leftmost bar takes the left edge) and a little up (the header is short, the bottom
 * free). Shares of the window size.
 */
const FRAMING = { right: 0.03, up: 0.04 };

export function createStarScene(
  canvas: HTMLCanvasElement,
  graph: StarGraph,
  opts: { reduceMotion: boolean },
): StarScene | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Development builds keep the last frame so the probe can read its pixels.
      preserveDrawingBuffer: import.meta.env.DEV,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
  const layout = createLayout(graph);
  if (opts.reduceMotion) settle(layout);
  const N = layout.bodies.length,
    E = layout.links.length,
    C = graph.clusters.length;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 1, 500);
  const az = (CAMERA.az * Math.PI) / 180,
    el = (CAMERA.el * Math.PI) / 180;
  camera.position.set(
    Math.sin(az) * Math.cos(el) * CAMERA.dist,
    Math.sin(el) * CAMERA.dist,
    Math.cos(az) * Math.cos(el) * CAMERA.dist,
  );
  camera.lookAt(0, 0, 0);
  scene.fog = new THREE.Fog(0xffffff, CAMERA.dist * 0.82, CAMERA.dist * 1.7);
  const group = new THREE.Group();
  scene.add(group);

  const stars = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    N,
  );
  group.add(stars);
  const lpos = new Float32Array(E * 6),
    lcol = new Float32Array(E * 6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(lpos, 3));
  lineGeo.setAttribute("color", new THREE.BufferAttribute(lcol, 3));
  const lines = new THREE.LineSegments(
    lineGeo,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }),
  );
  group.add(lines);

  // A soft round sprite behind each cluster: white, fading out from the middle.
  const G = 64,
    glowPx = new Uint8Array(G * G * 4);
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++) {
      const d = Math.min(1, Math.hypot(x + 0.5 - G / 2, y + 0.5 - G / 2) / (G / 2));
      const a = d < 0.35 ? 1 - (d / 0.35) * 0.65 : 0.35 * (1 - (d - 0.35) / 0.65);
      glowPx.set([255, 255, 255, Math.round(a * 255)], (y * G + x) * 4);
    }
  const glowTex = new THREE.DataTexture(glowPx, G, G);
  glowTex.needsUpdate = true;
  const nebulae = graph.clusters.map(() => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    );
    s.renderOrder = -1;
    group.add(s);
    return s;
  });

  const rnd = (() => {
    let s = 11;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
  })();
  const dust = new Float32Array(600 * 3);
  for (let i = 0; i < 600; i++) {
    const r = 45 + rnd() * 40,
      th = rnd() * Math.PI * 2,
      ph = Math.acos(2 * rnd() - 1);
    dust.set(
      [r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.7, r * Math.sin(ph) * Math.sin(th)],
      i * 3,
    );
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
  const dustPoints = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({ size: 0.12, transparent: true, depthWrite: false }),
  );
  group.add(dustPoints);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.55, 0.9);
  let bloomOn = true;
  let glow = 1;
  let fullBloom = bloom.strength;
  const applyBloom = () => {
    bloom.enabled = bloomOn && glow > 0;
    bloom.strength = fullBloom * glow;
  };
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  // The glass panels, drawn over the finished (sRGB) frame with the glass layer's shader.
  const glassPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      res: { value: new THREE.Vector2(1, 1) },
      rects: { value: Array.from({ length: MAX_PANELS }, () => new THREE.Vector4()) },
      radii: { value: new Array<number>(MAX_PANELS).fill(0) },
      count: { value: 0 },
      glass: { value: new THREE.Vector4() },
      blurStep: { value: 1 },
      lens: { value: LENS },
      dpr: { value: 1 },
    },
    vertexShader:
      "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: glassFragment({ sampler: "tDiffuse", uv: "vUv", flipY: true }),
  });
  glassPass.enabled = false;
  composer.addPass(glassPass);
  const gu = glassPass.uniforms as Record<string, { value: unknown }>;
  const set = (name: string, value: unknown) => {
    const u = gu[name];
    if (u) u.value = value;
  };

  let look: StarLook = { mode: "light", colors: [], background: null };
  let palette: THREE.Color[] = [];
  let bgTex: THREE.CanvasTexture | null = null;
  const loose = new THREE.Color(),
    priv = new THREE.Color();

  let hover: number | null = null,
    linked = new Set<number>();
  let width = 1,
    height = 1;
  let centres: ClusterCentre[] = clusterCentres(layout, C);
  const labels: ClusterLabel[] = graph.clusters.map(() => ({ x: 0, y: 0, visible: false }));

  const m4 = new THREE.Matrix4(),
    q = new THREE.Quaternion(),
    v = new THREE.Vector3(),
    sc = new THREE.Vector3(),
    col = new THREE.Color();
  const ray = new THREE.Raycaster(),
    ndc = new THREE.Vector2();
  let time = 0;

  const colourOf = (c: number): THREE.Color =>
    c < 0 ? loose : graph.clusters[c]?.private ? priv : (palette[c % palette.length] ?? loose);

  const api: StarScene = {
    layout,
    setLook(next) {
      look = next;
      const t = STARMAP[next.mode];
      const [a = t.loose, b = a, c = a] = next.colors;
      const A = new THREE.Color(a),
        B = new THREE.Color(b),
        Cc = new THREE.Color(c);
      palette = [
        A,
        B,
        Cc,
        A.clone().lerp(B, 0.5),
        B.clone().lerp(Cc, 0.5),
        Cc.clone().lerp(A, 0.5),
      ];
      loose.set(t.loose);
      priv.set(t.private);
      (dustPoints.material as THREE.PointsMaterial).color.set(t.dust);
      (dustPoints.material as THREE.PointsMaterial).opacity = t.dustOpacity;
      for (const s of nebulae) {
        s.material.blending = next.mode === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending;
        s.material.opacity = t.nebula;
      }
      bloom.threshold = t.bloom.threshold;
      fullBloom = t.bloom.strength;
      applyBloom();
      bloom.radius = t.bloom.radius;
      bgTex?.dispose();
      bgTex = null;
      if (next.background && next.background.width > 0) {
        bgTex = new THREE.CanvasTexture(next.background);
        bgTex.colorSpace = THREE.SRGBColorSpace;
      }
      scene.background = bgTex;
      // Fog fades far stars into the wallpaper's base colour.
      if (scene.fog) scene.fog.color.set(MODES[next.mode].canvas);
    },
    setBloom(on) {
      bloomOn = on;
      applyBloom();
    },
    setGlow(k) {
      glow = k;
      applyBloom();
    },
    bloomStrength() {
      return bloom.enabled ? bloom.strength : 0;
    },
    setGlass(panels, paint, blurPx) {
      const ratio = renderer.getPixelRatio();
      const n = Math.min(panels.length, MAX_PANELS);
      const rects = gu.rects?.value as THREE.Vector4[],
        radii = gu.radii?.value as number[];
      for (let i = 0; i < MAX_PANELS; i++) {
        const p = i < n ? panels[i] : undefined;
        rects[i]?.set(
          (p?.x ?? 0) * ratio,
          (p?.y ?? 0) * ratio,
          (p?.w ?? 0) * ratio,
          (p?.h ?? 0) * ratio,
        );
        radii[i] = (p?.radius ?? 0) * ratio;
      }
      set("count", n);
      set("glass", new THREE.Vector4(paint.r / 255, paint.g / 255, paint.b / 255, paint.a));
      set("blurStep", (blurPx / 3) * ratio);
      set("lens", LENS * ratio);
      set("dpr", ratio);
      glassPass.enabled = n > 0;
    },
    resize(w, h, dpr) {
      width = w;
      height = h;
      const ratio = Math.min(MAX_RATIO, dpr);
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      composer.setPixelRatio(ratio);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.setViewOffset(w, h, -w * FRAMING.right, h * FRAMING.up, w, h);
      (gu.res?.value as THREE.Vector2 | undefined)?.set(w * ratio, h * ratio);
      camera.updateProjectionMatrix();
    },
    frame(dt, t, animate) {
      if (animate) {
        step(layout);
        step(layout);
        group.rotation.y += ((dt * STARMAP.spin) / 180) * Math.PI;
        time = t;
      }
      centres = clusterCentres(layout, C);
      const dark = look.mode === "dark",
        gain = STARMAP[look.mode];
      layout.bodies.forEach((b, k) => {
        const lit = hover === null || hover === k || linked.has(k);
        const twinkle = animate ? 1 + 0.08 * Math.sin(time * 2 + k * 1.7) : 1;
        const r =
          (b.node.hub ? 0.6 : b.c < 0 ? 0.22 : 0.24 + 0.07 * Math.sqrt(b.degree)) *
          (hover === k ? 1.6 : 1) *
          twinkle;
        m4.compose(v.set(b.x, b.y, b.z), q, sc.set(r, r, r));
        stars.setMatrixAt(k, m4);
        col
          .copy(colourOf(b.c))
          .multiplyScalar(
            (b.node.hub ? 1.3 : gain.starGain) * (dark ? 1.2 : 1) * (lit ? 1 : STARMAP.dim),
          );
        stars.setColorAt(k, col);
      });
      layout.links.forEach(([i, j], e) => {
        const a = layout.bodies[i],
          b = layout.bodies[j];
        if (!a || !b) return;
        lpos.set([a.x, a.y, a.z, b.x, b.y, b.z], e * 6);
        const lit = hover === null || hover === i || hover === j;
        col.copy(colourOf(a.c)).multiplyScalar(lit ? gain.linkGain : 0.15);
        lcol.set([col.r, col.g, col.b, col.r, col.g, col.b], e * 6);
      });
      for (const attr of [lineGeo.attributes.position, lineGeo.attributes.color])
        if (attr) attr.needsUpdate = true;
      stars.instanceMatrix.needsUpdate = true;
      if (stars.instanceColor) stars.instanceColor.needsUpdate = true;
      graph.clusters.forEach((_, c) => {
        const s = nebulae[c],
          ce = centres[c];
        if (!s || !ce) return;
        s.position.set(ce.x, ce.y, ce.z);
        const R = Math.max(4, ce.r * 4.2);
        s.scale.set(R, R, 1);
        s.material.color.copy(colourOf(c));
      });
      group.updateMatrixWorld();
      graph.clusters.forEach((_, c) => {
        const ce = centres[c],
          lab = labels[c];
        if (!ce || !lab) return;
        v.set(ce.x, ce.y + ce.r * 0.75 + 0.4, ce.z)
          .applyMatrix4(group.matrixWorld)
          .project(camera);
        lab.x = ((v.x + 1) / 2) * width;
        lab.y = ((1 - v.y) / 2) * height;
        lab.visible = v.z < 1 && layout.alpha < 0.25 && ce.count > 0;
      });
      composer.render(dt);
    },
    screenOf(i) {
      const b = layout.bodies[i];
      if (!b) return null;
      v.set(b.x, b.y, b.z).applyMatrix4(group.matrixWorld).project(camera);
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
    },
    hit(x, y) {
      ndc.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const h = ray.intersectObject(stars, false)[0];
      return h?.instanceId ?? null;
    },
    setHover(i) {
      hover = i;
      linked = i === null ? new Set() : neighbours(layout, i);
    },
    hovered: () => (hover === null ? null : { index: hover, links: linked.size }),
    labels: () => labels,
    centres: () => centres,
    dispose() {
      bgTex?.dispose();
      glowTex.dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      lineGeo.dispose();
      (lines.material as THREE.Material).dispose();
      dustGeo.dispose();
      (dustPoints.material as THREE.Material).dispose();
      for (const s of nebulae) s.material.dispose();
      composer.dispose();
      renderer.dispose();
    },
  };
  return api;
}
