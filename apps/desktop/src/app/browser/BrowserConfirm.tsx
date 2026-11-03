// When AI's click or typing in the dedicated browser would send something to a site, it waits here
// for you (D15). No answer within two minutes counts as no; if a scheduled task asked, the question
// is kept for when you are back (life/waiting.ts).
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { Dialog, DialogActions } from "../../ui/Dialog";
import { api } from "../api";
import { addWaiting, runningTask } from "../life/waiting";

interface Ask {
  id: number;
  method?: string;
  url?: string;
  host?: string;
  done?: boolean;
  unanswered?: boolean;
}

export function BrowserConfirm() {
  const t = useT();
  const [asks, setAsks] = useState<Ask[]>([]);
  const open = useRef(new Map<number, Ask>());
  useEffect(() => {
    const off = listen<Ask>("browser-confirm", (e) => {
      const ask = e.payload;
      const was = open.current.get(ask.id);
      if (ask.done) open.current.delete(ask.id);
      else open.current.set(ask.id, ask);
      const task = runningTask();
      if (ask.done && ask.unanswered && was && task)
        void addWaiting(t, {
          id: ask.id,
          taskId: task.id,
          title: task.title,
          method: was.method ?? "",
          host: was.host ?? "",
          at: Date.now(),
        });
      setAsks((all) =>
        ask.done
          ? all.filter((a) => a.id !== ask.id)
          : [...all.filter((a) => a.id !== ask.id), ask],
      );
    });
    return () => void off.then((f) => f());
  }, [t]);
  const ask = asks[0];
  if (!ask) return null;
  const answer = (allow: boolean) => {
    setAsks((all) => all.filter((a) => a.id !== ask.id));
    void api.browserDecide(ask.id, allow);
  };
  return (
    <Dialog
      isOpen
      isDismissable={false}
      role="alertdialog"
      title={t("browser.confirm.title", { host: ask.host ?? "" })}
    >
      <div className="dem-dialog-body">
        <p>{t("browser.confirm.message")}</p>
        <code className="dem-browser-request">{`${ask.method ?? ""} ${ask.url ?? ""}`}</code>
      </div>
      <DialogActions>
        <Button onPress={() => answer(false)} autoFocus>
          {t("browser.confirm.deny")}
        </Button>
        <Button variant="primary" onPress={() => answer(true)}>
          {t("browser.confirm.allow")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
