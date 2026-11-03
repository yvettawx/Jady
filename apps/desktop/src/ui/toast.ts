// The app-wide queue of 提示条. Show one with showToast(); <ToastRegion /> draws them.
// React Aria's toast API is still marked UNSTABLE; only this file and Toasts.tsx touch it.
import { UNSTABLE_ToastQueue as ToastQueue } from "react-aria-components";

export interface ToastContent {
  text: string;
  tone?: "neutral" | "ok" | "danger";
  /** One short action, such as 撤销. */
  action?: { label: string; onAction: () => void };
}

export const toastQueue = new ToastQueue<ToastContent>({ maxVisibleToasts: 3 });

/** Plain toasts leave after 5 s; ones with an action stay 8 s so there is time to use it. */
export function showToast(content: ToastContent): string {
  return toastQueue.add(content, { timeout: content.action ? 8000 : 5000 });
}
