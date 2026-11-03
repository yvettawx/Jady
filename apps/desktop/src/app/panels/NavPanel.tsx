/* eslint-disable react-refresh/only-export-components -- the view switch lives with its panel */
// The sidebar's navigation panel (docs/05-design.md §2.3): whichever view the leftmost bar picked.
// 目录 is the one place 机密 titles show.
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ItemView, SearchHit } from "../../bindings";
import { useT } from "../../i18n/context";
import { match } from "../../launcher/match";
import { Badge, PrivacyMark } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { Icon } from "../../ui/Icon";
import { MenuButton } from "../../ui/Menu";
import { EmptyState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import { Tree, type TreeNode as UiNode } from "../../ui/Tree";
import type { WorkspaceApi } from "../../workspace/api";
import type { PanelProps } from "../../workspace/registry";
import { createAndOpen, failed, openById, openItem, RECORDS_PANEL, TYPE_PANEL } from "../actions";
import { api, itemsChanged, parseFields } from "../api";
import { useFavorites } from "../favorites";
import { DailyView } from "./DailyView";
import { OkrView } from "./OkrView";
import { ProfileView } from "./ProfileView";
import { ReviewView } from "./ReviewView";
import { useLive } from "../live";
import { registerNavView, useNavViews } from "../navViews";
import { iconOf, isoDate, levelOf, patch, titleOf, typeName } from "../model";
import { useLibrary } from "../store";

let navView = "tree";
const listeners = new Set<() => void>();
export function setNavView(v: string) {
  navView = v;
  listeners.forEach((f) => f());
}
const useNavView = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => navView,
  );

function Row({
  item,
  workspace,
  trailing,
  children,
  icon = true,
}: {
  item: ItemView;
  workspace: WorkspaceApi;
  trailing?: ReactNode;
  children?: ReactNode;
  icon?: boolean;
}) {
  const t = useT();
  const level = levelOf(item.privacy);
  return (
    <li className="dem-nav-row">
      {children}
      <button
        type="button"
        className="dem-nav-open"
        onClick={(e) =>
          openItem(
            workspace,
            t,
            item,
            e.metaKey || e.ctrlKey ? { kind: "temp", newTab: true } : { kind: "preview" },
          )
        }
        onDoubleClick={() => openItem(workspace, t, item, { kind: "temp" })}
      >
        {icon && <Icon name={iconOf(item.typeId)} size={14} />}
        <span className="dem-nav-title">{titleOf(t, item)}</span>
      </button>
      {level !== "normal" && <PrivacyMark level={level} />}
      {trailing}
    </li>
  );
}

/** 目录: domains and projects with what is in them, then what is in none of them. */
function DirectoryView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { tree, directory, types } = useLibrary();
  const nodes = useMemo(() => {
    const structural = new Set(tree.map((n) => n.id));
    // Rows of a table live in their table: 目录 shows them only once they are put somewhere.
    const rows = new Set(types.filter((x) => x.default_view !== "note").map((x) => x.id));
    const leaves = directory.filter(
      (i) => !structural.has(i.id) && i.state === "active" && (i.container || !rows.has(i.typeId)),
    );
    const leaf = (i: ItemView): UiNode => {
      const level = levelOf(i.privacy);
      return {
        id: i.id,
        // 机密 titles show here and only here.
        label: titleOf(t, i, true),
        icon: iconOf(i.typeId),
        trailing: level !== "normal" ? <PrivacyMark level={level} /> : undefined,
      };
    };
    const build = (parent: string | null): UiNode[] =>
      tree
        .filter((n) => n.parent === parent && n.state !== "trashed")
        .map((n): UiNode => {
          const level = levelOf(n.privacy);
          const children = [
            ...build(n.id),
            ...leaves.filter((l) => l.container === n.id).map(leaf),
          ];
          return {
            id: n.id,
            label: n.title || t("item.untitled"),
            icon: iconOf(n.kind),
            trailing: level !== "normal" ? <PrivacyMark level={level} /> : undefined,
            children: children.length ? children : undefined,
          };
        });
    return [
      ...build(null),
      ...leaves.filter((l) => !l.container || !structural.has(l.container)).map(leaf),
    ];
  }, [tree, directory, types, t]);
  return (
    <div className="dem-nav">
      <div className="dem-nav-tools">
        <MenuButton
          label={t("nav.new")}
          icon="plus"
          variant="quiet"
          items={[
            { id: "note", label: t("type.note"), icon: "file" },
            { id: "project", label: t("type.project"), icon: "kanban" },
            { id: "domain", label: t("type.domain"), icon: "folder" },
          ]}
          onAction={(k) =>
            void createAndOpen(workspace, t, { typeId: String(k) }).catch(failed(t, t("nav.new")))
          }
        />
      </div>
      {nodes.length ? (
        <Tree
          aria-label={t("shell.view.tree")}
          items={nodes}
          onAction={(id) => openById(workspace, t, String(id))}
        />
      ) : (
        <EmptyState icon="tree" title={t("nav.tree.empty")} description={t("nav.tree.hint")} />
      )}
    </div>
  );
}

