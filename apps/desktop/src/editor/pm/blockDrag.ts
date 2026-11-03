// 段落拖动 (P1 step 6, docs/05-design.md §3.8): a handle beside the block under the pointer. Dragging
// it moves the whole block; ProseMirror does the drop, so undo and the CRDT see one ordinary move.
import { NodeSelection, Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

export function blockDragPlugin(label: () => string) {
  return new Plugin({
    view(view) {
      const handle = document.createElement("div");
      handle.className = "dem-pm-handle";
      handle.draggable = true;
      handle.hidden = true;
      handle.setAttribute("aria-hidden", "true");
      handle.title = label();
      view.dom.parentElement?.append(handle);
      let pos: number | null = null;

      const place = (e: MouseEvent) => {
        if (!view.editable) return (handle.hidden = true);
        const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
        const $pos = at && view.state.doc.resolve(at.pos);
        // The top-level block under the pointer.
        const top = !$pos
          ? null
          : $pos.depth > 0
            ? $pos.before(1)
            : $pos.nodeAfter
              ? $pos.pos
              : null;
        const dom = top === null ? null : view.nodeDOM(top);
        if (top === null || !(dom instanceof HTMLElement)) return (handle.hidden = true);
        pos = top;
        const host = handle.parentElement;
        if (!host) return;
        const a = dom.getBoundingClientRect();
        const b = host.getBoundingClientRect();
        handle.style.top = `${a.top - b.top}px`;
        return (handle.hidden = false);
      };
      const hide = (e: MouseEvent) => {
        if (e.relatedTarget !== handle) handle.hidden = true;
      };
      const dragStart = (e: DragEvent) => {
        if (pos === null || !e.dataTransfer) return;
        const sel = NodeSelection.create(view.state.doc, pos);
        view.dispatch(view.state.tr.setSelection(sel));
        const slice = sel.content();
        const { dom, text } = view.serializeForClipboard(slice);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/html", dom.innerHTML);
        e.dataTransfer.setData("text/plain", text);
        const block = view.nodeDOM(pos);
        if (block instanceof HTMLElement) e.dataTransfer.setDragImage(block, 0, 0);
        (view as EditorView & { dragging: unknown }).dragging = { slice, move: true };
      };
      view.dom.addEventListener("mousemove", place);
      view.dom.addEventListener("mouseleave", hide);
      handle.addEventListener("dragstart", dragStart);
      return {
        destroy() {
          view.dom.removeEventListener("mousemove", place);
          view.dom.removeEventListener("mouseleave", hide);
          handle.remove();
        },
      };
    },
  });
}
