// 自定义类型 (PRD A12 basic): a name and some fields. Fields added later simply start empty on old
// items; removing one leaves what items already hold alone (M1).
import { useState } from "react";
import type { FieldDef, FieldKind, TypeDef } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { TextField } from "../../ui/TextField";
import { showToast } from "../../ui/toast";
import type { PanelProps } from "../../workspace/registry";
import { failed, RECORDS_PANEL } from "../actions";
import { api, itemsChanged } from "../api";
import { useLibrary } from "../store";

const KINDS: FieldKind["type"][] = [
  "text",
  "number",
  "date",
  "select",
  "multi_select",
  "checkbox",
  "rating",
  "url",
];

function kindOf(type: FieldKind["type"], options: string): FieldKind {
  switch (type) {
    case "select":
    case "multi_select":
      return {
        type,
        options: options
          .split(/[,，、\n]/)
          .map((x) => x.trim())
          .filter(Boolean)
          .map((name, i) => ({ id: `o${i + 1}`, name })),
      };
    case "rating":
      return { type, max: 5 };
    default:
      return { type } as FieldKind;
  }
}

const optionsText = (k: FieldKind) =>
  k.type === "select" || k.type === "multi_select" ? k.options.map((o) => o.name).join(", ") : "";

interface Draft {
  key: string;
  name: string;
  type: FieldKind["type"];
  options: string;
}

export function TypePanel({ contentId, tabId, workspace }: PanelProps) {
  const t = useT();
  const { types } = useLibrary();
  const id = contentId.replace(/^type:/, "");
  const existing = types.find((x) => x.id === id);
  const [name, setName] = useState(existing?.name ?? "");
  const [fields, setFields] = useState<Draft[]>(
    existing?.fields.map((f) => ({
      key: f.key,
      name: f.name,
      type: f.kind.type,
      options: optionsText(f.kind),
    })) ?? [{ key: "f1", name: "", type: "text", options: "" }],
  );
  const [view, setView] = useState<TypeDef["default_view"]>(existing?.default_view ?? "table");
  const edit = (i: number, p: Partial<Draft>) =>
    setFields((all) => all.map((f, j) => (j === i ? { ...f, ...p } : f)));

  const saveType = () => {
    const defs: FieldDef[] = fields
      .filter((f) => f.name.trim())
      .map((f) => ({ key: f.key, name: f.name.trim(), kind: kindOf(f.type, f.options) }));
    const def: TypeDef = {
      // The core gives a new type its id.
      id: existing?.id ?? "",
      name: name.trim(),
      builtin: false,
      default_view: view,
      default_privacy: existing?.default_privacy ?? "normal",
      color: existing?.color ?? null,
      fields: defs,
    };
    void api
      .typeSave(def)
      .then((saved) => {
        itemsChanged();
        showToast({ text: t("types.saved"), tone: "ok" });
        workspace.close(tabId);
        workspace.open({
          contentId: `records:${saved.id}`,
          title: saved.name,
          component: RECORDS_PANEL,
        });
      })
      .catch(failed(t, t("types.new")));
  };

  return (
    <div className="dem-type-page" data-focus-home="page" tabIndex={-1}>
      <div className="dem-type-editor">
        <h1 className="dem-type-title">{existing ? t("types.edit") : t("types.new")}</h1>
        <TextField label={t("types.name")} value={name} onChange={setName} autoFocus={!existing} />
        <Select
          label={t("types.view")}
          options={[
            { id: "table", label: t("records.table") },
            { id: "board", label: t("records.board") },
            { id: "note", label: t("types.view.note") },
          ]}
          selectedKey={view}
          onSelectionChange={(k) => setView(k as TypeDef["default_view"])}
        />
        <h2 className="dem-type-sub">{t("types.fields")}</h2>
        <ul className="dem-type-fields">
          {fields.map((f, i) => (
            <li key={f.key}>
              <TextField
                aria-label={t("types.fieldName")}
                placeholder={t("types.fieldName")}
                value={f.name}
                onChange={(v) => edit(i, { name: v })}
              />
              <Select
                aria-label={t("types.fieldKind")}
                options={KINDS.map((k) => ({ id: k, label: t(`types.kind.${k}`) }))}
                selectedKey={f.type}
                onSelectionChange={(k) => edit(i, { type: k as FieldKind["type"] })}
              />
              {(f.type === "select" || f.type === "multi_select") && (
                <TextField
                  aria-label={t("types.options")}
                  placeholder={t("types.options")}
                  value={f.options}
                  onChange={(v) => edit(i, { options: v })}
                />
              )}
              <Button
                size="sm"
                variant="quiet"
                icon="close"
                aria-label={t("types.removeField")}
                onPress={() => setFields((all) => all.filter((_, j) => j !== i))}
              />
            </li>
          ))}
        </ul>
        <div className="dem-type-actions">
          <Button
            variant="quiet"
            icon="plus"
            onPress={() =>
              setFields((all) => [
                ...all,
                { key: `f${Date.now().toString(36)}`, name: "", type: "text", options: "" },
              ])
            }
          >
            {t("types.addField")}
          </Button>
          <Button variant="primary" isDisabled={!name.trim()} onPress={saveType}>
            {t("action.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
