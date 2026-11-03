// `?问题` from the launcher becomes a small AI window (docs/05-design.md §5.3), here only the
// moment it opens: the question, the scope and where the answer will go. The window itself
// (streaming answers, 插入原文下方, 存为新笔记) is designed in P0.5-09 and built in P3.
import { useEffect, useRef } from "react";
import { useT } from "../i18n/context";
import type { AiSession } from "../privacy/policy";
import { Button } from "../ui/Button";
import { Glass } from "../ui/glass/Glass";
import { Icon } from "../ui/Icon";
import "./ask.css";

export function AskWindow({
  question,
  scope,
  session = "plain",
  onClose,
}: {
  question: string;
  scope?: string;
  session?: AiSession;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Glass refract={false} className="dem-ask" role="dialog" aria-label={t("ask.title")}>
      <div
        ref={ref}
        className="dem-ask-inner"
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <header className="dem-ask-head">
          <Icon name="ai" size={14} />
          <span>{t("ask.title")}</span>
          {scope && <span className="dem-ask-scope">@{scope}</span>}
          {session !== "plain" && (
            <>
              <span className="dem-ask-scope" data-testid="ask-authorized">
                {t(`privacy.session.${session}`)}
              </span>
              {session === "authorized" && (
                <span className="dem-ask-scope">{t("privacy.session.noWeb")}</span>
              )}
            </>
          )}
          <span className="dem-ask-gap" />
          <Button
            variant="quiet"
            size="sm"
            icon="close"
            aria-label={t("ask.close")}
            onPress={onClose}
          />
        </header>
        <div className="dem-ask-body">
          <p className="dem-ask-me">{question}</p>
          <p className="dem-ask-ai">{t("ask.pending")}</p>
        </div>
      </div>
    </Glass>
  );
}
