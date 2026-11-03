// Data from the core that stays current: loads when asked for and again whenever an item changes.
import { useEffect, useRef, useState } from "react";
import { onItemsChanged } from "./api";

/** `load` runs now and after each change. A newer answer always beats a slower older one. */
export function useLive<T>(
  load: () => Promise<T>,
  initial: T,
  deps: readonly unknown[] = [],
): { data: T; ready: boolean; error: Error | null } {
  const [state, setState] = useState({ data: initial, ready: false, error: null as Error | null });
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    let alive = true;
    let run = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      const mine = ++run;
      latest.current().then(
        (data) => {
          if (alive && mine === run) setState({ data, ready: true, error: null });
        },
        (error: Error) => {
          if (alive && mine === run) setState((s) => ({ ...s, ready: true, error }));
        },
      );
    };
    go();
    // A burst of changes (typing, an import) is one refresh.
    const off = onItemsChanged(() => {
      clearTimeout(timer);
      timer = setTimeout(go, 120);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
    // `deps` is the caller's: what `load` depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
