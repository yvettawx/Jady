// A project's or domain's page keeps what is settled apart from what is not (PRD A9): 待定事项, which
// can grow into a 决策记录, and 待补清单.
import { useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/TextField";
import type { WorkspaceApi } from "../../workspace/api";
import { failed, newItem, openItem } from "../actions";
import { api, itemsChanged, parseFields } from "../api";
import { patch, titleOf } from "../model";
import { useLibrary } from "../store";

const openStatus = (i: ItemView) => {
  const s = parseFields(i.fields).status;
  return s !== "settled" && s !== "done";
};

function List({
  title,
  items,
  add,
  workspace,
  actions,
  addLabel,
}: {
  title: string;
  items: ItemView[];
  add?: (text: string) => void;
  addLabel?: string;
  workspace: WorkspaceApi;
  actions?: (i: ItemView) => React.ReactNode;
}) {
  const t = useT();
  const [text, setText] = useState("");
  return (
    <section className="dem-extras-part">
      <h3>{title}</h3>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <button type="button" onClick={() => openItem(workspace, t, i)}>
              {titleOf(t, i)}
            </button>
            {actions?.(i)}
          </li>
        ))}
      </ul>
      {add && (
        <TextField
          aria-label={addLabel ?? title}
          placeholder={addLabel}
          icon="plus"
          value={text}
          onChange={setText}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !text.trim() || e.nativeEvent.isComposing) return;
            add(text.trim());
            setText("");
          }}
        />
      )}
    </section>
  );
}

export function ProjectExtras({ item, workspace }: { item: ItemView; workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const inside = items.filter((i) => i.container === item.id);
  const create = (typeId: string, title: string, fields: unknown, what: string) =>
    api
      .itemCreate(newItem({ typeId, title, container: item.id, fields: JSON.stringify(fields) }))
      .then((made) => {
        itemsChanged();
        return made;
      })
      .catch((e: unknown) => {
        failed(t, what)(e);
        return null;
      });
  return (
    <div className="dem-extras">
      <section className="dem-extras-part">
        <h3>{t("settings.ai.agreement")}</h3>
        <Button
          size="sm"
          icon="edit"
          onPress={() => {
            const have = inside.find((i) => i.typeId === "agreement");
            if (have) return openItem(workspace, t, have, { kind: "temp" });
            void api
              .itemCreate(
                newItem({
                  typeId: "agreement",
                  title: t("agreement.of", { title: titleOf(t, item) }),
                  container: item.id,
                }),
              )
              .then((made) => {
                itemsChanged();
                openItem(workspace, t, made, { kind: "temp" });
              })
              .catch(failed(t, t("settings.ai.agreement")));
          }}
        >
          {t("settings.ai.agreement.edit")}
        </Button>
      </section>
      <List
        title={t("extras.questions")}
        addLabel={t("extras.addQuestion")}
        items={inside.filter((i) => i.typeId === "question" && openStatus(i))}
        workspace={workspace}
        add={(text) => void create("question", text, { status: "open" }, t("extras.questions"))}
        actions={(q) => (
          <Button
            size="sm"
            variant="quiet"
            onPress={() => {
              void create("decision", q.title ?? "", { options: "" }, t("extras.decisions")).then(
                (d) => {
                  if (!d) return;
                  openItem(workspace, t, d, { kind: "temp" });
                  void api
                    .itemUpdate(q.id, patch({ fields: JSON.stringify({ status: "settled" }) }))
                    .then(() => itemsChanged());
                },
              );
            }}
          >
            {t("extras.toDecision")}
          </Button>
        )}
      />
      <List
        title={t("extras.decisions")}
        items={inside.filter((i) => i.typeId === "decision")}
        workspace={workspace}
      />
      <List
        title={t("extras.followups")}
        addLabel={t("extras.addFollowup")}
        items={inside.filter((i) => i.typeId === "followup" && openStatus(i))}
        workspace={workspace}
        add={(text) => void create("followup", text, { status: "open" }, t("extras.followups"))}
        actions={(f) => (
          <Button
            size="sm"
            variant="quiet"
            icon="check"
            aria-label={t("nav.todo.done")}
            onPress={() =>
              void api
                .itemUpdate(f.id, patch({ fields: JSON.stringify({ status: "done" }) }))
                .then(() => itemsChanged())
                .catch(failed(t, t("extras.followups")))
            }
          />
        )}
      />
    </div>
  );
}
