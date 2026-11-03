// A 年历墙: weeks across, days down, each square split by type in proportion and lit by how much
// happened. A ripple follows the pointer; the year sweeps in from the left.
import { useEffect, useMemo, useRef } from "react";
import { useLocale } from "react-aria-components";
import { useAppearance } from "../settings/appearance";
import { useReducedMotion } from "../theme/system.ts";
import { easeOutBack, fitCanvas, useElementSize, useHeatLook } from "./look";
import { dayShares, intensityScale, parseDate, weekGrid, type HeatData } from "./model";

const SWEEP = 900;
const RIPPLE_RADIUS = 64;
/** A small widget shows the recent weeks at a size you can read and point at, not a year of dots. */
const COMPACT_CELL = 13;
/** A second type shows only if it is at least this much of the day. */
const MIN_SECOND = 0.2;

export function YearWall({
  data,
  hidden,
  cursor,
  compact,
  onHover,
  onPick,
  locate,
}: {
  data: HeatData;
  hidden: ReadonlySet<string>;
  /** The day the pointer or the keyboard is on. */
  cursor: number | null;
  /** Small widget: labels go, the shape stays. */
  compact: boolean;
  onHover: (index: number | null, x: number, y: number) => void;
  onPick: (index: number, x: number, y: number) => void;
  /** Tells HeatMap how to find a day on screen, in client px. */
  locate: (fn: (index: number) => { x: number; y: number } | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { w, h } = useElementSize(host);
  const look = useHeatLook(data.types);
  const reduce = useReducedMotion();
  const { glow } = useAppearance();
  const { locale } = useLocale();
  const grid = useMemo(() => weekGrid(data.days), [data.days]);
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);
  const scale = useMemo(() => intensityScale(data.days, hidden), [data.days, hidden]);
  const allCols = (grid[grid.length - 1]?.col ?? 0) + 1;
  const wanted = compact ? Math.min(COMPACT_CELL, h / 7) : 0;
  const cols = wanted > 0 ? Math.min(allCols, Math.max(1, Math.floor(w / wanted))) : allCols;
  /** Weeks left off on the left. */
  const skip = allCols - cols;
  const left = compact ? 0 : 22;
  const top = compact ? 0 : 18;
  const cell = Math.min((w - left) / cols, (h - top) / 7);
  const gap = Math.max(1, Math.min(3, cell * 0.14));
  const x0 = left + (w - left - cell * cols) / 2;
  const y0 = top + (h - top - cell * 7) / 2;

  const anim = useRef({ start: 0, pointer: null as null | { x: number; y: number }, glow: 0 });

  useEffect(() => {
    const el = canvas.current;
    if (!el || !look || !w || !h || cell <= 0) return;
    const state = anim.current;
    if (!state.start) state.start = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      raf = 0;
      const g = fitCanvas(el, w, h);
      if (!g) return;
      g.clearRect(0, 0, w, h);
      const sweep = reduce ? 1 : Math.min(1, (now - state.start) / SWEEP);
      const target = state.pointer ? 1 : 0;
      state.glow += (target - state.glow) * (reduce ? 1 : 0.18);
      const p = state.pointer;
      if (!compact) {
        g.font = `10px ${look.font}`;
        g.fillStyle = look.muted;
        g.textBaseline = "alphabetic";
        let lastMonth = -1;
        data.days.forEach((d, i) => {
          const at = grid[i];
          const date = parseDate(d.date);
          if (!at || at.col < skip || at.row !== 0 || date.getMonth() === lastMonth) return;
          lastMonth = date.getMonth();
          if (at.col < allCols - 1) g.fillText(fmt.format(date), x0 + at.col * cell, y0 - 6);
        });
      }
      data.days.forEach((d, i) => {
        const at = grid[i];
        if (!at || at.col < skip) return;
        const local = Math.max(0, Math.min(1, sweep * 1.6 - ((at.col - skip) / cols) * 0.6));
        if (local <= 0) return;
        const pop = reduce ? 1 : easeOutBack(local);
        const cx = x0 + (at.col - skip) * cell + cell / 2;
        const cy = y0 + at.row * cell + cell / 2;
        let grow = pop;
        if (p && state.glow > 0.01) {
          const dist = Math.hypot(cx - p.x, cy - p.y);
          grow *= 1 + 0.32 * state.glow * Math.max(0, 1 - dist / RIPPLE_RADIUS) ** 2;
        }
        const size = (cell - gap) * grow;
        if (size <= 0) return;
        const x = cx - size / 2;
        const y = cy - size / 2;
        const radius = Math.min(size * 0.26, 4);
        const level = scale(d);
        const shares = dayShares(d, data.types, hidden);
        g.save();
        g.beginPath();
        g.roundRect(x, y, size, size, radius);
        if (!shares.length) {
          g.globalAlpha = 1;
          g.fillStyle = look.line;
          g.fill();
          g.restore();
          return;
        }
        // Big enough to read, each type gets its slice; too small, the main one stands for all.
        const biggest = shares.reduce((a, b) => (b.share > a.share ? b : a));
        if (level > 0.82 && !reduce && !compact && glow > 0) {
          g.shadowColor = look.types[biggest.type] ?? look.accent;
          g.shadowBlur = 8 * level * glow;
        }
        g.globalAlpha = 0.35 + 0.65 * level;
        g.fillStyle = look.types[biggest.type] ?? look.accent;
        g.fill();
        g.shadowBlur = 0;
        // Two colours at most: more turns a small square to mud, and the card has the rest.
        const second = shares
          .filter((s) => s !== biggest)
          .reduce<(typeof shares)[number] | null>(
            (a, b) => (!a || b.share > a.share ? b : a),
            null,
          );
        if (size >= 7 && second && second.share >= MIN_SECOND) {
          const part = size * (second.share / (biggest.share + second.share));
          g.clip();
          g.fillStyle = look.types[second.type] ?? look.accent;
          g.fillRect(x, y + size - part, size, part);
        }
        g.restore();
      });
      if (cursor !== null) {
        const at = grid[cursor];
        if (at) {
          g.strokeStyle = look.text;
          g.lineWidth = 1.5;
          g.beginPath();
          g.roundRect(
            x0 + (at.col - skip) * cell - 0.5,
            y0 + at.row * cell - 0.5,
            cell - gap + 1,
            cell - gap + 1,
            3,
          );
          g.stroke();
        }
      }
      if (sweep < 1 || Math.abs(target - state.glow) > 0.01) raf = requestAnimationFrame(draw);
    };
    const request = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    request();
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      state.pointer = { x, y };
      request();
      const col = Math.floor((x - x0) / cell) + skip;
      const row = Math.floor((y - y0) / cell);
      const index = grid.findIndex((a) => a.col === col && a.row === row);
      onHover(index >= 0 ? index : null, e.clientX, e.clientY);
    };
    const onLeave = () => {
      state.pointer = null;
      request();
      onHover(null, 0, 0);
    };
    const onClick = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const col = Math.floor((e.clientX - r.left - x0) / cell) + skip;
      const row = Math.floor((e.clientY - r.top - y0) / cell);
      const index = grid.findIndex((a) => a.col === col && a.row === row);
      if (index >= 0) onPick(index, e.clientX, e.clientY);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("click", onClick);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("click", onClick);
    };
  }, [
    data,
    hidden,
    cursor,
    compact,
    look,
    w,
    h,
    cell,
    gap,
    x0,
    y0,
    cols,
    grid,
    scale,
    reduce,
    fmt,
    glow,
    skip,
    allCols,
    onHover,
    onPick,
  ]);

  useEffect(() => {
    locate((i) => {
      const at = grid[i];
      const r = canvas.current?.getBoundingClientRect();
      if (!at || !r || at.col < skip) return null;
      return {
        x: r.left + x0 + (at.col - skip) * cell + cell / 2,
        y: r.top + y0 + at.row * cell + cell / 2,
      };
    });
  }, [locate, grid, x0, y0, cell, skip]);

  return (
    <div ref={host} className="dem-heat-stage">
      <canvas ref={canvas} className="dem-heat-canvas" style={{ width: w, height: h }} />
    </div>
  );
}
