// A note as a sheet of paper (docs/05-design.md §3.5, §6.1, §15, P0.5 visual final): its own
// format bar on top, then the archive number, kind and date, the title and the long text.
// Each tab has its own mode: 编辑 (default) or 阅读. The format commands are passed in, so the
// editor chosen in P1 (ProseMirror) plugs in without changing this.
import type { ReactNode } from "react";
import { useT } from "../i18n/context";
import { aiBlockedReason } from "../privacy/text";
import { PrivacyMark, type PrivacyLevel } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import type { IconName } from "../ui/icons";
import { Segmented } from "../ui/Segmented";
import { Tooltip } from "../ui/Tooltip";
import { SheetModeContext, type SheetMode } from "./mode";
import "./prose.css";
import "./sheet.css";

export type { SheetMode };

export type FormatCommand =
  | "bold"
  | "italic"
  | "underline"
  | "highlight"
  | "heading"
  | "bullets"
  | "numbers"
  | "tasks"
  | "quote"
  | "code"
  | "link";

const FORMATS: { cmd: FormatCommand; icon: IconName; shortcut?: string }[] = [
  { cmd: "bold", icon: "bold", shortcut: "Mod+B" },
  { cmd: "italic", icon: "italic", shortcut: "Mod+I" },
  { cmd: "underline", icon: "underline", shortcut: "Mod+U" },
  { cmd: "highlight", icon: "highlight" },
  { cmd: "heading", icon: "heading", shortcut: "Mod+Alt+2" },
  { cmd: "bullets", icon: "list-bullet" },
  { cmd: "numbers", icon: "list-ordered" },
  { cmd: "tasks", icon: "list-tasks" },
  { cmd: "quote", icon: "quote" },
  { cmd: "code", icon: "code" },
  { cmd: "link", icon: "link" },
];
/** Groups in the bar: marks, blocks, links. */
const BREAK_AFTER = new Set<FormatCommand>(["highlight", "code"]);

export function NoteSheet({
  number,
  kind,
  kindIcon = "file",
  date,
  title,
  titleSlot,
  tools,
  mode,
  onMode,
  onFormat,
  privacy = "normal",
  meta,
  onAi,
  children,
}: {
  /** The archive number shown before the title, e.g. 0142. */
  number: string;
  kind: string;
  kindIcon?: IconName;
  date: string;
  title: string;
  /** Takes the title's place, e.g. an input for editing it. */
  titleSlot?: ReactNode;
  /** More buttons at the end of the bar. */
  tools?: ReactNode;
  mode: SheetMode;
  onMode: (m: SheetMode) => void;
  onFormat: (cmd: FormatCommand) => void;
  /** AI items follow it (§5.6). */
  privacy?: PrivacyLevel;
  /** Beside the kind and date: the level, or a picker to change it. */
  meta?: ReactNode;
  /** Left out while there is no AI: its buttons do not show. */
  onAi?: (action: "summary" | "organize") => void;
  /** The long text: a .dem-prose element (contenteditable now, the P1 editor later). */
  children: ReactNode;
}) {
  const t = useT();
  const editing = mode === "edit";
  const blocked = aiBlockedReason(t, privacy);
  return (
    <article className="dem-sheet" data-focus-home="page" tabIndex={-1} data-mode={mode}>
      <div className="dem-edbar" role="toolbar" aria-label={t("editor.formats")}>
        {FORMATS.map((f) => (
          <span key={f.cmd} className="dem-edbar-item">
            <Tooltip label={t(`editor.fmt.${f.cmd}`)} shortcut={f.shortcut}>
              <Button
                variant="quiet"
                size="sm"
                icon={f.icon}
                aria-label={t(`editor.fmt.${f.cmd}`)}
                isDisabled={!editing}
                // Keep the focus, and so the selection, in the text.
                preventFocusOnPress
                onPress={() => onFormat(f.cmd)}
              />
            </Tooltip>
            {BREAK_AFTER.has(f.cmd) && <span className="dem-edbar-sep" aria-hidden />}
          </span>
        ))}
        <span className="dem-edbar-gap" />
        <Segmented
          aria-label={t("editor.mode")}
          options={[
            { id: "edit", label: t("editor.mode.edit") },
            { id: "read", label: t("editor.mode.read") },
          ]}
          value={mode}
          onChange={(id) => onMode(id as SheetMode)}
        />
        {onAi &&
          (["summary", "organize"] as const).map((a) => (
            <span key={a} className="dem-edbar-ai">
              <Tooltip label={blocked ?? t(`editor.ai.${a}.hint`)}>
                <Button size="sm" icon="ai" isDisabled={!!blocked} onPress={() => onAi(a)}>
                  {t(`editor.ai.${a}`)}
                </Button>
              </Tooltip>
            </span>
          ))}
        {tools}
      </div>
      <div className="dem-sheet-body">
        <div className="dem-sheet-page">
          <p className="dem-sheet-meta">
            <span className="dem-sheet-no">
              {t("editor.no")}
              <span>{number}</span>
            </span>
            <span className="dem-sheet-kind">
              <Icon name={kindIcon} size={12} />
              {kind}
            </span>
            <span>{date}</span>
            {meta ?? <PrivacyMark level={privacy} />}
          </p>
          <h1 className="dem-sheet-title">{titleSlot ?? title}</h1>
          <SheetModeContext.Provider value={mode}>{children}</SheetModeContext.Provider>
        </div>
      </div>
    </article>
  );
}
