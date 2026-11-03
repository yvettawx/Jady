/* eslint-disable react-refresh/only-export-components -- the editor draws diagrams with the same colours */
// A Mermaid diagram (PRD A5, docs/05-design.md §3.5): editing shows the source on the left and
// the drawing on the right; reading shows only the drawing. Mermaid is loaded the first time a
// diagram appears and draws in the theme's colours; it runs with securityLevel "strict".
import { useEffect, useId, useState } from "react";
import { useT } from "../../i18n/context";
import { mix } from "../../theme/color.ts";
import { useColorMode } from "../../theme/mode.ts";
import { MODES, type Mode } from "../../theme/tokens.ts";
import { Icon } from "../../ui/Icon";
import { useSheetMode } from "../mode";
import "./blocks.css";

type Mermaid = typeof import("mermaid").default;
let loading: Promise<Mermaid> | null = null;
const loadMermaid = () => (loading ??= import("mermaid").then((m) => m.default));

/** Mermaid works out shades itself, so it needs plain colours rather than CSS variables. */
export function themeFor(mode: Mode) {
  const m = MODES[mode];
  const accent =
    getComputedStyle(document.documentElement).getPropertyValue("--dem-accent").trim() || m.ai;
  return {
    darkMode: mode === "dark",
    background: m.paper,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--dem-font-ui").trim(),
    fontSize: "13px",
    primaryColor: mix(accent, m.paper, 0.16),
    primaryBorderColor: mix(accent, m.paper, 0.7),
    primaryTextColor: m.text,
    secondaryColor: mix(m.ai, m.paper, 0.14),
    tertiaryColor: mix(m.text, m.paper, 0.05),
    lineColor: m.muted,
    textColor: m.text,
    edgeLabelBackground: m.paper,
    clusterBkg: mix(m.text, m.paper, 0.04),
    clusterBorder: m.paperLine,
  };
}

export function MermaidBlock({ initial }: { initial: string }) {
  const t = useT();
  const mode = useSheetMode();
  const colorMode = useColorMode();
  const [src, setSrc] = useState(initial);
  const [out, setOut] = useState<{ svg?: string; error?: string }>({});
  const id = useId().replace(/[^\w-]/g, "");

  // Redraw after typing pauses, and when the theme changes.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void loadMermaid().then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: themeFor(colorMode),
          flowchart: { curve: "basis", htmlLabels: false },
        });
        try {
          const { svg } = await mermaid.render(`dem-mermaid-${id}`, src);
          if (alive) setOut({ svg });
        } catch (e) {
          if (alive) setOut((o) => ({ ...o, error: String((e as Error).message ?? e) }));
        }
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [src, colorMode, id]);

  const drawing = (
    <div className="dem-mermaid-view" data-testid="mermaid-view">
      {out.svg ? (
        // Mermaid's own output under securityLevel "strict" (it sanitises labels).
        <div className="dem-mermaid-svg" dangerouslySetInnerHTML={{ __html: out.svg }} />
      ) : (
        <p className="dem-block-note">{t("editor.block.drawing")}</p>
      )}
      {out.error && mode === "edit" && (
        <p className="dem-block-error" role="status">
          <Icon name="error" size={12} />
          {t("editor.block.mermaidError")}
        </p>
      )}
    </div>
  );
  return (
    <figure className="dem-block dem-mermaid" contentEditable={false} data-mode={mode}>
      <figcaption className="dem-block-head">
        <span className="dem-block-kind">
          <Icon name="diagram" size={12} />
          {t("editor.block.mermaid")}
        </span>
      </figcaption>
      {mode === "edit" ? (
        <div className="dem-mermaid-split">
          <textarea
            className="dem-mermaid-src"
            aria-label={t("editor.block.source", { kind: "Mermaid" })}
            spellCheck={false}
            wrap="off"
            value={src}
            rows={Math.max(4, src.split("\n").length)}
            onChange={(e) => setSrc(e.target.value)}
          />
          {drawing}
        </div>
      ) : (
        drawing
      )}
    </figure>
  );
}
