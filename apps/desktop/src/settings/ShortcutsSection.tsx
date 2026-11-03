// 快捷键 (docs/05-design.md §11, docs/03-modules.md M11): every registered command by group.
// Click a shortcut and press the new keys; a conflict says which command has them and offers
// to move them over. Changes work at once and show everywhere the shortcut is shown.
import { useContext, useEffect, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { useT } from "../i18n/context";
import {
  commands,
  findConflict,
  isShortcutChanged,
  resetShortcut,
  setShortcut,
  shortcutFromEvent,
  shortcutOf,
  useCommandsVersion,
  type Command,
} from "../shell/commands";
import { Button } from "../ui/Button";
import { formatShortcut } from "../ui/shortcut";
import { showToast } from "../ui/toast";
import { rowMatches, SettingsQueryContext } from "./context";

const GROUP_ORDER = ["general", "sidebar", "spaces", "workspace"];

function ShortcutRow({ cmd }: { cmd: Command }) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [pending, setPending] = useState<{ spec: string; other: Command } | null>(null);
  const spec = shortcutOf(cmd.id);

  // While recording, the keys go here and not to the commands they would normally run.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(false);
      const next = shortcutFromEvent(e);
      if (!next) {
        if (!["Meta", "Control", "Alt", "Shift"].includes(e.key)) setHint(t("shortcuts.needMod"));
        return;
      }
      setRecording(false);
      setHint(null);
      const other = findConflict(next, cmd.id);
      if (other) setPending({ spec: next, other });
      else setShortcut(cmd.id, next);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recording, cmd.id, t]);

  return (
    <li className="dem-shortcut">
      <span className="dem-shortcut-name">{cmd.title}</span>
      <span className="dem-shortcut-keys">
        <AriaButton
          className="dem-shortcut-kbd"
          data-recording={recording || undefined}
          aria-label={t("shortcuts.change", { name: cmd.title })}
          onPress={() => {
            setPending(null);
            setHint(null);
            setRecording((r) => !r);
          }}
        >
          {recording ? t("shortcuts.press") : spec ? formatShortcut(spec) : t("shortcuts.none")}
        </AriaButton>
        {isShortcutChanged(cmd.id) && !recording && (
          <Button variant="quiet" size="sm" onPress={() => resetShortcut(cmd.id)}>
            {t("shortcuts.reset")}
          </Button>
        )}
      </span>
      {(hint || pending) && (
        <p className="dem-shortcut-note" role="status">
          {hint ??
            t("shortcuts.conflict", {
              keys: formatShortcut(pending?.spec ?? ""),
              name: pending?.other.title ?? "",
            })}
          {pending && (
            <span className="dem-shortcut-actions">
              <Button
                size="sm"
                variant="primary"
                onPress={() => {
                  setShortcut(pending.other.id, null);
                  setShortcut(cmd.id, pending.spec);
                  setPending(null);
                }}
              >
                {t("shortcuts.takeOver")}
              </Button>
              <Button size="sm" variant="quiet" onPress={() => setPending(null)}>
                {t("action.cancel")}
              </Button>
            </span>
          )}
        </p>
      )}
    </li>
  );
}

export function ShortcutsSection() {
  const t = useT();
  const query = useContext(SettingsQueryContext);
  useCommandsVersion();
  const shown = commands().filter((c) => {
    const s = shortcutOf(c.id) ?? c.shortcut;
    return rowMatches(
      query,
      c.title,
      s ? [formatShortcut(s), t("settings.section.shortcuts")] : [],
    );
  });
  const groups = [...new Set(shown.map((c) => c.group ?? "general"))].sort(
    (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
  );
  const global = rowMatches(query, t("shortcuts.capture"), [t("shortcuts.global")]);
  return (
    <>
      {groups.map((g) => (
        <div key={g} className="dem-shortcut-group">
          <h3>{t(`shortcuts.group.${g}`)}</h3>
          <ul>
            {shown
              .filter((c) => (c.group ?? "general") === g)
              .map((c) => (
                <ShortcutRow key={c.id} cmd={c} />
              ))}
          </ul>
        </div>
      ))}
      {global && (
        <div className="dem-shortcut-group">
          <h3>{t("shortcuts.global")}</h3>
          <p className="dem-shortcut-global-hint">{t("shortcuts.global.hint")}</p>
          <ul>
            <li className="dem-shortcut">
              <span className="dem-shortcut-name">{t("shortcuts.capture")}</span>
              <span className="dem-shortcut-keys">
                <kbd className="dem-shortcut-kbd">{formatShortcut("Mod+Alt+N")}</kbd>
                <Button size="sm" onPress={() => showToast({ text: t("shortcuts.tryLater") })}>
                  {t("shortcuts.try")}
                </Button>
              </span>
            </li>
          </ul>
        </div>
      )}
      <div className="dem-settings-foot">
        <Button variant="quiet" icon="undo" onPress={() => resetShortcut()}>
          {t("shortcuts.resetAll")}
        </Button>
      </div>
    </>
  );
}
