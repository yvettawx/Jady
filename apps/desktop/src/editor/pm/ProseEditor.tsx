/* eslint-disable react-refresh/only-export-components -- refreshEditors belongs with the replicas it reaches */
// The real editor (M11): ProseMirror on its own Loro replica of the item (format spec §6.4). It
// loads the bytes from the core and sends back what changed, a pause in typing at a time; the core
// writes them. Undo here undoes only what was typed here.
import { LoroDoc, type ContainerID } from "loro-crdt";
import { LoroSyncPlugin, LoroUndoPlugin, redo, undo } from "loro-prosemirror";
import { baseKeymap, chainCommands, exitCode } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { api, itemsChanged } from "../../app/api";
import { useT } from "../../i18n/context";
import { I18nProvider } from "../../i18n/I18nProvider";
import { useAppearance } from "../../settings/appearance";
import { currentMode } from "../../theme/mode.ts";
import { themeFor } from "../blocks/MermaidBlock";
import { showToast } from "../../ui/toast";
import type { FormatCommand, SheetMode } from "../NoteSheet";
import { WikiLink, type LinkTarget, type OpenHow } from "../WikiLink";
import { FORMATS, insertCode, insertRule, setLink, toggleHeading } from "./commands";
import { schema } from "./schema";
import { blockDragPlugin } from "./blockDrag";
import { suggestPlugin, type SuggestHandler, type SuggestState } from "./suggest";
import { codeBlockView, imageView, taskItemView, type BlockHost } from "./views";
import "../blocks/blocks.css";
import "./editor.css";

const b64 = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  decode(text: string): Uint8Array {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

/** Open replicas in this window: the same note in two tabs stays the same as you type. */
const openDocs = new Map<string, Set<LoroDoc>>();

/** After the core changed a body by itself (a restored version), open editors catch up. */
export async function refreshEditors(itemId: string): Promise<void> {
  const docs = openDocs.get(itemId);
  if (!docs?.size) return;
  const bytes = b64.decode(await api.bodyOpen(itemId));
  docs.forEach((d) => d.import(bytes));
}

/** A pause in typing longer than this saves (M2: one update file per pause). */
const SAVE_AFTER = 800;

const blobUrls = new Map<string, Promise<string>>();
function blobUrl(name: string): Promise<string> {
  let url = blobUrls.get(name);
  if (!url) {
    url = api
      .blobGet(name)
      .then((data) => URL.createObjectURL(new Blob([b64.decode(data).slice()])));
    blobUrls.set(name, url);
  }
  return url;
}

type Mermaid = typeof import("mermaid").default;
let mermaidLoading: Promise<Mermaid> | null = null;
let diagramSeq = 0;
function drawDiagram(source: string, el: HTMLElement) {
  mermaidLoading ??= import("mermaid").then((m) => m.default);
  void mermaidLoading.then(async (mermaid) => {
    const id = `dem-diagram-${++diagramSeq}`;
    // Same look as the block on review pages: the theme's colours, nothing can run inside it.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: themeFor(currentMode()),
      flowchart: { curve: "basis", htmlLabels: false },
    });
    try {
      const { svg } = await mermaid.render(id, source);
      el.innerHTML = svg;
    } catch {
      el.textContent = "";
    }
    document.getElementById(`d${id}`)?.remove();
  });
}

const HOST: BlockHost = { blobUrl, drawDiagram };

