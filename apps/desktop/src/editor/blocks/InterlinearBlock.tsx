// 对照文本 (PRD A6): original, transliteration and notes lined up word by word, with the translation
// under each line. A word keeps its stack together when the line wraps, so narrow cells stay
// aligned. The other layers can be turned off to read the original alone.
import { useState } from "react";
import { useT } from "../../i18n/context";
import { Icon } from "../../ui/Icon";

export interface InterlinearWord {
  text: string;
  translit?: string;
  gloss?: string;
}
export interface InterlinearLine {
  words: InterlinearWord[];
  translation?: string;
}
type Layer = "translit" | "gloss" | "translation";
const LAYERS: Layer[] = ["translit", "gloss", "translation"];

export function InterlinearBlock({
  lines,
  lang,
}: {
  lines: InterlinearLine[];
  /** The original's language, so it gets the right glyphs and a screen reader the right voice. */
  lang: string;
}) {
  const t = useT();
  const [hidden, setHidden] = useState<ReadonlySet<Layer>>(new Set());
  const on = (l: Layer) => !hidden.has(l);
  return (
    <figure className="dem-block dem-inter" contentEditable={false}>
      <figcaption className="dem-block-head">
        <span className="dem-block-kind">
          <Icon name="translate" size={12} />
          {t("editor.block.interlinear")}
        </span>
        <span className="dem-inter-layers" role="group" aria-label={t("editor.block.interlinear")}>
          {LAYERS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={on(l)}
              onClick={() =>
                setHidden((s) => {
                  const next = new Set(s);
                  if (!next.delete(l)) next.add(l);
                  return next;
                })
              }
            >
              {t(`editor.inter.${l}`)}
            </button>
          ))}
        </span>
      </figcaption>
      <div className="dem-inter-body">
        {lines.map((line, i) => (
          <div key={i} className="dem-inter-line">
            <div className="dem-inter-words">
              {line.words.map((w, j) => (
                <span key={j} className="dem-inter-word">
                  <span className="dem-inter-text" lang={lang}>
                    {w.text}
                  </span>
                  {on("translit") && <span className="dem-inter-translit">{w.translit}</span>}
                  {on("gloss") && <span className="dem-inter-gloss">{w.gloss}</span>}
                </span>
              ))}
            </div>
            {on("translation") && line.translation && (
              <p className="dem-inter-translation">{line.translation}</p>
            )}
          </div>
        ))}
      </div>
    </figure>
  );
}
