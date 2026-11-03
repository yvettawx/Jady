// The WebGL refraction layer (P0.5-05 spike, docs/spikes/07-ui-components.md): draws the
// backdrop (wallpaper or home scene) full screen and, inside each glass panel, a blurred,
// tinted copy that bends inward near the edges like a lens. The DOM panels on top only carry
// the content, rim and highlight.

export const MAX_PANELS = 16;

const VERT = `attribute vec2 p; varying vec2 uv;
void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

/**
 * The glass fragment shader. Positions are worked out in pixels from the top-left, like the
 * DOM. `sampler` and `uv` name the input texture and coordinate; `flipY` is for a texture whose
 * rows start at the bottom (a three.js render target) rather than at the top (an uploaded canvas).
 * The home star map draws its glass with this same shader as its last pass.
 */
export function glassFragment({
  sampler = "bg",
  uv = "uv",
  flipY = false,
}: { sampler?: string; uv?: string; flipY?: boolean } = {}): string {
  return `precision highp float;
varying vec2 ${uv};
uniform sampler2D ${sampler};
uniform vec2 res;
uniform vec4 rects[${MAX_PANELS}];
uniform float radii[${MAX_PANELS}];
uniform int count;
uniform vec4 glass;      // rgb + opacity of the glass paint
uniform float blurStep;  // device px between blur taps
uniform float lens;      // device px of inward pull at the rim
uniform float dpr;
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// st: 0–1 from the top-left; this maps it to the texture's own coordinates.
vec3 at(vec2 st){ return texture2D(${sampler}, ${flipY ? "vec2(st.x, 1.0 - st.y)" : "st"}).rgb; }
// 7 × 7 taps; the grid is rotated per pixel so its spacing never shows up as rings.
vec3 blurAt(vec2 st, vec2 px){
  float a = hash(px) * 6.2832;
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec3 c = vec3(0.0); float w = 0.0;
  for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) {
    float k = exp(-float(x*x + y*y) / 8.0);
    c += at(st + rot * vec2(float(x), float(y)) * blurStep / res) * k; w += k; }
  return c / w;
}
void main(){
  vec2 st = vec2(${uv}.x, 1.0 - ${uv}.y);
  vec2 px = st * res;
  vec3 col = at(st);
  for (int i = 0; i < ${MAX_PANELS}; i++) {
    if (i >= count) break;
    vec4 r = rects[i]; vec2 c = r.xy + r.zw * 0.5;
    float d = sdRound(px - c, r.zw * 0.5, radii[i]);
    if (d < 0.0) {
      float edge = clamp(1.0 + d / (26.0 * dpr), 0.0, 1.0);
      vec2 n = normalize((px - c) / (r.zw * 0.5) + 1e-4);
      vec3 g = blurAt((px - n * pow(edge, 2.2) * lens) / res, px);
      g = mix(vec3(dot(g, vec3(0.299, 0.587, 0.114))), g, 1.5);
      g = mix(g, glass.rgb, glass.a);
      g += pow(edge, 6.0) * 0.25;
      col = g;
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;
}

const FRAG = glassFragment();

/** Device px of inward pull at a panel's rim, per CSS px. */
export const LENS = 30;

export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
}

export type GlassPaint = { r: number; g: number; b: number; a: number };

/**
 * Something that draws the glass itself, in its own WebGL context: the home star map does, so
 * its frames never have to be copied into the glass layer (P0.5-07-3, WKWebView measurement).
 * The glass layer then only collects the panels and hands them over each frame.
 */
export interface GlassSink {
  setGlass(panels: PanelRect[], paint: GlassPaint, blurPx: number): void;
}

export interface GlassRenderer {
  setSource(src: TexImageSource): void;
  draw(
    panels: PanelRect[],
    paint: { r: number; g: number; b: number; a: number },
    blurPx: number,
  ): void;
  resize(w: number, h: number, dpr: number): void;
  dispose(): void;
}

/** Null when WebGL is unavailable; callers then fall back to CSS blur. */
export function createGlassRenderer(canvas: HTMLCanvasElement): GlassRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    // Development builds keep the last frame so diagnostics can read its pixels.
    preserveDrawingBuffer: import.meta.env.DEV,
  });
  if (!gl) return null;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s;
    console.warn("glass shader:", gl.getShaderInfoLog(s));
    return null;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT),
    fs = shader(gl.FRAGMENT_SHADER, FRAG),
    prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const u = (name: string) => gl.getUniformLocation(prog, name);
  const U = {
    res: u("res"),
    rects: u("rects"),
    radii: u("radii"),
    count: u("count"),
    glass: u("glass"),
    blurStep: u("blurStep"),
    lens: u("lens"),
    dpr: u("dpr"),
  };
  let dpr = 1,
    vw = 1,
    vh = 1,
    lastRatio = 0;
  const rects = new Float32Array(MAX_PANELS * 4),
    radii = new Float32Array(MAX_PANELS);

  return {
    setSource(src) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    },
    // Resizing a canvas reallocates its drawing buffer, which is slow to do on every frame of
    // a window drag. The buffer is sized once to the screen (grown only if the window gets
    // bigger, e.g. on another display) and only the viewport follows the window.
    resize(w, h, ratio) {
      dpr = ratio;
      vw = Math.round(w * dpr);
      vh = Math.round(h * dpr);
      const bw = Math.max(vw, Math.round(screen.width * dpr)),
        bh = Math.max(vh, Math.round(screen.height * dpr));
      if (bw > canvas.width || bh > canvas.height || ratio !== lastRatio) {
        canvas.width = bw;
        canvas.height = bh;
        canvas.style.width = `${bw / dpr}px`;
        canvas.style.height = `${bh / dpr}px`;
        lastRatio = ratio;
      }
      // GL counts from the bottom-left; the window shows the canvas's top-left part.
      gl.viewport(0, canvas.height - vh, vw, vh);
    },
    draw(panels, paint, blurPx) {
      const n = Math.min(panels.length, MAX_PANELS);
      rects.fill(0);
      radii.fill(0);
      panels.slice(0, n).forEach((p, i) => {
        rects.set([p.x * dpr, p.y * dpr, p.w * dpr, p.h * dpr], i * 4);
        radii[i] = p.radius * dpr;
      });
      gl.uniform2f(U.res, vw, vh);
      gl.uniform4fv(U.rects, rects);
      gl.uniform1fv(U.radii, radii);
      gl.uniform1i(U.count, n);
      gl.uniform4f(U.glass, paint.r / 255, paint.g / 255, paint.b / 255, paint.a);
      gl.uniform1f(U.blurStep, (blurPx / 3) * dpr);
      gl.uniform1f(U.lens, LENS * dpr);
      gl.uniform1f(U.dpr, dpr);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    // Frees our objects but keeps the context: React may mount the same canvas again
    // (StrictMode does), and a lost context cannot be reused.
    dispose() {
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}
