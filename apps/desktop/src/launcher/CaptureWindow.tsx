// 全局收集 (docs/05-design.md §10, PRD A13): a one-line window, like Arc's little window, for
// noting something without opening the whole app. Enter puts it in the inbox; a leading type
// name (记忆卡 le quai 站台) makes that type; Esc closes. The global shortcut and the separate
// system window come in P1; this is the window's content.
import { useState } from "react";
import { useT } from "../i18n/context";
import { Icon } from "../ui/Icon";
import type { TypeEntry } from "./builtins";
import "./capture.css";

export function CaptureWindow({
  types,
  onCapture,
  onClose,
}: {
  types: TypeEntry[];
  onCapture: (type: TypeEntry | null, text: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const clean = text.replace(/^[+＋]\s*/, "");
  const [first = "", ...rest] = clean.split(/\s+/);
  const type = types.find((x) => x.name === first) ?? null;
  const body = type ? rest.join(" ") : clean;
  return (
    <div className="dem-capture">
      <Icon name={type?.icon ?? "inbox"} size={16} className="dem-capture-icon" />
      <input
        className="dem-capture-input"
        aria-label={t("capture.label")}
        placeholder={t("capture.placeholder")}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && body.trim()) {
            onCapture(type, body.trim());
            setText("");
          }
        }}
      />
      <span className="dem-capture-where">{type ? type.name : t("capture.inbox")}</span>
    </div>
  );
}
