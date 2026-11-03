// When what has the keyboard goes away (a button that hides itself once pressed, a closed window),
// focus must not fall off the page (docs/05-design.md §3.7). This catches every case in one place:
// the keyboard goes to the nearest 落脚点 still there, or else to the page in the active cell.
// A 落脚点 is an element with data-focus-home, "card" or "page", and tabIndex -1.

const HOME = "[data-focus-home]";
const PAGE = '[data-focus-home="page"]';

const visible = (el: Element) => el.checkVisibility?.() ?? true;

function findHome(path: readonly Element[], root: Document): HTMLElement | null {
  for (const el of path) {
    if (!el.isConnected) continue;
    const near = el.closest<HTMLElement>(HOME);
    if (near) return near;
    // Nothing nearer is left, so the page the user is working in, not the first thing in the tree.
    const active = [...root.querySelectorAll(`.dv-active-group ${PAGE}`)].find(visible);
    if (active) return active as HTMLElement;
    const any = [...el.querySelectorAll(PAGE)].find(visible);
    if (any) return any as HTMLElement;
  }
  return null;
}

/** Install once. Returns how to take it off again. */
export function installFocusRescue(root: Document = document): () => void {
  let path: Element[] = [];
  let waiting = false;
  const onFocusIn = (e: FocusEvent) => {
    path = [];
    for (let n = e.target as Element | null; n; n = n.parentElement) path.push(n);
  };
  const observer = new MutationObserver(() => {
    const last = path[0];
    if (!last || last.isConnected || waiting) return;
    waiting = true;
    // A closing overlay puts focus back itself; only step in if nothing did.
    requestAnimationFrame(() => {
      waiting = false;
      const lost = root.activeElement === root.body || root.activeElement === null;
      if (lost) findHome(path, root)?.focus({ preventScroll: true });
      path = [];
    });
  });
  root.addEventListener("focusin", onFocusIn);
  observer.observe(root.body, { childList: true, subtree: true });
  return () => {
    root.removeEventListener("focusin", onFocusIn);
    observer.disconnect();
  };
}
