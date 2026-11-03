// How the blocks that are more than text look: images read from the encrypted store, task items
// with a real checkbox, code with its language and Mermaid drawn underneath.
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

export interface BlockHost {
  /** Resolves an attachment name to something an <img> can show. */
  blobUrl: (name: string) => Promise<string>;
  /** Draws a diagram into `el`; `null` clears it. */
  drawDiagram: (source: string, el: HTMLElement) => void;
}

export function imageView(node: PMNode, host: BlockHost): NodeView {
  const dom = document.createElement("figure");
  dom.className = "dem-image";
  const img = document.createElement("img");
  img.alt = String(node.attrs.alt ?? "");
  dom.append(img);
  void host.blobUrl(String(node.attrs.src)).then(
    (url) => {
      img.src = url;
    },
    () => {
      dom.dataset.missing = "true";
    },
  );
  return { dom };
}

export function taskItemView(
  initial: PMNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  let node = initial;
  const dom = document.createElement("li");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.contentEditable = "false";
  const content = document.createElement("div");
  dom.append(box, content);
  const sync = () => {
    box.checked = node.attrs.checked === true;
    dom.dataset.checked = String(node.attrs.checked === true);
  };
  sync();
  box.addEventListener("mousedown", (e) => e.preventDefault());
  box.addEventListener("click", (e) => {
    e.preventDefault();
    const pos = getPos();
    if (pos === undefined || !view.editable) return;
    view.dispatch(view.state.tr.setNodeAttribute(pos, "checked", !(node.attrs.checked === true)));
  });
  return {
    dom,
    contentDOM: content,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      sync();
      return true;
    },
    ignoreMutation: (m) => m.target === box || (m.type === "attributes" && m.target === dom),
  };
}

/**
 * 对照文本 (A6): lines of `原文|转写|注释`, words separated by spaces, with a line starting `=` for
 * the translation. Kept as a code block, so the text stays plain and the format is unchanged.
 */
export function renderInterlinear(source: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "dem-pm-inter";
  for (const raw of source.split("\n")) {
    const text = raw.trim();
    if (!text) continue;
    if (text.startsWith("=")) {
      const p = document.createElement("p");
      p.className = "dem-pm-inter-tr";
      p.textContent = text.slice(1).trim();
      root.append(p);
      continue;
    }
    const line = document.createElement("div");
    line.className = "dem-pm-inter-line";
    root.append(line);
    for (const word of text.split(/\s+/)) {
      const [orig = "", translit = "", gloss = ""] = word.split("|");
      const stack = document.createElement("span");
      stack.className = "dem-pm-inter-word";
      for (const [cls, t] of [
        ["o", orig],
        ["t", translit],
        ["g", gloss],
      ] as const) {
        const s = document.createElement("span");
        s.dataset.layer = cls;
        s.textContent = t;
        stack.append(s);
      }
      line.append(stack);
    }
  }
  return root;
}

/** As an image, so nothing inside it can run or reach the page. */
function drawSvg(source: string, el: HTMLElement) {
  const img = document.createElement("img");
  img.alt = "";
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  img.onerror = () => el.replaceChildren();
  img.onload = () => el.replaceChildren(img);
}

export function codeBlockView(initial: PMNode, host: BlockHost): NodeView {
  let node = initial;
  const dom = document.createElement("figure");
  dom.className = "dem-block dem-pm-code";
  const head = document.createElement("figcaption");
  head.className = "dem-block-head";
  head.contentEditable = "false";
  const kind = document.createElement("span");
  kind.className = "dem-block-kind";
  head.append(kind);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  pre.append(code);
  const drawing = document.createElement("div");
  drawing.className = "dem-pm-diagram";
  drawing.contentEditable = "false";
  dom.append(head, pre, drawing);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sync = () => {
    const language = String(node.attrs.language ?? "");
    kind.textContent = language;
    head.hidden = !language;
    dom.dataset.language = language;
    clearTimeout(timer);
    if (language === "mermaid") {
      timer = setTimeout(() => host.drawDiagram(node.textContent, drawing), 300);
    } else if (language === "interlinear") {
      drawing.replaceChildren(renderInterlinear(node.textContent));
    } else if (language === "svg") {
      timer = setTimeout(() => drawSvg(node.textContent, drawing), 300);
    } else {
      drawing.replaceChildren();
    }
  };
  sync();
  return {
    dom,
    contentDOM: code,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      sync();
      return true;
    },
    ignoreMutation: (m) => !code.contains(m.target),
    destroy() {
      clearTimeout(timer);
    },
  };
}
