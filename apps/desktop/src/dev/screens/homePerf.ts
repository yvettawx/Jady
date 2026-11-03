// Frame times of the home page (P0.5-07-3): the star map behind WebGL glass or CSS blur, with
// and without bloom. In the Tauri window the window is first set to 1440 × 900 so runs compare.
// Results go to the dev server (.perf/home-perf-*.json) and back to the page. macOS Low Power
// Mode holds WebKit to 30 frames a second; check `pmset -g` before reading the numbers.

export interface PerfSetup {
  webgl: boolean;
  bloom: boolean;
}

const RUNS: PerfSetup[] = [
  { webgl: true, bloom: true },
  { webgl: true, bloom: false },
  { webgl: false, bloom: true },
  { webgl: false, bloom: false },
];

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function measure(seconds: number): Promise<number[]> {
  return new Promise((resolve) => {
    const frames: number[] = [];
    let last = performance.now();
    const end = last + seconds * 1000;
    const loop = (now: number) => {
      frames.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(loop);
      else resolve(frames);
    };
    requestAnimationFrame(loop);
  });
}

export async function runHomePerf(apply: (s: PerfSetup) => void, seconds: number): Promise<string> {
  if ("__TAURI_INTERNALS__" in window) {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setSize(new LogicalSize(1440, 900));
  }
  const runs = [];
  for (const setup of RUNS) {
    apply(setup);
    await wait(2000);
    const starsBefore = window.__starFrames ?? 0;
    const all = await measure(seconds);
    // A gap of half a second or more means the window was hidden or behind another one and
    // macOS stopped drawing it; that is not the scene's cost, so it is reported apart.
    const frames = all.filter((f) => f < 500);
    const sorted = [...frames].sort((a, b) => a - b);
    const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
    runs.push({
      glass: setup.webgl ? "webgl" : "css",
      bloom: setup.bloom,
      frames: frames.length,
      pausedMs: Math.round(all.filter((f) => f >= 500).reduce((a, b) => a + b, 0)),
      fps: +(1000 / avg).toFixed(1),
      avgMs: +avg.toFixed(2),
      p95Ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2),
      over20ms: frames.filter((f) => f > 20).length,
      over33ms: frames.filter((f) => f > 33).length,
      starFrames: (window.__starFrames ?? 0) - starsBefore,
    });
  }
  apply(RUNS[0] as PerfSetup);
  const report = {
    name: "home-perf",
    ua: navigator.userAgent,
    dpr: devicePixelRatio,
    w: innerWidth,
    h: innerHeight,
    seconds,
    runs,
  };
  fetch("/__perf", { method: "POST", body: JSON.stringify(report) }).catch(() => {});
  return JSON.stringify(report, null, 1);
}