const rules = inputRules({
  rules: [
    textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading, (m) => ({ level: m[1]?.length })),
    wrappingInputRule(/^\s*([-*])\s$/, schema.nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, (m) => ({ order: Number(m[1]) })),
    wrappingInputRule(/^\s*\[( |x)\]\s$/, schema.nodes.task_list),
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    textblockTypeInputRule(/^```(\w*)\s$/, schema.nodes.code_block, (m) => ({
      language: m[1] ?? "",
    })),
    new InputRule(/^---$/, (state, _m, start, end) =>
      state.tr.replaceRangeWith(start - 1, end, schema.nodes.horizontal_rule.create()),
    ),
  ],
});

export interface ProseEditorHandle {
  format(cmd: Exclude<FormatCommand, "link">): void;
  /** Sets or clears the web link on the selection. */
  link(href: string | null): void;
  focus(): void;
  /** Sends what has not been saved yet. */
  flush(): Promise<void>;
  goTo(pos: number): void;
  insert(text: string): void;
  selectedText(): string;
}

export interface EditorStatus {
  words?: number;
  saving?: boolean;
  headings?: { level: number; text: string; pos: number }[];
}

const countWords = (doc: PMNode) => doc.textContent.replace(/\s/g, "").length;

function headingsOf(doc: PMNode): NonNullable<EditorStatus["headings"]> {
  const out: NonNullable<EditorStatus["headings"]> = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.heading)
      out.push({ level: Number(node.attrs.level), text: node.textContent, pos });
    return node.type !== schema.nodes.heading && node.isBlock && !node.isTextblock;
  });
  return out;
}

/** Everything a link in the text needs to know. */
export interface LinkHost {
  resolve: (target: string) => LinkTarget | null;
  open: (target: string, how: OpenHow) => void;
  /** Items to offer after `[[`. */
  suggest: (query: string) => { id: string; title: string }[];
  create: (title: string) => Promise<string>;
  /** A web link was clicked: it opens in the browser, never in this window. */
  external: (href: string) => void;
}

interface SlashItem {
  id: string;
  label: string;
  run: (view: EditorView, s: SuggestState) => void;
}

function clearRange(view: EditorView, s: SuggestState) {
  view.dispatch(view.state.tr.delete(s.from, s.to));
}

function slashItems(t: (k: string) => string): SlashItem[] {
  const withCommand =
    (c: (st: EditorState, d?: EditorView["dispatch"]) => boolean) =>
    (view: EditorView, s: SuggestState) => {
      clearRange(view, s);
      c(view.state, view.dispatch);
    };
  return [
    { id: "h1", label: t("slash.h1"), run: withCommand(toggleHeading(1)) },
    { id: "h2", label: t("slash.h2"), run: withCommand(toggleHeading(2)) },
    { id: "h3", label: t("slash.h3"), run: withCommand(toggleHeading(3)) },
    { id: "bullets", label: t("slash.bullets"), run: withCommand(FORMATS.bullets) },
    { id: "numbers", label: t("slash.numbers"), run: withCommand(FORMATS.numbers) },
    { id: "tasks", label: t("slash.tasks"), run: withCommand(FORMATS.tasks) },
    { id: "quote", label: t("slash.quote"), run: withCommand(FORMATS.quote) },
    { id: "code", label: t("slash.code"), run: withCommand(insertCode("")) },
    { id: "mermaid", label: t("slash.mermaid"), run: withCommand(insertCode("mermaid")) },
    { id: "svg", label: t("slash.svg"), run: withCommand(insertCode("svg")) },
    {
      id: "interlinear",
      label: t("slash.interlinear"),
      run: withCommand(insertCode("interlinear")),
    },
    { id: "rule", label: t("slash.rule"), run: withCommand(insertRule) },
  ];
}

export function ProseEditor({
  itemId,
  mode,
  links,
  onEdited,
  onStatus,
  onRoot,
  onReady,
  ref,
}: {
  itemId: string;
  mode: SheetMode;
  links: LinkHost;
  /** Something was typed: a preview tab becomes a kept one. */
  onEdited?: () => void;
  onStatus?: (s: EditorStatus) => void;
  /** The element holding the text, for what floats over a selection. */
  onRoot?: (el: HTMLElement | null) => void;
  onReady?: (handle: {
    flush: () => Promise<void>;
    goTo: (pos: number) => void;
    insert: (text: string) => void;
  }) => void;
  ref?: Ref<ProseEditorHandle>;
}) {
  const t = useT();
  const { locale } = useAppearance();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [pmView, setPmView] = useState<EditorView | null>(null);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
    viewRef.current?.setProps({});
  }, [mode]);
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const [failed, setFailed] = useState(false);
  const [suggest, setSuggest] = useState<{
    state: SuggestState;
    at: { x: number; y: number };
    index: number;
  } | null>(null);
  const latest = useRef({ links, onEdited, onStatus, onRoot, onReady, t, locale });
  useEffect(() => {
    latest.current = { links, onEdited, onStatus, onRoot, onReady, t, locale };
  });

  const options = (s: SuggestState | null): { id: string; label: string; run: () => void }[] => {
    const view = pmView;
    if (!s || !view) return [];
    if (s.kind === "slash") {
      const q = s.query.toLowerCase();
      return slashItems(t)
        .filter((i) => !q || i.id.includes(q) || i.label.includes(s.query))
        .map((i) => ({ id: i.id, label: i.label, run: () => i.run(view, s) }));
    }
    const insert = (id: string, label: string) => {
      const node = schema.nodes.item_link.create({ target: id, label });
      view.dispatch(view.state.tr.replaceWith(s.from, s.to, node).insertText(" "));
      view.focus();
    };
    const found = links
      .suggest(s.query)
      .slice(0, 8)
      .map((i) => ({ id: i.id, label: i.title, run: () => insert(i.id, i.title) }));
    const q = s.query.trim();
    if (q && !found.some((f) => f.label === q)) {
      found.push({
        id: "new",
        label: t("slash.newLink").replace("{title}", q),
        run: () => {
          void links.create(q).then((id) => insert(id, q));
        },
      });
    }
    return found;
  };
  const suggestRef = useRef(suggest);
  useEffect(() => {
    suggestRef.current = suggest;
  });
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const handler = useRef<SuggestHandler>({
    onChange: (state, at) => setSuggest(state && at ? { state, at, index: 0 } : null),
    onKey: (key) => {
      const cur = suggestRef.current;
      if (!cur) return false;
      if (key === "Escape") {
        setSuggest(null);
        return true;
      }
      const list = optionsRef.current(cur.state);
      if (!list.length) return false;
      if (key === "ArrowDown" || key === "ArrowUp") {
        const step = key === "ArrowDown" ? 1 : -1;
        setSuggest({ ...cur, index: (cur.index + step + list.length) % list.length });
        return true;
      }
      list[cur.index]?.run();
      setSuggest(null);
      return true;
    },
  });

  useEffect(() => {
    let alive = true;
    let view: EditorView | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let doc: LoroDoc | null = null;
    const linkRoots = new Set<Root>();
    let saved: ReturnType<LoroDoc["oplogVersion"]> | null = null;
    let sending: Promise<unknown> = Promise.resolve();
    let offLocal: (() => void) | undefined;

    const flush = async () => {
      clearTimeout(timer);
      if (!doc || !saved) return;
      doc.commit();
      const now = doc.oplogVersion();
      if (now.compare(saved) === 0) return sending.then(() => undefined);
      const bytes = doc.export({ mode: "update", from: saved });
      saved = now;
      for (const peer of openDocs.get(itemId) ?? []) if (peer !== doc) peer.import(bytes);
      const send = () => api.bodyApply(itemId, b64.encode(bytes));
      sending = sending.then(send, send).then(
        () => {
          itemsChanged();
          latest.current.onStatus?.({ saving: false });
        },
        () => showToast({ text: t("editor.saveFailed"), tone: "danger" }),
      );
      await sending;
    };
    flushRef.current = flush;

    void api.bodyOpen(itemId).then(
      (data) => {
        if (!alive || !host.current) return;
        doc = new LoroDoc();
        doc.setRecordTimestamp(true);
        doc.import(b64.decode(data));
        saved = doc.oplogVersion();
        const sharing = openDocs.get(itemId) ?? new Set<LoroDoc>();
        sharing.add(doc);
        openDocs.set(itemId, sharing);
        // Only what is typed here counts as a change: opening a note saves nothing.
        offLocal = doc.subscribeLocalUpdates(() => {
          latest.current.onEdited?.();
          latest.current.onStatus?.({ saving: true });
          clearTimeout(timer);
          timer = setTimeout(() => void flush(), SAVE_AFTER);
        });
        const containerId = doc.getMap("body").id as ContainerID;
        const state = EditorState.create({
          schema,
          plugins: [
            LoroSyncPlugin({ doc: doc as never, containerId }),
            LoroUndoPlugin({ doc: doc as never }),
            rules,
            suggestPlugin(() => handler.current),
            blockDragPlugin(() => latest.current.t("editor.dragBlock")),
            keymap({
              "Mod-z": undo,
              "Mod-y": redo,
              "Mod-Shift-z": redo,
              "Mod-b": FORMATS.bold,
              "Mod-i": FORMATS.italic,
              "Mod-u": FORMATS.underline,
              "Mod-Alt-1": toggleHeading(1),
              "Mod-Alt-2": toggleHeading(2),
              "Mod-Alt-3": toggleHeading(3),
              Enter: chainCommands(
                splitListItem(schema.nodes.list_item),
                splitListItem(schema.nodes.task_item),
              ),
              "Mod-Enter": exitCode,
              Tab: chainCommands(
                sinkListItem(schema.nodes.list_item),
                sinkListItem(schema.nodes.task_item),
              ),
              "Shift-Tab": chainCommands(
                liftListItem(schema.nodes.list_item),
                liftListItem(schema.nodes.task_item),
              ),
            }),
            keymap(baseKeymap),
            dropCursor(),
            gapCursor(),
          ],
        });
        view = new EditorView(host.current, {
          state,
          editable: () => modeRef.current === "edit",
          attributes: {
            class: "dem-prose dem-pm",
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": t("editor.body"),
            spellcheck: "false",
          },
          nodeViews: {
            image: (node) => imageView(node, HOST),
            task_item: (node, v, getPos) => taskItemView(node, v, getPos),
            code_block: (node) => codeBlockView(node, HOST),
            item_link: (node: PMNode) => {
              const dom = document.createElement("span");
              dom.className = "dem-pm-link";
              const root = createRoot(dom);
              linkRoots.add(root);
              const draw = (n: PMNode) =>
                root.render(
                  <I18nProvider locale={latest.current.locale}>
                    <WikiLink
                      target={String(n.attrs.target)}
                      resolve={(id) =>
                        latest.current.links.resolve(id) ?? {
                          title: String(n.attrs.label),
                          body: "",
                        }
                      }
                      onOpen={(id, how) => latest.current.links.open(id, how)}
                      onCreate={() => undefined}
                      peekEditable={false}
                    />
                  </I18nProvider>,
                );
              draw(node);
              return {
                dom,
                update(next: PMNode) {
                  if (next.type !== node.type) return false;
                  draw(next);
                  return true;
                },
                stopEvent: () => true,
                ignoreMutation: () => true,
                destroy() {
                  linkRoots.delete(root);
                  setTimeout(() => root.unmount());
                },
              };
            },
          },
          dispatchTransaction(tr) {
            if (!view) return;
            view.updateState(view.state.apply(tr));
            if (tr.docChanged) {
              const d = view.state.doc;
              latest.current.onStatus?.({ words: countWords(d), headings: headingsOf(d) });
            }
          },
          handleClickOn(_v, _pos, _node, _nodePos, e) {
            const a = (e.target as HTMLElement).closest("a[href]");
            const href = a?.getAttribute("href");
            if (!href || a?.classList.contains("dem-wikilink")) return false;
            // In the text a plain click edits; in reading mode, or with ⌘, it follows the link.
            if (modeRef.current === "edit" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              return false;
            }
            e.preventDefault();
            latest.current.links.external(href);
            return true;
          },
          handlePaste(v, e) {
            const files = [...(e.clipboardData?.files ?? [])].filter((f) =>
              f.type.startsWith("image/"),
            );
            if (!files.length) return false;
            void addImages(v, files);
            return true;
          },
          handleDrop(v, e) {
            const dt = (e as DragEvent).dataTransfer;
            const files = [...(dt?.files ?? [])].filter((f) => f.type.startsWith("image/"));
            if (!files.length) return false;
            void addImages(v, files);
            return true;
          },
        });
        viewRef.current = view;
        setPmView(view);
        latest.current.onRoot?.(host.current);
        latest.current.onReady?.({
          flush,
          insert(text) {
            const v = viewRef.current;
            if (!v) return;
            v.dispatch(v.state.tr.insertText(text));
            v.focus();
          },
          goTo(pos) {
            const v = viewRef.current;
            if (!v) return;
            v.focus();
            v.dispatch(
              v.state.tr
                .setSelection(TextSelection.near(v.state.doc.resolve(pos + 1)))
                .scrollIntoView(),
            );
          },
        });
        // The binding fills the document just after the view is made.
        setTimeout(() => {
          const d = viewRef.current?.state.doc;
          if (d) latest.current.onStatus?.({ words: countWords(d), headings: headingsOf(d) });
        }, 50);
      },
      () => {
        if (alive) setFailed(true);
      },
    );

    return () => {
      alive = false;
      void flush();
      offLocal?.();
      if (doc) openDocs.get(itemId)?.delete(doc);
      latest.current.onRoot?.(null);
      view?.destroy();
      viewRef.current = null;
    };
    // The editor is built once per item; `t` only names things.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  useImperativeHandle(
    ref,
    () => ({
      insert(text) {
        const v = viewRef.current;
        if (!v) return;
        v.dispatch(v.state.tr.insertText(text));
      },
      format(cmd) {
        const view = viewRef.current;
        if (!view) return;
        FORMATS[cmd](view.state, view.dispatch, view);
        view.focus();
      },
      link(href) {
        const view = viewRef.current;
        if (!view) return;
        setLink(href)(view.state, view.dispatch);
        view.focus();
      },
      goTo(pos) {
        const v = viewRef.current;
        if (!v) return;
        v.focus();
        v.dispatch(
          v.state.tr
            .setSelection(TextSelection.near(v.state.doc.resolve(pos + 1)))
            .scrollIntoView(),
        );
      },
      focus() {
        const view = viewRef.current;
        if (!view) return;
        view.focus();
        view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
      },
      flush: () => flushRef.current(),
      selectedText() {
        const v = viewRef.current;
        if (!v) return "";
        const { from, to } = v.state.selection;
        return v.state.doc.textBetween(from, to, "\n");
      },
    }),
    [],
  );

  const list = options(suggest?.state ?? null);
  let popup: ReactNode = null;
  if (suggest && list.length) {
    popup = createPortal(
      <ul
        className="dem-popover dem-suggest"
        role="listbox"
        aria-label={t(suggest.state.kind === "slash" ? "slash.title" : "slash.linkTitle")}
        style={{ left: suggest.at.x, top: suggest.at.y + 4 }}
      >
        {list.map((o, i) => (
          <li
            key={o.id}
            role="option"
            aria-selected={i === suggest.index}
            onMouseDown={(e) => {
              e.preventDefault();
              o.run();
              setSuggest(null);
            }}
          >
            {o.label}
          </li>
        ))}
      </ul>,
      document.body,
    );
  }
  if (failed) return <p className="dem-pm-failed">{t("editor.openFailed")}</p>;
  return (
    <>
      <div ref={host} className="dem-pm-host" />
      {popup}
    </>
  );
}

async function addImages(view: EditorView, files: File[]) {
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = await api.blobPut(b64.encode(bytes));
    const node = schema.nodes.image.create({ src: name, alt: file.name });
    view.dispatch(view.state.tr.replaceSelectionWith(node));
  }
}
