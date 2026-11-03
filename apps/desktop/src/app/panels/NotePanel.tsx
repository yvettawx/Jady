// An item as a page: format bar, number and kind, the title, its fields, the text. Everything goes
// through the core; the text through the editor's own replica.
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FieldDef, ItemView, TypeDef } from "../../bindings";
import { NoteSheet, type FormatCommand, type SheetMode } from "../../editor/NoteSheet";
import {
  ProseEditor,
  refreshEditors,
  type LinkHost,
  type ProseEditorHandle,
} from "../../editor/pm/ProseEditor";
import { SelectionBar } from "../../editor/SelectionBar";
import { TextMenu, type TextAction } from "../../editor/TextMenu";
import { useT } from "../../i18n/context";
import { SourceButton } from "../../ai/SourceMarks";
import type { SourceInfo } from "../../ai/source";
import { useAiGate } from "../../privacy/AiGate";
import { PrivacyPicker } from "../../privacy/PrivacyPicker";
import { SecretGate } from "../../privacy/SecretGate";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { MenuButton } from "../../ui/Menu";
import { Select } from "../../ui/Select";
import { Spinner } from "../../ui/States";
import { Switch } from "../../ui/Switch";
import { Tags } from "../../ui/Tags";
import { showToast } from "../../ui/toast";
import { TextField } from "../../ui/TextField";
import type { PanelProps } from "../../workspace/registry";
import { failed, newItem, openById, openItem, trashItem, VERSIONS_PANEL } from "../actions";
import { closeNote, publishNote, type Heading } from "../active";
import { api, itemsChanged, parseFields } from "../api";
import { toggleFavorite, useFavorites } from "../favorites";
import { SpanRows } from "../life/Calendar";
import { useLive } from "../live";
import { coreLevel, dateToMs, iconOf, isoDate, levelOf, patch, titleOf, typeName } from "../model";
import { useLibrary, library } from "../store";
import { matchItems } from "./NavPanel";
import { askInWindow } from "./AiPanels";
import { DERIVE_PANEL, ProjectLearn, RECITE_PANEL } from "./LearnPanels";
import { regenerate } from "./ProfileView";
import { ProjectExtras } from "./ProjectExtras";

const NOT_NUMBER = /[^\d]/g;
/** The archive number before the title: taken from the item's id, stable and short. */
const archiveNumber = (id: string) =>
  String(parseInt(id.replace(NOT_NUMBER, "").slice(-6) || "0", 10) % 10000).padStart(4, "0");

/** WebKit draws today's date in an empty date field; this shows that nothing is set. */
function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useT();
  return (
    <span className="dem-fields-date" data-empty={value ? undefined : t("item.noValue")}>
      <input
        type="date"
        className="dem-fields-input"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}

