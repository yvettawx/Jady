// The home scene (docs/05-design.md §8): the star map behind the home widgets. Runs only while
// `active`; stopped, it keeps its canvas and WebGL context for the next visit. Pointer input
// comes from `hitArea` (the empty part of the home page), so widgets on top keep theirs.
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/context";
import { useColorMode } from "../../theme/mode.ts";
import { useAppearance } from "../../settings/appearance";
import { useReducedMotion } from "../../theme/system.ts";
import type { StarGraph, StarNode } from "./graph";
import { createStarScene, type StarScene } from "./scene";
import "./starmap.css";

declare global {
  interface Window {
    /** Development builds: frames drawn so far, for the probe. */
    __starFrames?: number;
    /** Development builds: the scene, for the probe. */
    __starScene?: StarScene | null;
  }
}

export function StarMap({
  graph,
  colors,
  background,
  active,
  bloom = true,
  hitArea,
  onScene,
  onOpen,
}: {
  graph: StarGraph;
  colors: readonly string[];
  /** The space's wallpaper, drawn behind the stars. */
  background: HTMLCanvasElement | null;
  active: boolean;
  bloom?: boolean;
  hitArea: HTMLElement | null;
  /** The scene (it also draws the glass) and its canvas; null when WebGL is unavailable. */
  onScene: (s: { scene: StarScene; canvas: HTMLCanvasElement } | null) => void;
  onOpen: (node: StarNode) => void;
}) {
  const t = useT();
  const mode = useColorMode();
  const reduceMotion = useReducedMotion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<StarScene | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; node: StarNode; links: number } | null>(
    null,
  );
  const latest = useRef({ onOpen, onScene });
  useEffect(() => {
    latest.current = { onOpen, onScene };
  });

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const s = createStarScene(c, graph, { reduceMotion });
    setScene(s);
    if (import.meta.env.DEV) window.__starScene = s;
    latest.current.onScene(s ? { scene: s, canvas: c } : null);
    return () => {
      s?.dispose();
      latest.current.onScene(null);
    };
  }, [graph, reduceMotion]);

  useEffect(() => scene?.setLook({ mode, colors, background }), [scene, mode, colors, background]);
  useEffect(() => scene?.setBloom(bloom), [scene, bloom]);
  const { glow } = useAppearance();
  useEffect(() => scene?.setGlow(glow), [scene, glow]);

  // The frame loop, only on the home page.
  useEffect(() => {
    if (!scene || !active) return;
    const fit = () => scene.resize(innerWidth, innerHeight, devicePixelRatio || 1);
    fit();
    addEventListener("resize", fit);
    let raf = 0,
      last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      scene.frame(dt, now / 1000, !reduceMotion);
      if (import.meta.env.DEV) window.__starFrames = (window.__starFrames ?? 0) + 1;
      // Cluster names follow their clusters without re-rendering React.
      const els = labels.current?.children;
      scene.labels().forEach((l, i) => {
        const el = els?.[i] as HTMLElement | undefined;
        if (!el) return;
        el.style.transform = `translate(${l.x}px, ${l.y}px) translate(-50%, -100%)`;
        el.style.opacity = l.visible ? "1" : "0";
      });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", fit);
    };
  }, [scene, active, reduceMotion]);

  // Hover lights up what is linked; a click opens it.
  useEffect(() => {
    if (!scene || !hitArea || !active) return;
    const at = (e: PointerEvent | MouseEvent) => {
      // Only the empty background; widgets sit on top of it.
      if (e.target !== hitArea) return null;
      return scene.hit(e.clientX, e.clientY);
    };
    const move = (e: PointerEvent) => {
      const i = at(e);
      scene.setHover(i);
      const node = i === null ? undefined : scene.layout.bodies[i]?.node;
      hitArea.style.cursor = node ? "pointer" : "";
      setTip(
        node ? { x: e.clientX, y: e.clientY, node, links: scene.hovered()?.links ?? 0 } : null,
      );
    };
    const leave = () => {
      scene.setHover(null);
      setTip(null);
    };
    const click = (e: MouseEvent) => {
      const i = at(e);
      const node = i === null ? undefined : scene.layout.bodies[i]?.node;
      if (node) latest.current.onOpen(node);
    };
    hitArea.addEventListener("pointermove", move);
    hitArea.addEventListener("pointerleave", leave);
    hitArea.addEventListener("click", click);
    return () => {
      hitArea.removeEventListener("pointermove", move);
      hitArea.removeEventListener("pointerleave", leave);
      hitArea.removeEventListener("click", click);
      leave();
    };
  }, [scene, hitArea, active]);

  const cluster = (id: string | undefined) => graph.clusters.find((c) => c.id === id);
  const counts = new Map<string, number>();
  for (const n of graph.nodes)
    if (n.cluster) counts.set(n.cluster, (counts.get(n.cluster) ?? 0) + 1);

  return (
    <div className="dem-starmap" hidden={!active}>
      <canvas ref={canvas} className="dem-starmap-canvas" aria-hidden />
      <div ref={labels} className="dem-starmap-labels" aria-hidden>
        {graph.clusters.map((c) => (
          <span key={c.id} className="dem-starmap-label">
            <b>{c.private ? t("starmap.private") : c.name}</b>
            <i>{counts.get(c.id) ?? 0}</i>
          </span>
        ))}
      </div>
      {tip && (
        <div className="dem-starmap-tip" style={{ left: tip.x + 14, top: tip.y + 12 }}>
          <span>
            {cluster(tip.node.cluster)?.private
              ? t("starmap.private")
              : (cluster(tip.node.cluster)?.name ?? t("starmap.loose"))}
          </span>
          {cluster(tip.node.cluster)?.private ? t("starmap.private") : tip.node.title}
          <span>{t("starmap.links", { n: tip.links })}</span>
        </div>
      )}
    </div>
  );
}
