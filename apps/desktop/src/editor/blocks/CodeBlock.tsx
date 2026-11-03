// A code block (docs/05-design.md §3.5). Editing types into a transparent text area laid exactly
// over the highlighted code, so the colours stay while typing; reading shows only the code.
// P1 swaps in CodeMirror inside the editor's node view.
import { useRef, useState } from "react";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { showToast } from "../../ui/toast";
import { Tooltip } from "../../ui/Tooltip";
import { useSheetMode } from "../mode";
import { highlight } from "./highlight";
import "./blocks.css";

export function CodeBlock({ language, initial }: { language: string; initial: string }) {
  const t = useT();
  const mode = useSheetMode();
  const [src, setSrc] = useState(initial);
  const pre = useRef<HTMLPreElement>(null);
  const code = (
    <pre ref={pre} className="dem-code-view" aria-hidden={mode === "edit" || undefined}>
      {highlight(src).map((tok, i) =>
        tok.kind === "plain" ? (
          tok.text
        ) : (
          <span key={i} data-tok={tok.kind}>
            {tok.text}
          </span>
        ),
      )}
      {/* A trailing newline would otherwise collapse and the overlay would drift by a line. */}
      {src.endsWith("\n") ? " " : ""}
    </pre>
  );
  return (
    <figure className="dem-block dem-code" contentEditable={false} data-mode={mode}>
      <figcaption className="dem-block-head">
        <span className="dem-block-kind">{language}</span>
        <Tooltip label={t("editor.block.copy")}>
          <Button
            variant="quiet"
            size="sm"
            icon="copy"
            aria-label={t("editor.block.copy")}
            onPress={() => {
              void navigator.clipboard?.writeText(src);
              showToast({ text: t("editor.block.copied") });
            }}
          />
        </Tooltip>
      </figcaption>
      <div className="dem-code-area">
        {code}
        {mode === "edit" && (
          <textarea
            className="dem-code-input"
            aria-label={t("editor.block.source", { kind: language })}
            spellCheck={false}
            value={src}
            onChange={(e) => setSrc(e.target.value)}
            onScroll={(e) => {
              if (pre.current) {
                pre.current.scrollTop = e.currentTarget.scrollTop;
                pre.current.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
          />
        )}
      </div>
    </figure>
  );
}
