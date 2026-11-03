/* eslint-disable react-refresh/only-export-components -- document building lives with its view */
// 个人档案 (PRD A10, M5): experiences and skills are the one place facts live. A résumé or a cover
// letter is made from them and remembers from which, so it can be made again when a fact changes.
import { useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/TextField";
import { showToast } from "../../ui/toast";
import type { WorkspaceApi } from "../../workspace/api";
import { failed, newItem, openItem } from "../actions";
import { api, itemsChanged, parseFields } from "../api";
import { titleOf } from "../model";
import { useLibrary } from "../store";

const text = (i: ItemView, key: string) => {
  const v = parseFields(i.fields)[key];
  return typeof v === "string" ? v : "";
};

export type DocKind = "resume" | "cover";

/** What a document says, from its sources, in Markdown. No AI needed. */
export async function buildDocument(
  t: (k: string) => string,
  kind: DocKind,
  sources: ItemView[],
): Promise<string> {
  const exp = sources.filter((i) => i.typeId === "experience");
  const skills = sources.filter((i) => i.typeId === "skill");
  const lines: string[] = [];
  if (kind === "cover") lines.push(t("profile.cover.lead"), "");
  if (exp.length) {
    lines.push(`## ${t("profile.experience")}`, "");
    for (const e of exp) {
      const when = [text(e, "from"), text(e, "to")].filter(Boolean).join(" – ");
      const head = [e.title, text(e, "role"), text(e, "org"), when].filter(Boolean).join("，");
      lines.push(`### ${head}`, "");
      const body = (await api.bodyMarkdown(e.id)).trim();
      if (body) lines.push(body, "");
    }
  }
  if (skills.length) {
    lines.push(`## ${t("profile.skills")}`, "");
    for (const s of skills) {
      const level = text(s, "level");
      lines.push(`- ${s.title ?? ""}${level ? `：${level}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** A document that was made from sources, made again. */
export async function regenerate(t: (k: string) => string, doc: ItemView) {
  const f = parseFields(doc.fields);
  const ids = Array.isArray(f.generated_from) ? f.generated_from.map(String) : [];
  const sources = await Promise.all(ids.map((id) => api.itemGet(id).catch(() => null)));
  const md = await buildDocument(
    t,
    f.kind === "cover" ? "cover" : "resume",
    sources.filter((s): s is ItemView => s !== null && s.state !== "trashed"),
  );
  await api.bodySetMarkdown(doc.id, md);
}

function Section({
  type,
  label,
  workspace,
  items,
}: {
  type: string;
  label: string;
  workspace: WorkspaceApi;
  items: ItemView[];
}) {
  const t = useT();
  const [title, setTitle] = useState("");
  return (
    <section>
      <h3 className="dem-nav-group">{label}</h3>
      <ul className="dem-nav-list">
        {items.map((i) => (
          <li key={i.id} className="dem-nav-row">
            <button
              type="button"
              className="dem-nav-open"
              onClick={() => openItem(workspace, t, i)}
            >
              <span className="dem-nav-title">{titleOf(t, i)}</span>
            </button>
          </li>
        ))}
      </ul>
      <TextField
        aria-label={label}
        placeholder={t("profile.add")}
        icon="plus"
        value={title}
        onChange={setTitle}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !title.trim() || e.nativeEvent.isComposing) return;
          const name = title.trim();
          setTitle("");
          void api
            .itemCreate(newItem({ typeId: type, title: name }))
            .then((made) => {
              itemsChanged();
              openItem(workspace, t, made, { kind: "temp" });
            })
            .catch(failed(t, label));
        }}
      />
    </section>
  );
}

export function ProfileView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const exp = items.filter((i) => i.typeId === "experience");
  const skills = items.filter((i) => i.typeId === "skill");
  const docs = items.filter((i) => i.typeId === "document");
  const make = (kind: DocKind) => {
    const sources = [...exp, ...skills];
    if (!sources.length) return showToast({ text: t("profile.empty") });
    void (async () => {
      const markdown = await buildDocument(t, kind, sources);
      const doc = await api.itemCreate(
        newItem({
          typeId: "document",
          title: t(`profile.doc.${kind}`),
          markdown,
          fields: JSON.stringify({ kind, generated_from: sources.map((s) => s.id) }),
        }),
      );
      itemsChanged();
      openItem(workspace, t, doc, { kind: "temp" });
    })().catch(failed(t, t(`profile.doc.${kind}`)));
  };
  return (
    <div className="dem-nav">
      <Section
        type="experience"
        label={t("profile.experience")}
        workspace={workspace}
        items={exp}
      />
      <Section type="skill" label={t("profile.skills")} workspace={workspace} items={skills} />
      <section>
        <h3 className="dem-nav-group">{t("profile.documents")}</h3>
        <ul className="dem-nav-list">
          {docs.map((i) => (
            <li key={i.id} className="dem-nav-row">
              <button
                type="button"
                className="dem-nav-open"
                onClick={() => openItem(workspace, t, i)}
              >
                <span className="dem-nav-title">{titleOf(t, i)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="dem-nav-tools">
          <Button size="sm" onPress={() => make("resume")}>
            {t("profile.make.resume")}
          </Button>
          <Button size="sm" onPress={() => make("cover")}>
            {t("profile.make.cover")}
          </Button>
        </div>
      </section>
    </div>
  );
}
