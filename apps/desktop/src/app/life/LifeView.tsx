// The 生活 view in the leftmost bar: what is on the calendar, the views that look across the whole
// library, and the templates that are in use.
import { useState } from "react";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/TextField";
import { showToast } from "../../ui/toast";
import type { WorkspaceApi } from "../../workspace/api";
import { createAndOpen, failed, openItem } from "../actions";
import { typeName } from "../model";
import { refreshLibrary, useLibrary } from "../store";
import { statsShape } from "./sums";
import { allTemplates, installTemplate, isInstalled, startFrom, type Template } from "./templates";
import { LIFE_PANELS } from "./ids";

const row = (ws: WorkspaceApi, t: (k: string) => string, id: string, title: string) => (
  <li key={id}>
    <button
      type="button"
      className="dem-nav-open"
      onClick={() => ws.open({ contentId: id, component: id, title: t(title) })}
    >
      <span className="dem-nav-title">{t(title)}</span>
    </button>
  </li>
);

function Starter({ template, workspace }: { template: Template; workspace: WorkspaceApi }) {
  const t = useT();
  const [name, setName] = useState("");
  if (!template.starter) return null;
  return (
    <form
      className="dem-life-form"
      onSubmit={(e) => {
        e.preventDefault();
        const title = name.trim();
        if (!title) return;
        setName("");
        void startFrom(t, template, title)
          .then((p) => openItem(workspace, t, p, { kind: "temp" }))
          .catch(failed(t, t(template.name)));
      }}
    >
      <TextField
        aria-label={t(template.starter.action)}
        placeholder={t(template.starter.action)}
        value={name}
        onChange={setName}
      />
    </form>
  );
}

export function LifeView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { types } = useLibrary();
  const on = allTemplates().filter((x) => isInstalled(x, types));
  const used = new Set(on.flatMap((x) => x.types.map((y) => y.id)));
  return (
    <div className="dem-nav-section dem-life-nav">
      <ul className="dem-life-list">{LIFE_PANELS.map((p) => row(workspace, t, p.id, p.title))}</ul>
      <Button
        size="sm"
        variant="quiet"
        icon="edit"
        onPress={() =>
          void createAndOpen(workspace, t, {
            typeId: "whiteboard",
            title: t("whiteboard.new"),
          }).catch(failed(t, t("whiteboard.title")))
        }
      >
        {t("whiteboard.create")}
      </Button>
      {on.length > 0 && <h3>{t("template.inUse")}</h3>}
      {on.map((x) => (
        <div key={x.id}>
          <ul className="dem-life-list">
            {x.types.map((y) => {
              const def = types.find((d) => d.id === y.id);
              if (!def) return null;
              const hasStats = !!statsShape(def, (s) => s);
              return (
                <li key={y.id} className="dem-life-type">
                  <button
                    type="button"
                    className="dem-nav-open"
                    onClick={() =>
                      workspace.open({
                        contentId: `records:${def.id}`,
                        component: "records",
                        title: typeName(t, def),
                      })
                    }
                  >
                    <span className="dem-nav-title">{typeName(t, def)}</span>
                  </button>
                  {hasStats && used.has(def.id) && (
                    <Button
                      size="sm"
                      variant="quiet"
                      icon="heatmap"
                      aria-label={t("stats.open", { name: typeName(t, def) })}
                      onPress={() =>
                        workspace.open({
                          contentId: `stats:${def.id}`,
                          component: "stats",
                          title: typeName(t, def),
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <Starter template={x} workspace={workspace} />
        </div>
      ))}
    </div>
  );
}

/** Settings: which templates are in use. Adding one only adds types. */
export function TemplatesSection() {
  const t = useT();
  const { types } = useLibrary();
  return (
    <ul className="dem-templates">
      {allTemplates().map((x) => {
        const on = isInstalled(x, types);
        return (
          <li key={x.id}>
            <div>
              <strong>{t(x.name)}</strong>
              <p>{t(x.about)}</p>
            </div>
            {on ? (
              <span className="dem-nav-count">{t("template.added")}</span>
            ) : (
              <Button
                size="sm"
                onPress={() =>
                  void installTemplate(t, x, types)
                    .then(() => refreshLibrary())
                    .then(() => showToast({ text: t("template.done", { name: t(x.name) }) }))
                    .catch(failed(t, t(x.name)))
                }
              >
                {t("template.add")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
