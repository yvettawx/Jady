// What the format bar, the selection bar and the / menu do to the document.
import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import type { NodeType } from "prosemirror-model";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import type { Command, EditorState } from "prosemirror-state";
import type { FormatCommand } from "../NoteSheet";
import { schema } from "./schema";

const { nodes, marks } = schema;

function inNode(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
  return false;
}

/** Into a list, or out of it when already there. */
const toggleList =
  (list: NodeType, item: NodeType): Command =>
  (state, dispatch, view) =>
    inNode(state, list)
      ? liftListItem(item)(state, dispatch, view)
      : wrapInList(list)(state, dispatch, view);

const toggleHeading =
  (level: number): Command =>
  (state, dispatch) => {
    const on = state.selection.$from.parent.type === nodes.heading;
    const same = on && state.selection.$from.parent.attrs.level === level;
    return same
      ? setBlockType(nodes.paragraph)(state, dispatch)
      : setBlockType(nodes.heading, { level })(state, dispatch);
  };

const toggleQuote: Command = (state, dispatch) =>
  inNode(state, nodes.blockquote)
    ? lift(state, dispatch)
    : wrapIn(nodes.blockquote)(state, dispatch);

const toggleCodeBlock: Command = (state, dispatch) =>
  state.selection.$from.parent.type === nodes.code_block
    ? setBlockType(nodes.paragraph)(state, dispatch)
    : setBlockType(nodes.code_block)(state, dispatch);

export const FORMATS: Record<Exclude<FormatCommand, "link">, Command> = {
  bold: toggleMark(marks.strong),
  italic: toggleMark(marks.em),
  underline: toggleMark(marks.underline),
  highlight: toggleMark(marks.highlight),
  heading: toggleHeading(2),
  bullets: toggleList(nodes.bullet_list, nodes.list_item),
  numbers: toggleList(nodes.ordered_list, nodes.list_item),
  tasks: toggleList(nodes.task_list, nodes.task_item),
  quote: toggleQuote,
  code: toggleCodeBlock,
};

export { toggleHeading };

/** Sets or clears the web link on the selection. */
export const setLink =
  (href: string | null): Command =>
  (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (dispatch) {
      const tr = state.tr.removeMark(from, to, marks.link);
      if (href) tr.addMark(from, to, marks.link.create({ href }));
      dispatch(tr);
    }
    return true;
  };

/** Replaces the current empty paragraph with a code block in this language. */
export const insertCode =
  (language: string): Command =>
  (state, dispatch) =>
    setBlockType(nodes.code_block, { language })(state, dispatch);

export const insertRule: Command = (state, dispatch) => {
  if (dispatch) {
    const para = nodes.paragraph.create();
    dispatch(
      state.tr
        .replaceSelectionWith(nodes.horizontal_rule.create())
        .insert(state.selection.to + 1, para),
    );
  }
  return true;
};
