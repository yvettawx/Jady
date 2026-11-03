// The body's structure (format spec §6.2: names and attributes here are part of the format, and
// crates/dem-store/src/markdown.rs writes the same ones). schema.json records this for tools;
// `src/editor/pm/schema.test.ts` keeps the two in step. Changing a name needs a format version.
import { Schema, type DOMOutputSpec } from "prosemirror-model";

const hole = 0;

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: (): DOMOutputSpec => ["p", hole],
    },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { level: { default: 1, validate: "number" } },
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (n): DOMOutputSpec => [`h${String(n.attrs.level)}`, hole],
    },
    blockquote: {
      group: "block",
      content: "block+",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: (): DOMOutputSpec => ["blockquote", hole],
    },
    code_block: {
      group: "block",
      content: "text*",
      marks: "",
      code: true,
      defining: true,
      attrs: { language: { default: "" } },
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: (): DOMOutputSpec => ["pre", ["code", hole]],
    },
    horizontal_rule: {
      group: "block",
      parseDOM: [{ tag: "hr" }],
      toDOM: (): DOMOutputSpec => ["hr"],
    },
    bullet_list: {
      group: "block",
      content: "list_item+",
      parseDOM: [{ tag: "ul:not(.dem-tasks)" }],
      toDOM: (): DOMOutputSpec => ["ul", hole],
    },
    ordered_list: {
      group: "block",
      content: "list_item+",
      attrs: { order: { default: 1, validate: "number" } },
      parseDOM: [{ tag: "ol" }],
      toDOM: (): DOMOutputSpec => ["ol", hole],
    },
    list_item: {
      content: "paragraph block*",
      defining: true,
      parseDOM: [{ tag: "ul:not(.dem-tasks) > li, ol > li" }],
      toDOM: (): DOMOutputSpec => ["li", hole],
    },
    task_list: {
      group: "block",
      content: "task_item+",
      parseDOM: [{ tag: "ul.dem-tasks" }],
      toDOM: (): DOMOutputSpec => ["ul", { class: "dem-tasks" }, hole],
    },
    task_item: {
      content: "paragraph block*",
      defining: true,
      attrs: { checked: { default: false, validate: "boolean" } },
      parseDOM: [
        {
          tag: "ul.dem-tasks > li",
          getAttrs: (el: HTMLElement) => ({ checked: el.dataset.checked === "true" }),
        },
      ],
      toDOM: (n): DOMOutputSpec => ["li", { "data-checked": String(n.attrs.checked) }, hole],
    },
    image: {
      group: "block",
      atom: true,
      attrs: { src: { default: "" }, alt: { default: "" } },
      parseDOM: [],
      toDOM: (n): DOMOutputSpec => ["figure", { "data-blob": String(n.attrs.src) }],
    },
    text: { group: "inline" },
    hard_break: {
      group: "inline",
      inline: true,
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: (): DOMOutputSpec => ["br"],
    },
    item_link: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { target: { default: "" }, label: { default: "" } },
      parseDOM: [
        {
          tag: "a[data-item]",
          getAttrs: (el: HTMLElement) => ({
            target: el.dataset.item ?? "",
            label: el.textContent ?? "",
          }),
        },
      ],
      toDOM: (n): DOMOutputSpec => [
        "a",
        { "data-item": String(n.attrs.target), class: "dem-wikilink" },
        String(n.attrs.label),
      ],
    },
  },
  marks: {
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
      toDOM: (): DOMOutputSpec => ["strong", hole],
    },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: (): DOMOutputSpec => ["em", hole] },
    underline: { parseDOM: [{ tag: "u" }], toDOM: (): DOMOutputSpec => ["u", hole] },
    strike: {
      parseDOM: [{ tag: "s" }, { tag: "del" }],
      toDOM: (): DOMOutputSpec => ["s", hole],
    },
    code: { parseDOM: [{ tag: "code" }], toDOM: (): DOMOutputSpec => ["code", hole] },
    highlight: { parseDOM: [{ tag: "mark" }], toDOM: (): DOMOutputSpec => ["mark", hole] },
    link: {
      inclusive: false,
      attrs: { href: { default: "" } },
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (el: HTMLElement) => ({ href: el.getAttribute("href") ?? "" }),
        },
      ],
      toDOM: (m): DOMOutputSpec => ["a", { href: String(m.attrs.href), rel: "noreferrer" }, hole],
    },
  },
});
