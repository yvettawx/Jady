// What many places do: open an item in the workspace, make a new one, put one in the trash.
import type { ItemView, NewItem } from "../bindings";
import type { Translate } from "../i18n/messages";
import { showToast } from "../ui/toast";
import type { OpenOptions, WorkspaceApi } from "../workspace/api";
import { api, itemsChanged } from "./api";
import { levelOf, patch, titleOf } from "./model";
import { library } from "./store";

export const NOTE_PANEL = "note";
export const NAV_PANEL = "nav";
export const RECORDS_PANEL = "records";
export const TYPE_PANEL = "type-editor";
export const VERSIONS_PANEL = "versions";
export const HEATMAP_PANEL = "heatmap";

export function openItem(
  ws: WorkspaceApi,
  t: Translate,
  item: ItemView,
  opts: OpenOptions = { kind: "preview" },
): string {
  return ws.open(
    {
      contentId: item.id,
      title: titleOf(t, item),
      component: item.typeId === "whiteboard" ? "whiteboard" : NOTE_PANEL,
      params: { privacy: levelOf(item.privacy) },
    },
    opts,
  );
}

export function openById(ws: WorkspaceApi, t: Translate, id: string, opts?: OpenOptions): void {
  const known =
    library().items.find((x) => x.id === id) ?? library().directory.find((x) => x.id === id);
  if (known) openItem(ws, t, known, opts);
  else void api.itemGet(id).then((item) => openItem(ws, t, item, opts));
}

export const newItem = (fields: Partial<NewItem> & { typeId: string }): NewItem => ({
  title: null,
  state: null,
  container: null,
  privacy: null,
  fields: null,
  tags: null,
  due: null,
  markdown: null,
  // A new to-do is something to do next, unless it says otherwise.
  ...(fields.typeId === "todo" ? { fields: JSON.stringify({ status: "next" }) } : {}),
  ...fields,
});

export async function createAndOpen(
  ws: WorkspaceApi,
  t: Translate,
  fields: Partial<NewItem> & { typeId: string },
): Promise<ItemView> {
  const item = await api.itemCreate(newItem(fields));
  itemsChanged();
  openItem(ws, t, item, { kind: "temp" });
  return item;
}

/** To the trash, with a way back for a moment (docs/05-design.md §3.9). */
export async function trashItem(t: Translate, item: ItemView): Promise<void> {
  await api.itemUpdate(item.id, patch({ state: "trashed" }));
  itemsChanged();
  showToast({
    text: t("item.trashed"),
    action: {
      label: t("action.undo"),
      onAction: () => {
        void api.itemUpdate(item.id, patch({ state: item.state })).then(() => itemsChanged());
      },
    },
  });
}

/** Tells the user something went wrong without saying more than the core did. */
export function failed(t: Translate, what: string) {
  return (e: unknown) => {
    showToast({
      text: t("error.failed", { what, why: e instanceof Error ? e.message : String(e) }),
      tone: "danger",
    });
  };
}
