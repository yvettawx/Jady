// A memory card inside a note (PRD C1, docs/03-modules.md 编辑器 custom nodes): the front is
// shown, the back only on request, so reading the note still works as a little test.
import { useState } from "react";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import "./blocks.css";

export function MemoryCardBlock({
  front,
  back,
  mastery,
  due,
}: {
  front: string;
  back: string;
  /** 0–100. */
  mastery: number;
  /** Already formatted, e.g. 明天. */
  due: string;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <figure className="dem-block dem-card-block" contentEditable={false}>
      <figcaption className="dem-block-head">
        <span className="dem-block-kind">
          <Icon name="card" size={12} />
          {t("editor.card")}
        </span>
      </figcaption>
      <div className="dem-card-sides">
        <p className="dem-card-front">{front}</p>
        {shown ? (
          <p className="dem-card-back">{back}</p>
        ) : (
          <span className="dem-card-reveal">
            <Button size="sm" variant="quiet" icon="show" onPress={() => setShown(true)}>
              {t("editor.card.reveal")}
            </Button>
          </span>
        )}
        <p className="dem-card-meta">
          <span>
            {t("editor.card.mastery")} <b>{mastery}%</b>
          </span>
          <span>
            {t("editor.card.due")} <b>{due}</b>
          </span>
        </p>
      </div>
    </figure>
  );
}