/** A link field offers the kind of item it stands for. */
function LinkInput({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  const { items } = useLibrary();
  const kinds: Record<string, string> = { advances: "key_result", objective: "objective" };
  const options = items
    .filter((i) => i.privacy !== "confidential" && (!kinds[name] || i.typeId === kinds[name]))
    .slice(0, 200);
  return (
    <Select
      aria-label={label}
      options={[
        { id: "", label: t("item.noValue") },
        ...options.map((i) => ({ id: i.id, label: titleOf(t, i) })),
      ]}
      selectedKey={value}
      onSelectionChange={(k) => onChange(k ? String(k) : null)}
    />
  );
}

function FieldInput({
  def,
  field,
  value,
  onChange,
}: {
  def: TypeDef;
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  const label = def.builtin ? t(field.name) : field.name;
  const text = value == null ? "" : String(value);
  switch (field.kind.type) {
    case "checkbox":
      return (
        <Switch aria-label={label} isSelected={value === true} onChange={(v) => onChange(v)}>
          {null}
        </Switch>
      );
    case "select":
      return (
        <Select
          aria-label={label}
          options={[
            { id: "", label: t("item.noValue") },
            ...field.kind.options.map((o) => ({
              id: o.id,
              label: def.builtin ? t(o.name) : o.name,
            })),
          ]}
          selectedKey={text}
          onSelectionChange={(k) => onChange(k ? String(k) : null)}
        />
      );
    case "multi_select": {
      const on = Array.isArray(value) ? value.map(String) : [];
      const options = field.kind.options;
      return (
        <span className="dem-fields-multi">
          {options.map((o) => (
            <label key={o.id}>
              <input
                type="checkbox"
                checked={on.includes(o.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...on, o.id] : on.filter((x) => x !== o.id))
                }
              />
              {def.builtin ? t(o.name) : o.name}
            </label>
          ))}
        </span>
      );
    }
    case "date":
      return <DateInput label={label} value={text} onChange={(v) => onChange(v || null)} />;
    case "link":
      return <LinkInput label={label} name={field.key} value={text} onChange={onChange} />;
    case "number":
    case "rating":
      return (
        <input
          type="number"
          className="dem-fields-input"
          aria-label={label}
          min={field.kind.type === "rating" ? 0 : undefined}
          max={field.kind.type === "rating" ? field.kind.max : undefined}
          value={text}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    default:
      return (
        <input
          type={field.kind.type === "url" ? "url" : "text"}
          className="dem-fields-input"
          aria-label={label}
          defaultValue={text}
          key={text}
          onBlur={(e) => e.target.value !== text && onChange(e.target.value || null)}
        />
      );
  }
}

function FieldsForm({
  item,
  def,
  onChange,
}: {
  item: ItemView;
  def: TypeDef | undefined;
  onChange: (p: Parameters<typeof api.itemUpdate>[1]) => void;
}) {
  const t = useT();
  const fields = useMemo(() => parseFields(item.fields), [item.fields]);
  const [tag, setTag] = useState("");
  return (
    <dl className="dem-fields">
      {def?.fields.map((f) => (
        <div key={f.key} className="dem-fields-row">
          <dt>{def.builtin ? t(f.name) : f.name}</dt>
          <dd>
            <FieldInput
              def={def}
              field={f}
              value={fields[f.key]}
              onChange={(v) => onChange(patch({ fields: JSON.stringify({ [f.key]: v }) }))}
            />
          </dd>
        </div>
      ))}
      <SpanRows item={item} onChange={onChange} />
      {item.typeId !== "todo" && item.due == null && !item.span && (
        <div className="dem-fields-row">
          <dt>{t("item.occurred")}</dt>
          <dd>
            <input
              className="dem-fields-input"
              aria-label={t("item.occurred")}
              placeholder={t("item.occurred.hint")}
              // What the core made of it comes back here.
              key={item.occurred ?? ""}
              defaultValue={item.occurred ?? ""}
              onBlur={(e) => {
                const text = e.target.value.trim();
                if (text !== (item.occurred ?? "")) onChange(patch({ occurred: text || null }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
              }}
            />
          </dd>
        </div>
      )}
      {(item.typeId === "todo" || item.due != null) && (
        <div className="dem-fields-row">
          <dt>{t("item.due")}</dt>
          <dd>
            <DateInput
              label={t("item.due")}
              value={item.due != null ? isoDate(item.due) : ""}
              onChange={(v) => onChange(patch({ due: v ? dateToMs(v) : null }))}
            />
          </dd>
        </div>
      )}
      <div className="dem-fields-row">
        <dt>{t("item.tags")}</dt>
        <dd className="dem-fields-tags">
          {item.tags.length > 0 && (
            <Tags
              aria-label={t("item.tags")}
              items={item.tags.map((x) => ({ id: x, label: x }))}
              onRemove={(ids) => onChange(patch({ tags: item.tags.filter((x) => !ids.has(x)) }))}
            />
          )}
          <input
            className="dem-fields-input"
            aria-label={t("item.addTag")}
            placeholder={t("item.addTag")}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              const name = tag.trim().replace(/^#/, "");
              if (name && !item.tags.includes(name))
                onChange(patch({ tags: [...item.tags, name] }));
              setTag("");
            }}
          />
        </dd>
      </div>
    </dl>
  );
}

function MoveDialog({
  item,
  isOpen,
  onOpenChange,
  onMove,
}: {
  item: ItemView;
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  onMove: (container: string | null) => void;
}) {
  const t = useT();
  const { tree } = useLibrary();
  const [to, setTo] = useState(item.container ?? "");
  return (
    <Dialog title={t("item.move")} isOpen={isOpen} onOpenChange={onOpenChange}>
      <Select
        aria-label={t("item.move")}
        options={[
          { id: "", label: t("item.moveNowhere") },
          ...tree
            .filter((n) => n.id !== item.id)
            .map((n) => ({ id: n.id, label: n.title || t("item.untitled") })),
        ]}
        selectedKey={to}
        onSelectionChange={(k) => setTo(String(k))}
      />
      <div className="dem-dialog-actions">
        <Button
          variant="primary"
          onPress={() => {
            onMove(to || null);
            onOpenChange(false);
          }}
        >
          {t("item.moveHere")}
        </Button>
      </div>
    </Dialog>
  );
}

function LinkDialog({
  isOpen,
  onOpenChange,
  onLink,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  onLink: (href: string | null) => void;
}) {
  const t = useT();
  const [href, setHref] = useState("https://");
  const done = (value: string | null) => {
    onLink(value);
    onOpenChange(false);
  };
  return (
    <Dialog title={t("editor.fmt.link")} isOpen={isOpen} onOpenChange={onOpenChange}>
      <TextField
        aria-label={t("editor.linkPrompt")}
        autoFocus
        value={href}
        onChange={setHref}
        onKeyDown={(e) =>
          e.key === "Enter" && !e.nativeEvent.isComposing && done(href.trim() || null)
        }
      />
      <div className="dem-dialog-actions">
        <Button variant="quiet" onPress={() => done(null)}>
          {t("editor.linkRemove")}
        </Button>
        <Button variant="primary" onPress={() => done(href.trim() || null)}>
          {t("action.ok")}
        </Button>
      </div>
    </Dialog>
  );
}

function NoteBody({
  item,
  tabId,
  workspace,
  promote,
}: {
  item: ItemView;
  tabId: string;
  workspace: PanelProps["workspace"];
  promote: () => void;
}) {
  const t = useT();
  const { types } = useLibrary();
  const def = types.find((x) => x.id === item.typeId);
  const [mode, setMode] = useState<SheetMode>("edit");
  const editor = useRef<ProseEditorHandle>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement | null>(null);
  const [linking, setLinking] = useState(false);
  const [moving, setMoving] = useState(false);
  const [title, setTitle] = useState(item.title ?? "");
  const [titleFocused, setTitleFocused] = useState(false);
  const level = levelOf(item.privacy);

  // What someone else changed shows, unless the user is typing in the title right now.
  const [shownTitle, setShownTitle] = useState(item.title);
  if (shownTitle !== item.title && !titleFocused) {
    setShownTitle(item.title);
    setTitle(item.title ?? "");
  }

  useEffect(() => {
    workspace.retitle(tabId, titleOf(t, item, true));
    workspace.setTabParams(tabId, { privacy: level });
    publishNote(item.id, { title: titleOf(t, item, true), privacy: level, aiWeb: item.aiWeb });
  }, [workspace, tabId, item, level, t]);

  const update = (p: Parameters<typeof api.itemUpdate>[1]) =>
    void api
      .itemUpdate(item.id, p)
      .then(() => itemsChanged())
      .catch(failed(t, titleOf(t, item, true)));

  const saveTitle = () => {
    const next = title.trim();
    if (next !== (item.title ?? "")) update(patch({ title: next || null }));
  };

  const links: LinkHost = {
    resolve: (id) => {
      const it = library().items.find((x) => x.id === id);
      return it ? { title: titleOf(t, it), body: it.preview, privacy: levelOf(it.privacy) } : null;
    },
    open: (id, how) =>
      openById(
        workspace,
        t,
        id,
        how === "split" ? { split: "right", kind: "temp" } : { kind: "temp" },
      ),
    suggest: (q) =>
      matchItems(library().items, q)
        .filter((i) => i.id !== item.id)
        .map((i) => ({ id: i.id, title: i.title ?? "" })),
    create: async (name) => {
      const made = await api.itemCreate(newItem({ typeId: "note", title: name }));
      itemsChanged();
      return made.id;
    },
    external: (href) => void api.openExternal(href).catch(failed(t, href)),
  };

  const format = (cmd: FormatCommand) => {
    if (cmd === "link") setLinking(true);
    else editor.current?.format(cmd);
  };

  const gate = useAiGate(level, item.aiWeb);
  const ask = (first: string | undefined, title: string, quote?: string, context?: string) =>
    gate.request((session) => {
      void askInWindow(
        {
          session,
          mode: "chat",
          title,
          container: item.container,
          quote,
          context,
          tabContent: item.id,
        },
        first,
      ).catch(failed(t, title));
    });
  // The question comes from the user; what they selected goes with it.
  const textAsk = (text: string) =>
    ask(
      undefined,
      t("menu.askAi"),
      text,
      t("ai.prompt.selection", { title: titleOf(t, item), id: item.id, text }),
    );
  const makeCard = (text: string) => {
    if (!text.trim()) return;
    // Made by hand from the text: only remembered, not reviewed, unless turned on (C1).
    void api
      .itemCreate(
        newItem({
          typeId: "card",
          title: text.trim(),
          container: item.container,
          privacy: item.privacy,
          fields: JSON.stringify({ front: text.trim(), back: "", review: false }),
          markdown: `[[${titleOf(t, item)}]]\n`,
        }),
      )
      .then((card) => {
        itemsChanged();
        showToast({ text: t("editor.cardMade") });
        openItem(workspace, t, card, { kind: "preview" });
      })
      .catch(failed(t, t("menu.toCard")));
  };
  const runTask = (task: "sprint" | "questions" | "annotate") => {
    if (task === "annotate") {
      ask(t("ai.prompt.annotate", { title: titleOf(t, item), id: item.id }), t("ai.task.annotate"));
      return;
    }
    void api
      .aiTaskPrompt(task)
      .then((prompt) =>
        ask(
          `${prompt ?? ""}\n\n${t("ai.prompt.lang")}\n\n${t(`ai.prompt.${task}`, { title: titleOf(t, item), id: item.id })}`,
          t(`ai.task.${task}`),
        ),
      )
      .catch(failed(t, t(`ai.task.${task}`)));
  };

  const textAction = (a: TextAction) => {
    if (a === "ask-ai" || a === "translate" || a === "card") {
      const picked = editor.current?.selectedText() ?? "";
      if (a === "card") makeCard(picked);
      else if (a === "ask-ai") textAsk(picked);
      else ask(t("ai.prompt.translate", { text: picked }), t("menu.translate"), picked);
      return;
    }
    if (a === "copy" || a === "cut") document.execCommand(a);
    if (a === "web-search") {
      const q = editor.current?.selectedText().trim();
      if (q)
        void api
          .openExternal(t("editor.webSearchUrl", { q: encodeURIComponent(q) }))
          .catch(failed(t, t("menu.webSearch")));
    }
  };

  const fields = parseFields(item.fields);
  const blob = typeof fields.blob === "string" ? fields.blob : null;
  const saveFile = async () => {
    if (!blob) return;
    const name = typeof fields.filename === "string" ? fields.filename : item.title;
    const path = await save({ defaultPath: name ?? undefined });
    if (path) await api.blobSave(blob, path);
  };
  const favorite = useFavorites().includes(item.id);

  const exportTo = async () => {
    const path = await save({
      defaultPath: `${(item.title || t("item.untitled")).replace(/[/\\:]/g, "-")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (path) await api.exportItem(item.id, path);
  };

  return (
    <div ref={sheet} className="dem-note">
      <NoteSheet
        number={archiveNumber(item.id)}
        kind={typeName(t, def)}
        kindIcon={iconOf(item.typeId)}
        date={item.updated != null ? isoDate(item.updated) : ""}
        title={title}
        titleSlot={
          <input
            className="dem-sheet-title-input"
            aria-label={t("item.title")}
            placeholder={t("item.untitled")}
            value={title}
            onFocus={() => setTitleFocused(true)}
            onBlur={() => {
              setTitleFocused(false);
              saveTitle();
            }}
            onChange={(e) => {
              setTitle(e.target.value);
              promote();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                saveTitle();
                editor.current?.focus();
              }
            }}
          />
        }
        mode={mode}
        onMode={setMode}
        onFormat={format}
        onAi={(action) =>
          ask(
            t(`ai.prompt.${action}`, { title: titleOf(t, item), id: item.id }),
            t(`editor.ai.${action}`),
          )
        }
        privacy={level}
        meta={
          <>
            <PrivacyPicker
              level={level}
              aiWeb={item.aiWeb}
              onLevel={(l) => update(patch({ privacy: coreLevel(l) }))}
              onAiWeb={(on) => update(patch({ aiWeb: on }))}
            />
            {item.source && (
              <SourceButton
                source={{
                  origin: item.source.origin as SourceInfo["origin"],
                  needsCheck: item.source.needsCheck,
                  conflict: item.source.conflict,
                  recheckOn: item.source.recheckOn ?? undefined,
                  refs: item.source.refs,
                }}
                onChange={(next) =>
                  update(
                    patch({
                      source: {
                        origin: next.origin,
                        needsCheck: next.needsCheck,
                        conflict: next.conflict ?? false,
                        recheckOn: next.recheckOn ?? null,
                        refs: next.refs,
                      },
                    }),
                  )
                }
              />
            )}
          </>
        }
        tools={
          <MenuButton
            label={t("item.more")}
            icon="more"
            variant="quiet"
            items={[
              ...(item.state === "inbox"
                ? [{ id: "file", label: t("nav.inbox.file"), icon: "check" as const }]
                : []),
              {
                id: "favorite",
                label: favorite ? t("item.unfavorite") : t("item.favorite"),
                icon: "favorite" as const,
              },
              { id: "move", label: t("item.move"), icon: "folder" as const },
              { id: "versions", label: t("item.versions"), icon: "history" as const },
              { id: "annotate", label: t("ai.task.annotate"), icon: "ai" as const },
              { id: "recite", label: t("learn.recite"), icon: "read" as const },
              { id: "derive", label: t("learn.derive"), icon: "learn" as const },
              { id: "export", label: t("item.exportMd"), icon: "export" as const },
              { id: "print", label: t("item.exportPdf"), icon: "print" as const },
              { id: "split", label: t("item.openBeside"), icon: "split" as const },
              ...(fields.generated_from
                ? [{ id: "regenerate", label: t("profile.regenerate"), icon: "sync" as const }]
                : []),
              ...(blob
                ? [{ id: "save-file", label: t("item.saveFile"), icon: "save-file" as const }]
                : []),
              { kind: "separator" as const, id: "sep" },
              {
                id: "archive",
                label: item.state === "archived" ? t("item.unarchive") : t("item.archive"),
                icon: "archive" as const,
              },
              { id: "trash", label: t("item.trash"), icon: "delete" as const },
            ]}
            onAction={(k) => {
              switch (String(k)) {
                case "file":
                  return update(patch({ state: "active" }));
                case "annotate":
                  return runTask("annotate");
                case "recite":
                  return void workspace.open({
                    contentId: `${RECITE_PANEL}:${item.id}`,
                    title: t("learn.recite"),
                    component: RECITE_PANEL,
                    params: { item: item.id },
                  });
                case "derive":
                  return void workspace.open({
                    contentId: `${DERIVE_PANEL}:${item.id}`,
                    title: t("learn.derive"),
                    component: DERIVE_PANEL,
                    params: { item: item.id },
                  });
                case "favorite":
                  return toggleFavorite(item.id);
                case "regenerate":
                  return void regenerate(t, item)
                    .then(() => refreshEditors(item.id))
                    .then(() => itemsChanged())
                    .catch(failed(t, t("profile.regenerate")));
                case "archive":
                  return update(
                    patch({ state: item.state === "archived" ? "active" : "archived" }),
                  );
                case "save-file":
                  return void saveFile().catch(failed(t, t("item.saveFile")));
                case "move":
                  return setMoving(true);
                case "versions":
                  return void workspace.open({
                    contentId: `versions:${item.id}`,
                    title: t("versions.titled", { title: titleOf(t, item, true) }),
                    component: VERSIONS_PANEL,
                    params: { item: item.id },
                  });
                case "export":
                  return void exportTo().catch(failed(t, t("item.exportMd")));
                case "print": {
                  // Only this sheet goes on paper (app.css).
                  const el = sheet.current?.querySelector<HTMLElement>(".dem-sheet");
                  const html = document.documentElement;
                  if (el) el.dataset.printing = "true";
                  html.dataset.printSheet = "true";
                  window.print();
                  setTimeout(() => {
                    if (el) delete el.dataset.printing;
                    delete html.dataset.printSheet;
                  }, 1000);
                  return;
                }
                case "split":
                  return openById(workspace, t, item.id, {
                    split: "right",
                    kind: "temp",
                    newTab: true,
                  });
                case "trash":
                  return void trashItem(t, item).catch(failed(t, t("item.trash")));
              }
            }}
          />
        }
      >
        <FieldsForm item={item} def={def} onChange={update} />
        {(item.typeId === "project" ||
          item.typeId === "domain" ||
          item.typeId === "learning_project") && (
          <ProjectExtras item={item} workspace={workspace} />
        )}
        {item.typeId === "learning_project" && (
          <ProjectLearn item={item} workspace={workspace} onTask={runTask} />
        )}
        <TextMenu privacy={level} onAction={textAction}>
          <div>
            <ProseEditor
              ref={editor}
              itemId={item.id}
              mode={mode}
              links={links}
              onEdited={promote}
              onRoot={(el) => (root.current = el)}
              onStatus={(s: { words?: number; saving?: boolean; headings?: Heading[] }) =>
                publishNote(item.id, s)
              }
              onReady={(h) =>
                publishNote(item.id, {
                  flush: h.flush,
                  goTo: h.goTo,
                  insert: h.insert,
                })
              }
            />
          </div>
        </TextMenu>
      </NoteSheet>
      <SelectionBar
        root={root}
        disabled={mode !== "edit"}
        privacy={level}
        onAction={(a, text) => {
          if (a === "ask-ai") textAsk(text);
          else if (a === "card") makeCard(text);
          else format(a);
        }}
      />
      <LinkDialog
        isOpen={linking}
        onOpenChange={setLinking}
        onLink={(href) => editor.current?.link(href)}
      />
      {gate.dialog}
      {moving && (
        <MoveDialog
          item={item}
          isOpen
          onOpenChange={setMoving}
          onMove={(c) => update(patch({ container: c, state: "active" }))}
        />
      )}
    </div>
  );
}

/** A chat kept from before: read only (M6). */
function ChatRecord({ item }: { item: ItemView }) {
  const t = useT();
  const f = parseFields(item.fields);
  let messages: { who: string; text: string }[] = [];
  try {
    messages = JSON.parse(typeof f.messages === "string" ? f.messages : "[]") as typeof messages;
  } catch {
    messages = [];
  }
  return (
    <div className="dem-flow" data-focus-home="page" tabIndex={-1}>
      <header className="dem-flow-head">
        <h1>{titleOf(t, item)}</h1>
        {typeof f.summary === "string" && f.summary && <p className="dem-flow-note">{f.summary}</p>}
      </header>
      <div className="dem-flow-body dem-chat-list">
        {messages.map((m, i) =>
          m.who === "me" ? (
            <p key={i} className="dem-chat-me">
              {m.text}
            </p>
          ) : (
            <p key={i} className="dem-chat-say">
              {m.text.replace(/```(corrections|verdict|harvest)[\s\S]*?(```|$)/g, "").trim()}
            </p>
          ),
        )}
      </div>
    </div>
  );
}

export function NotePanel({ tabId, contentId, kind, workspace }: PanelProps) {
  const t = useT();
  const {
    data: item,
    ready,
    error,
  } = useLive<ItemView | null>(() => api.itemGet(contentId), null, [contentId]);
  // Asked again each time the tab is opened (M9). Never persisted.
  const [verified, setVerified] = useState(false);
  const secret = item?.privacy === "confidential";
  const wasSecret = useRef(false);
  useEffect(() => {
    // Raising an open item to 机密 locks it at once, even if it was open before.
    if (secret && !wasSecret.current) setVerified(false);
    wasSecret.current = secret;
  }, [secret]);
  useEffect(() => {
    if (secret && !verified) {
      workspace.retitle(tabId, t("privacy.secretTitle"));
      workspace.setTabParams(tabId, { privacy: "secret" });
    }
  }, [secret, verified, workspace, tabId, t]);
  useEffect(() => () => closeNote(contentId), [contentId]);
  if (error && !item) return <p className="dem-note-missing">{t("item.gone")}</p>;
  if (!ready || !item)
    return (
      <div className="dem-note-loading">
        <Spinner label={t("item.loading")} />
      </div>
    );
  if (item.typeId === "ai_session") return <ChatRecord item={item} />;
  if (item.state === "trashed") return <p className="dem-note-missing">{t("item.inTrash")}</p>;
  if (secret && !verified)
    return (
      <SecretGate
        passwordOnly
        verifier={{
          system: () => Promise.resolve("unavailable"),
          password: async (pw) => ((await api.verifyPassword(pw)) ? "ok" : "wrong"),
        }}
        onVerified={() => setVerified(true)}
      />
    );
  return (
    <NoteBody
      item={item}
      tabId={tabId}
      workspace={workspace}
      promote={() => kind === "preview" && workspace.promote(tabId)}
    />
  );
}
