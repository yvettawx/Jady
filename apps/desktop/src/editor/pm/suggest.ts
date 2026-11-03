// `[[` and `/`: a word typed in the text opens a list next to the caret. The plugin only watches
// the text and hands the keys to whoever shows the list, so it knows nothing about React.
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

export interface SuggestState {
  kind: "link" | "slash";
  query: string;
  from: number;
  to: number;
}

const key = new PluginKey<SuggestState | null>("dem-suggest");

/** What is being typed at the caret, if it opens a list. */
export function detect(state: EditorState): SuggestState | null {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.spec.code) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const link = /\[\[([^\]\n￼]*)$/.exec(before);
  if (link) {
    return {
      kind: "link",
      query: link[1] ?? "",
      from: $from.pos - link[0].length,
      to: $from.pos,
    };
  }
  // A slash opens the menu only at the start of a block: elsewhere it is just a slash.
  const slash = /^\/([^\s/]*)$/.exec(before);
  if (slash) {
    return {
      kind: "slash",
      query: slash[1] ?? "",
      from: $from.pos - slash[0].length,
      to: $from.pos,
    };
  }
  return null;
}

export interface SuggestHandler {
  /** The list to show, or null to hide it; `at` is where the caret is on screen. */
  onChange: (s: SuggestState | null, at: { x: number; y: number } | null) => void;
  /** Arrow keys, Enter and Esc while the list is open. Returns whether it used the key. */
  onKey: (key: string) => boolean;
}

export function suggestPlugin(handler: () => SuggestHandler) {
  return new Plugin<SuggestState | null>({
    key,
    state: {
      init: () => null,
      apply: (_tr, _old, _oldState, state) => detect(state),
    },
    props: {
      handleKeyDown(view, e) {
        if (!key.getState(view.state)) return false;
        if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) return false;
        if (e.isComposing) return false;
        return handler().onKey(e.key);
      },
    },
    view() {
      let last: SuggestState | null = null;
      return {
        update(view: EditorView) {
          const s = key.getState(view.state) ?? null;
          if (s?.query === last?.query && s?.kind === last?.kind && s?.from === last?.from) return;
          last = s;
          const c = s ? view.coordsAtPos(s.to) : null;
          handler().onChange(s, c ? { x: c.left, y: c.bottom } : null);
        },
        destroy() {
          handler().onChange(null, null);
        },
      };
    },
  });
}
