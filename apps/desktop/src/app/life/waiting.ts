// What a scheduled task wanted to send in the dedicated browser while nobody answered. Nothing was
// sent; the question is kept on this computer until you are back. Saying go runs the task again
// with you here, so each request comes to you as it happens, instead of replaying one out of its
// page.
import { useEffect, useState } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { Translate } from "../../i18n/messages";
import { api } from "../api";

const KEY = "scheduled-waiting";

export interface Waiting {
  /** The browser's request id, unique while the app runs; with `at`, unique for good. */
  id: number;
  taskId: string;
  title: string;
  method: string;
  host: string;
  at: number;
}

let running: { id: string; title: string } | null = null;

/** Set while a scheduled task runs, so an unanswered question can say whose it was. */
export function setRunningTask(task: { id: string; title: string } | null) {
  running = task;
}

export function runningTask() {
  return running;
}

const listeners = new Set<() => void>();

async function load(): Promise<Waiting[]> {
  try {
    const raw = await api.localGet(KEY);
    return raw ? (JSON.parse(raw) as Waiting[]) : [];
  } catch {
    return [];
  }
}

async function save(all: Waiting[]) {
  await api.localSet(KEY, JSON.stringify(all));
  listeners.forEach((f) => f());
}

export async function addWaiting(t: Translate, w: Waiting) {
  await save([...(await load()), w]);
  try {
    let allowed = await isPermissionGranted();
    if (!allowed) allowed = (await requestPermission()) === "granted";
    if (allowed) sendNotification({ title: t("scheduled.waiting"), body: w.title });
  } catch {
    // The list in the panel still has it.
  }
}

/** Drops every question of one task: it is run again, or you said no. */
export async function dropWaiting(taskId: string) {
  await save((await load()).filter((w) => w.taskId !== taskId));
}

export function useWaiting(): Waiting[] {
  const [all, setAll] = useState<Waiting[]>([]);
  useEffect(() => {
    let alive = true;
    const read = () => void load().then((w) => alive && setAll(w));
    read();
    listeners.add(read);
    return () => {
      alive = false;
      listeners.delete(read);
    };
  }, []);
  return all;
}
