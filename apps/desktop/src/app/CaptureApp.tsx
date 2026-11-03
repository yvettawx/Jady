// 全局收集's own window (⌥⌘N, docs/05-design.md §10). It only has the core: nothing is drawn behind
// it, and a locked library says so instead of losing the line.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useT } from "../i18n/context";
import { CaptureWindow } from "../launcher/CaptureWindow";
import type { TypeEntry } from "../launcher/builtins";
import { Icon } from "../ui/Icon";
import { failed, newItem } from "./actions";
import { api } from "./api";
import { iconOf, typeName } from "./model";
import "./app.css";

export function CaptureApp() {
  const t = useT();
  const [types, setTypes] = useState<TypeEntry[]>([]);
  const [open, setOpen] = useState<boolean | null>(null);
  const [session, setSession] = useState(0);
  useEffect(() => {
    document.documentElement.dataset.capture = "true";
    const load = () => {
      void api.libraryIsOpen().then((isOpen) => {
        setOpen(isOpen);
        if (isOpen)
          void api
            .typeList()
            .then((all) =>
              setTypes(
                all
                  .filter((x) => x.id !== "file")
                  .map((x) => ({ id: x.id, name: typeName(t, x), icon: iconOf(x.id) })),
              ),
            );
      });
      setSession((n) => n + 1);
    };
    load();
    const win = getCurrentWindow();
    const off = win.onFocusChanged(({ payload }) => {
      if (payload) load();
      else void win.hide();
    });
    return () => void off.then((f) => f());
  }, [t]);
  const close = () => void getCurrentWindow().hide();
  if (open === null) return null;
  if (!open)
    return (
      <div
        className="dem-capture"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <Icon name="lock" size={16} className="dem-capture-icon" />
        <span className="dem-capture-where">{t("capture.locked")}</span>
      </div>
    );
  return (
    <CaptureWindow
      key={session}
      types={types}
      onCapture={(type, text) => {
        if (!type && /^https?:\/\/\S+$/.test(text)) {
          void api
            .captureUrl(text)
            .then(close)
            .catch(failed(t, t("capture.label")));
          return;
        }
        void api
          .itemCreate(
            newItem(
              type
                ? { typeId: type.id, title: text }
                : { typeId: "note", title: text, state: "inbox" },
            ),
          )
          .then(close)
          .catch(failed(t, t("capture.label")));
      }}
      onClose={close}
    />
  );
}
