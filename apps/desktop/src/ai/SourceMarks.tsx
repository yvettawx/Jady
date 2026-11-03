// The marks beside a title or under an AI answer, quiet until something needs you. On a note they
// open a small card: where it came from, 查过了, and a date to look at it again.
import { useRef, useState } from "react";
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Popover,
  useLocale,
} from "react-aria-components";
import { parseDate, dateKey } from "../heatmap/model";
import { useT } from "../i18n/context";
import { SourceMark } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { recheckDue, sourceMarks, type SourceInfo } from "./source";
import "./chat.css";

function RecheckMark({ on, today }: { on: string; today: string }) {
  const t = useT();
  const { locale } = useLocale();
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
    parseDate(on),
  );
  return on <= today ? (
    <span className="dem-mark dem-recheck" data-due>
      <Icon name="calendar" size={12} />
      {t("source.recheck.due")}
    </span>
  ) : (
    <span className="dem-mark dem-recheck">
      <Icon name="calendar" size={12} />
      {t("source.recheck.on", { date: day })}
    </span>
  );
}

function Refs({ refs }: { refs: string[] }) {
  return (
    <ul className="dem-source-refs">
      {refs.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

/** Read only, under something AI said. */
export function SourceLine({ source }: { source: SourceInfo }) {
  const marks = sourceMarks(source);
  if (!marks.length && !source.refs.length) return null;
  return (
    <div className="dem-source-line" data-testid="source-line">
      {marks.map((k) => (
        <SourceMark key={k} kind={k} />
      ))}
      {source.refs.length > 0 && <Refs refs={source.refs} />}
    </div>
  );
}

/** Beside a note's title: the marks, and the card to deal with them. */
export function SourceButton({
  source,
  onChange,
  today = dateKey(new Date()),
}: {
  source: SourceInfo;
  onChange: (next: SourceInfo) => void;
  today?: string;
}) {
  const t = useT();
  const [date, setDate] = useState(source.recheckOn ?? "");
  const card = useRef<HTMLElement>(null);
  const marks = sourceMarks(source);
  const quiet = !marks.length && !source.recheckOn;
  return (
    <DialogTrigger>
      <AriaButton
        className="dem-source-button"
        aria-label={t("source.title")}
        data-quiet={quiet || undefined}
      >
        {quiet && <Icon name="calendar" size={12} />}
        {marks.map((k) => (
          <SourceMark key={k} kind={k} />
        ))}
        {source.recheckOn && <RecheckMark on={source.recheckOn} today={today} />}
      </AriaButton>
      <Popover className="dem-popover dem-source-card" placement="bottom start" offset={4}>
        <Dialog ref={card} aria-label={t("source.title")}>
          <p className="dem-source-origin">
            <SourceMark kind={source.origin} />
          </p>
          {source.conflict && <p className="dem-source-note">{t("source.conflict.note")}</p>}
          {source.refs.length > 0 && (
            <>
              <h4>{t("source.refs")}</h4>
              <Refs refs={source.refs} />
            </>
          )}
          {source.needsCheck ? (
            <Button size="sm" onPress={() => onChange({ ...source, needsCheck: false })}>
              {t("source.checked")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="quiet"
              onPress={() => onChange({ ...source, needsCheck: true })}
            >
              {t("source.needsCheck")}
            </Button>
          )}
          <h4>{t("source.recheck")}</h4>
          <div className="dem-source-date">
            <input
              type="date"
              aria-label={t("source.recheck")}
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                onChange({ ...source, recheckOn: e.target.value || undefined });
              }}
            />
            {recheckDue(source, today) && (
              <Button
                size="sm"
                onPress={() => {
                  setDate("");
                  onChange({ ...source, recheckOn: undefined });
                  // This button goes away. Focus must stay in the card, or Esc cannot close it.
                  card.current?.focus();
                }}
              >
                {t("source.rechecked")}
              </Button>
            )}
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