/** Marks what matched: the core wraps it in ⁅ and ⁆. */
function Snippet({ text }: { text: string }) {
  return (
    <span className="dem-nav-snippet">
      {text
        .split(/(⁅[^⁆]*⁆)/)
        .map((p, i) => (p.startsWith("⁅") ? <mark key={i}>{p.slice(1, -1)}</mark> : p))}
    </span>
  );
}

function SearchView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { tags } = useLibrary();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const q = query.trim();
  const { data: hits } = useLive<SearchHit[]>(
    () => (q ? api.search(q, 50) : Promise.resolve([])),
    [],
    [q],
  );
  const { data: tagged } = useLive<ItemView[]>(
    () =>
      tag
        ? api.itemList({
            typeId: null,
            states: ["inbox", "active"],
            container: null,
            tag,
            order: "updated",
            limit: null,
          })
        : Promise.resolve([]),
    [],
    [tag],
  );
  return (
    <div className="dem-nav">
      <div className="dem-nav-tools">
        <TextField
          aria-label={t("shell.view.search")}
          placeholder={t("nav.search.placeholder")}
          icon="search"
          value={query}
          onChange={setQuery}
        />
      </div>
      {q ? (
        hits.length ? (
          <ul className="dem-nav-list">
            {hits
              .map((h) => (
                <Row key={h.item.id} item={h.item} workspace={workspace}>
                  {null}
                </Row>
              ))
              .flatMap((row, i) => {
                const s = hits[i]?.snippet;
                return s
                  ? [
                      row,
                      <li key={`s${i}`} className="dem-nav-hit">
                        <Snippet text={s} />
                      </li>,
                    ]
                  : [row];
              })}
          </ul>
        ) : (
          <EmptyState icon="search" title={t("nav.search.none")} />
        )
      ) : tag ? (
        <>
          <div className="dem-nav-tools">
            <Button size="sm" variant="quiet" icon="back" onPress={() => setTag(null)}>
              {`#${tag}`}
            </Button>
          </div>
          <ul className="dem-nav-list">
            {tagged.map((i) => (
              <Row key={i.id} item={i} workspace={workspace} />
            ))}
          </ul>
        </>
      ) : tags.length ? (
        <ul className="dem-nav-tags">
          {tags.map((x) => (
            <li key={x.tag}>
              <button type="button" className="dem-nav-tag" onClick={() => setTag(x.tag)}>
                <span>{`#${x.tag}`}</span>
                <span className="dem-nav-count">{x.count}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="search" title={t("nav.search.hint")} />
      )}
    </div>
  );
}

function InboxView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const inbox = items.filter((i) => i.state === "inbox");
  return (
    <div className="dem-nav">
      {inbox.length ? (
        <ul className="dem-nav-list">
          {inbox.map((i) => (
            <Row
              key={i.id}
              item={i}
              workspace={workspace}
              trailing={
                <Button
                  size="sm"
                  variant="quiet"
                  icon="check"
                  aria-label={t("nav.inbox.file")}
                  onPress={() =>
                    void api
                      .itemUpdate(i.id, patch({ state: "active" }))
                      .then(() => itemsChanged())
                      .catch(failed(t, t("nav.inbox.file")))
                  }
                />
              }
            />
          ))}
        </ul>
      ) : (
        <EmptyState icon="inbox" title={t("nav.inbox.empty")} description={t("nav.inbox.hint")} />
      )}
    </div>
  );
}

const STATUS_ORDER = ["next", "waiting", "someday", "done"];

function TodoView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const [text, setText] = useState("");
  const todos = items.filter((i) => i.typeId === "todo");
  const statusOf = (i: ItemView) => {
    const s = parseFields(i.fields).status;
    return typeof s === "string" ? s : "next";
  };
  const setStatus = (i: ItemView, status: string) =>
    void api
      .itemUpdate(i.id, patch({ fields: JSON.stringify({ status }) }))
      .then(() => itemsChanged())
      .catch(failed(t, t("type.todo")));
  const [today] = useState(() => isoDate(Date.now()));
  return (
    <div className="dem-nav">
      <div className="dem-nav-tools">
        <TextField
          aria-label={t("nav.todo.add")}
          placeholder={t("nav.todo.add")}
          icon="plus"
          value={text}
          onChange={setText}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !text.trim() || e.nativeEvent.isComposing) return;
            void api
              .itemCreate({
                typeId: "todo",
                title: text.trim(),
                state: null,
                container: null,
                privacy: null,
                fields: JSON.stringify({ status: "next" }),
                tags: null,
                due: null,
                markdown: null,
              })
              .then(() => itemsChanged())
              .catch(failed(t, t("nav.todo.add")));
            setText("");
          }}
        />
      </div>
      {!todos.length && <EmptyState icon="todo" title={t("home.todos.empty")} />}
      {STATUS_ORDER.map((status) => {
        const group = todos.filter((i) => statusOf(i) === status);
        if (!group.length) return null;
        return (
          <section key={status}>
            <h3 className="dem-nav-group">{t(`option.${status}`)}</h3>
            <ul className="dem-nav-list">
              {group.map((i) => (
                <Row
                  key={i.id}
                  item={i}
                  workspace={workspace}
                  icon={false}
                  trailing={
                    i.due != null && (
                      <Badge
                        tone={isoDate(i.due) < today && status !== "done" ? "danger" : "neutral"}
                      >
                        {isoDate(i.due).slice(5)}
                      </Badge>
                    )
                  }
                >
                  <input
                    type="checkbox"
                    className="dem-nav-check"
                    aria-label={t("nav.todo.done")}
                    checked={status === "done"}
                    onChange={(e) => setStatus(i, e.target.checked ? "done" : "next")}
                  />
                </Row>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function TypesView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { types, items } = useLibrary();
  return (
    <div className="dem-nav">
      <div className="dem-nav-tools">
        <Button
          size="sm"
          variant="quiet"
          icon="plus"
          onPress={() =>
            workspace.open({ contentId: "type:new", title: t("types.new"), component: TYPE_PANEL })
          }
        >
          {t("types.new")}
        </Button>
      </div>
      <ul className="dem-nav-list">
        {types.map((def) => {
          const name = typeName(t, def);
          return (
            <li key={def.id} className="dem-nav-row">
              <button
                type="button"
                className="dem-nav-open"
                onClick={() =>
                  workspace.open(
                    { contentId: `records:${def.id}`, title: name, component: RECORDS_PANEL },
                    { kind: "preview" },
                  )
                }
              >
                <Icon name={iconOf(def.id)} size={14} />
                <span className="dem-nav-title">{name}</span>
                <span className="dem-nav-count">
                  {items.filter((i) => i.typeId === def.id).length}
                </span>
              </button>
              {!def.builtin && (
                <Button
                  size="sm"
                  variant="quiet"
                  icon="edit"
                  aria-label={t("types.edit")}
                  onPress={() =>
                    workspace.open({
                      contentId: `type:${def.id}`,
                      title: name,
                      component: TYPE_PANEL,
                    })
                  }
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TrashView() {
  const t = useT();
  const { data: trashed } = useLive<ItemView[]>(
    () =>
      api.itemList({
        typeId: null,
        states: ["trashed"],
        container: null,
        tag: null,
        order: "updated",
        limit: null,
      }),
    [],
  );
  const [confirm, setConfirm] = useState<ItemView | "all" | null>(null);
  const all = confirm === "all";
  return (
    <div className="dem-nav">
      {trashed.length > 0 && (
        <div className="dem-nav-tools">
          <Button size="sm" variant="quiet" icon="delete" onPress={() => setConfirm("all")}>
            {t("trash.empty")}
          </Button>
        </div>
      )}
      {trashed.length ? (
        <ul className="dem-nav-list">
          {trashed.map((i) => (
            <li key={i.id} className="dem-nav-row">
              <span className="dem-nav-open" data-static>
                <Icon name={iconOf(i.typeId)} size={14} />
                <span className="dem-nav-title">{titleOf(t, i)}</span>
              </span>
              <Button
                size="sm"
                variant="quiet"
                icon="undo"
                aria-label={t("trash.restore")}
                onPress={() =>
                  void api
                    .itemUpdate(i.id, patch({ state: "active" }))
                    .then(() => itemsChanged())
                    .catch(failed(t, t("trash.restore")))
                }
              />
              <Button
                size="sm"
                variant="quiet"
                icon="delete"
                aria-label={t("trash.purge")}
                onPress={() => setConfirm(i)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="delete" title={t("trash.none")} />
      )}
      <ConfirmDialog
        isOpen={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={all ? t("trash.empty.title") : t("trash.purge.title")}
        message={t("trash.purge.message")}
        confirmLabel={all ? t("trash.empty") : t("trash.purge")}
        danger
        onConfirm={() => {
          const job = all
            ? api.trashEmpty().then(() => undefined)
            : confirm
              ? api.itemPurge(confirm.id).then(() => undefined)
              : Promise.resolve();
          void job.then(() => itemsChanged()).catch(failed(t, t("trash.purge")));
          setConfirm(null);
        }}
      />
    </div>
  );
}

function FavoritesView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const ids = useFavorites();
  const list = ids.flatMap((id) => items.find((i) => i.id === id) ?? []);
  return (
    <div className="dem-nav">
      {list.length ? (
        <ul className="dem-nav-list">
          {list.map((i) => (
            <Row key={i.id} item={i} workspace={workspace} />
          ))}
        </ul>
      ) : (
        <EmptyState icon="favorite" title={t("nav.favorites.empty")} />
      )}
    </div>
  );
}

function ArchiveView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { data: archived } = useLive<ItemView[]>(
    () =>
      api.itemList({
        typeId: null,
        states: ["archived"],
        container: null,
        tag: null,
        order: "updated",
        limit: null,
      }),
    [],
  );
  return (
    <div className="dem-nav">
      {archived.length ? (
        <ul className="dem-nav-list">
          {archived.map((i) => (
            <Row key={i.id} item={i} workspace={workspace} />
          ))}
        </ul>
      ) : (
        <EmptyState icon="archive" title={t("nav.archive.empty")} />
      )}
    </div>
  );
}

registerNavView({
  id: "today",
  icon: "calendar",
  label: "shell.view.today",
  shortcut: "Mod+Shift+T",
  render: DailyView,
});
registerNavView({
  id: "tree",
  icon: "tree",
  label: "shell.view.tree",
  shortcut: "Mod+Shift+E",
  render: DirectoryView,
});
registerNavView({
  id: "search",
  icon: "search",
  label: "shell.view.search",
  shortcut: "Mod+Shift+F",
  render: SearchView,
});
registerNavView({
  id: "inbox",
  icon: "inbox",
  label: "shell.view.inbox",
  shortcut: "Mod+Shift+I",
  render: InboxView,
});
registerNavView({
  id: "todo",
  icon: "todo",
  label: "shell.view.todo",
  shortcut: "Mod+Shift+D",
  render: TodoView,
});
registerNavView({
  id: "types",
  icon: "kanban",
  label: "shell.view.types",
  shortcut: "Mod+Shift+Y",
  render: TypesView,
});
registerNavView({ id: "okr", icon: "place", label: "shell.view.okr", render: OkrView });
registerNavView({ id: "reviews", icon: "review", label: "shell.view.reviews", render: ReviewView });
registerNavView({
  id: "profile",
  icon: "person",
  label: "shell.view.profile",
  render: ProfileView,
});
registerNavView({
  id: "favorites",
  icon: "favorite",
  label: "shell.view.favorites",
  shortcut: "Mod+Shift+B",
  render: FavoritesView,
});
registerNavView({
  id: "archive",
  icon: "archive",
  label: "shell.view.archive",
  render: ArchiveView,
});
registerNavView({ id: "trash", icon: "delete", label: "shell.view.trash", render: TrashView });

export function NavBody({ view, workspace }: { view: string; workspace: WorkspaceApi }) {
  const views = useNavViews();
  const Body = (views.find((v) => v.id === view) ?? views[0])?.render;
  return Body ? <Body workspace={workspace} /> : null;
}

export function NavPanel({ workspace }: PanelProps) {
  const view = useNavView();
  return <NavBody view={view} workspace={workspace} />;
}

/** Items whose title matches, for `[[`. 机密 items are never offered. */
export function matchItems(items: ItemView[], query: string) {
  const q = query.trim();
  const listed = items.filter((i) => i.privacy !== "confidential" && i.title);
  if (!q) return listed;
  return listed.filter((i) => match(q, i.title ?? "") !== null);
}
