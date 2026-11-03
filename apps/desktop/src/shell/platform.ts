// Which window chrome to draw. The shell only needs to tell macOS and Windows apart.
export type Platform = "mac" | "windows" | "other";

export function currentPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Mac/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "other";
}

export const inTauri = () => "__TAURI_INTERNALS__" in window;
