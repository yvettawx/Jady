// System notifications for what is due (PRD E3 without push): once a day per item.
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { Reminder } from "../bindings";
import { api } from "./api";
import { isoDate } from "./model";

const KEY = "ui-notified";

export function notifyDue(
  reminders: Reminder[],
  t: (k: string, v?: Record<string, string>) => string,
) {
  const due = reminders.filter((r) => r.kind !== "stale");
  if (!due.length) return;
  void (async () => {
    const today = isoDate(Date.now());
    const raw = await api.localGet(KEY);
    let seen: { day: string; ids: string[] } = { day: today, ids: [] };
    try {
      const old = raw ? (JSON.parse(raw) as typeof seen) : null;
      if (old?.day === today) seen = old;
    } catch {
      // A broken note only means telling the user once more today.
    }
    const fresh = due.filter((r) => !seen.ids.includes(r.id));
    if (!fresh.length) return;
    let allowed = await isPermissionGranted();
    if (!allowed) allowed = (await requestPermission()) === "granted";
    if (!allowed) return;
    for (const r of fresh)
      sendNotification({
        title: t(`reminder.when.${r.kind}`),
        // The core leaves 机密 titles out of reminders.
        body: r.title ?? t(`reminder.title.${r.kind}`),
      });
    await api.localSet(
      KEY,
      JSON.stringify({ day: today, ids: [...seen.ids, ...fresh.map((r) => r.id)] }),
    );
  })().catch(() => {
    // Notifications are a courtesy: the bell in the app still has them.
  });
}
