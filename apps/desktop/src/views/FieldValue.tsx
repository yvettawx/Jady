// One field's value in a table cell or on a card, drawn by the field's kind.
import { useLocale } from "../i18n/context";
import { Badge, SourceMark, type SourceKind } from "../ui/Badge";
import { daysUntil, type FieldDef, type FieldValue as Value } from "./model";
import "./views.css";

/** A due date: the date itself, or how soon within a week; amber when close, red when past. */
function DueDate({ iso }: { iso: string }) {
  const locale = useLocale();
  const days = daysUntil(iso);
  const near = days >= 0 && days <= 7;
  const text = near
    ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day")
    : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
        new Date(`${iso}T00:00`),
      );
  return (
    <time
      className="dem-due"
      dateTime={iso}
      data-state={days < 0 ? "past" : days <= 3 ? "soon" : undefined}
    >
      {text}
    </time>
  );
}

export function FieldValue({ field, value }: { field: FieldDef; value: Value | undefined }) {
  if (value == null || value === "" || (Array.isArray(value) && !value.length))
    return <span className="dem-field-empty" aria-hidden />;
  switch (field.kind) {
    case "select": {
      const o = field.options.find((x) => x.id === value);
      return o ? <Badge tone={o.tone}>{o.label}</Badge> : null;
    }
    case "date":
      return <DueDate iso={String(value)} />;
    case "source":
      return <SourceMark kind={value as SourceKind} />;
    case "tags":
      return (
        <span className="dem-chips">
          {(value as string[]).map((t) => (
            <span key={t} className="dem-chip">
              <span aria-hidden>#</span>
              {t}
            </span>
          ))}
        </span>
      );
    default:
      return <span className="dem-field-text">{String(value)}</span>;
  }
}
