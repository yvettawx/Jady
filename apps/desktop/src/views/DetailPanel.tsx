// An item's details, sliding in from the right over the table or board (docs/05-design.md §7).
// Fields can be changed in place; a link in the notes opens a smaller peek (§3.3). Esc puts it
// away, and the focus goes back to the row or card that opened it.
import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../i18n/context";
import { WikiLink, type LinkTarget, type OpenHow } from "../editor/WikiLink";
import { SourceMark, type SourceKind } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { TextField } from "../ui/TextField";
import { Tooltip } from "../ui/Tooltip";
import type { FieldDef, FieldValue, Item, TypeDef } from "./model";
import "../editor/prose.css";
import "./views.css";

/** Notes text with [[links]] turned into peekable links. */
function NotesText({ text, link }: { text: string; link: (target: string) => ReactNode }) {
  return (
    <div className="dem-prose dem-detail-notes">
      {text.split("\n").map((para, i) => (
        <p key={i}>
          {para
            .split(/(\[\[[^\]]+\]\])/)
            .map((part, j) =>
              part.startsWith("[[") ? <span key={j}>{link(part.slice(2, -2))}</span> : part,
            )}
        </p>
      ))}
    </div>
  );
}

export function DetailPanel({
  type,
  item,
  onChange,
  onClose,
  onOpenTab,
  resolve,
  onOpenLink,
}: {
  type: TypeDef;
  item: Item | null;
  onChange: (id: string, fieldId: string, value: FieldValue) => void;
  onClose: () => void;
  onOpenTab: (id: string) => void;
  resolve: (target: string) => LinkTarget | null;
  onOpenLink: (target: string, how: OpenHow) => void;
}) {
  const t = useT();
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const open = item !== null;

  // Into the panel when it opens; back to where the user was when it closes.
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    const back = returnTo;
    return () => back.current?.focus?.();
  }, [open]);

  // Esc from anywhere in the view, unless an overlay inside (a peek, a menu) took it first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".dem-popover")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const fieldEditor = (f: FieldDef, it: Item) => {
    const v = it.values[f.id];
    switch (f.kind) {
      case "select":
        return (
          <Select
            label={f.label}
            options={f.options.map((o) => ({ id: o.id, label: o.label }))}
            selectedKey={typeof v === "string" ? v : null}
            onSelectionChange={(k) => onChange(it.id, f.id, String(k))}
          />
        );
      case "date":
        return (
          <TextField
            label={f.label}
            type="date"
            value={typeof v === "string" ? v : ""}
            onChange={(x) => onChange(it.id, f.id, x || null)}
          />
        );
      case "source":
        return (
          <div className="dem-detail-field">
            <span className="dem-field-label">{f.label}</span>
            {v ? <SourceMark kind={v as SourceKind} /> : null}
          </div>
        );
      case "tags":
        return (
          <div className="dem-detail-field">
            <span className="dem-field-label">{f.label}</span>
            <span className="dem-chips">
              {((v as string[] | null) ?? []).map((tag) => (
                <span key={tag} className="dem-chip">
                  <span aria-hidden>#</span>
                  {tag}
                </span>
              ))}
            </span>
          </div>
        );
      case "longtext":
        return (
          <div className="dem-detail-field">
            <span className="dem-field-label">{f.label}</span>
            <NotesText
              text={String(v ?? "")}
              link={(target) => (
                <WikiLink
                  target={target}
                  resolve={resolve}
                  onOpen={onOpenLink}
                  onCreate={() => onOpenLink(target, "tab")}
                />
              )}
            />
          </div>
        );
      default:
        return f.id === type.titleField ? null : (
          <TextField
            label={f.label}
            value={String(v ?? "")}
            onChange={(x) => onChange(it.id, f.id, x)}
          />
        );
    }
  };

  return (
    <aside
      ref={panel}
      className="dem-detail"
      data-open={open || undefined}
      aria-hidden={!open || undefined}
      inert={!open}
      aria-label={item ? String(item.values[type.titleField] ?? "") : undefined}
    >
      {item && (
        <>
          <div className="dem-detail-bar">
            <Tooltip label={t("detail.openTab")}>
              <Button
                variant="quiet"
                size="sm"
                icon="app-window"
                aria-label={t("detail.openTab")}
                onPress={() => onOpenTab(item.id)}
              />
            </Tooltip>
            <Tooltip label={t("detail.close")} shortcut="Escape">
              <Button
                variant="quiet"
                size="sm"
                icon="close"
                aria-label={t("detail.close")}
                onPress={onClose}
              />
            </Tooltip>
          </div>
          <h2 className="dem-detail-title" ref={heading} tabIndex={-1}>
            {String(item.values[type.titleField] ?? "")}
          </h2>
          <div className="dem-detail-fields">
            {type.fields.map((f) => (
              <div key={f.id}>{fieldEditor(f, item)}</div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
