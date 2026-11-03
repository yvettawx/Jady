// The AI button (docs/05-design.md §2.1): floats above everything, sits in one of the four
// corners, and after a drag snaps to the nearest one. Default bottom right. Pressing it opens
// the launcher (P0.5-07-7).
import { useRef, useState, type CSSProperties } from "react";
import { useT } from "../i18n/context";
import { Glass } from "../ui/glass/Glass";
import { Icon } from "../ui/Icon";
import "./aibutton.css";

export type Corner = "tl" | "tr" | "bl" | "br";
const KEY = "dem.aiButton.corner";
const MARGIN = 20;

function savedCorner(): Corner {
  try {
    const c = localStorage.getItem(KEY);
    return c === "tl" || c === "tr" || c === "bl" || c === "br" ? c : "br";
  } catch {
    return "br";
  }
}

/** What the button keeps clear of at each edge, e.g. the title bar, leftmost bar, status bar. */
export interface Inset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function AiButton({ onPress, inset }: { onPress: () => void; inset: Inset }) {
  const t = useT();
  const [corner, setCorner] = useState<Corner>(savedCorner);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const v = corner[0] === "t" ? "top" : "bottom",
    h = corner[1] === "l" ? "left" : "right";
  const place: CSSProperties = drag
    ? { left: drag.x - 24, top: drag.y - 24 }
    : { [v]: inset[v] + MARGIN, [h]: inset[h] + MARGIN };
  return (
    <Glass
      refract={false}
      className="dem-ai-button"
      data-dragging={drag ? "" : undefined}
      style={place}
      role="button"
      tabIndex={0}
      aria-label={t("shell.ai")}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPress())}
      onPointerDown={(e) => {
        start.current = { px: e.clientX, py: e.clientY, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        if (!s.moved && Math.hypot(e.clientX - s.px, e.clientY - s.py) < 4) return;
        s.moved = true;
        setDrag({ x: e.clientX, y: e.clientY });
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        if (!s?.moved) return onPress();
        const c: Corner = `${e.clientY < innerHeight / 2 ? "t" : "b"}${e.clientX < innerWidth / 2 ? "l" : "r"}`;
        setCorner(c);
        setDrag(null);
        try {
          localStorage.setItem(KEY, c);
        } catch {
          // Only a convenience; the default corner is fine.
        }
      }}
    >
      <Icon name="ai" size={20} />
    </Glass>
  );
}
