// 批注 (D4) beside the text, and 字符面板 for scripts no keyboard has (A6).
import { useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { EmptyState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import { failed, newItem } from "../actions";
import { useActiveNote } from "../active";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { patch } from "../model";

export function AnnotationsPanel() {
  const t = useT();
  const note = useActiveNote();
  const id = note?.id;
  const { data } = useLive<ItemView[]>(
    () =>
      id
        ? api
            .itemList({
              typeId: "annotation",
              states: ["active"],
              container: null,
              tag: null,
              order: "created",
              limit: null,
            })
            .then((all) => all.filter((a) => parseFields(a.fields).target === id))
        : Promise.resolve([]),
    [],
    [id],
  );
  if (!note) return null;
  if (!data.length) return <EmptyState icon="edit" title={t("annotations.none")} />;
  return (
    <ul className="dem-annotations">
      {data.map((a) => {
        const f = parseFields(a.fields);
        const quote = typeof f.quote === "string" ? f.quote : "";
        const text = typeof f.note === "string" ? f.note : "";
        return (
          <li key={a.id}>
            {quote && <blockquote>{quote}</blockquote>}
            <p>{text}</p>
            <span className="dem-nav-actions">
              <Button
                size="sm"
                variant="quiet"
                onPress={() =>
                  // Keeps a way back to the source (M7): the card names the item it came from.
                  void api
                    .itemCreate(
                      newItem({
                        typeId: "card",
                        title: quote || text,
                        fields: JSON.stringify({ front: quote || text, back: text, review: true }),
                        markdown: id ? `[[${note.title}]]\n` : null,
                      }),
                    )
                    .then(() => itemsChanged())
                    .catch(failed(t, t("annotations.toCard")))
                }
              >
                {t("annotations.toCard")}
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onPress={() =>
                  void api
                    .itemUpdate(a.id, patch({ state: "trashed" }))
                    .then(() => itemsChanged())
                    .catch(failed(t, t("annotations.remove")))
                }
              >
                {t("annotations.remove")}
              </Button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const BLOCKS = [
  { id: "tangut", from: 0x17000, to: 0x187f7 },
  { id: "tangutComponents", from: 0x18800, to: 0x18aff },
  { id: "khitan", from: 0x18b00, to: 0x18cff },
  { id: "nushu", from: 0x1b170, to: 0x1b2fb },
  { id: "cunei", from: 0x12000, to: 0x12399 },
  { id: "ipa", from: 0x0250, to: 0x02af },
];
const PAGE = 256;

export function CharsPanel() {
  const t = useT();
  const note = useActiveNote();
  const [block, setBlock] = useState("tangut");
  const [page, setPage] = useState(0);
  const [jump, setJump] = useState("");
  const b = BLOCKS.find((x) => x.id === block) ?? BLOCKS[0];
  if (!b) return null;
  const pages = Math.ceil((b.to - b.from + 1) / PAGE);
  const start = b.from + page * PAGE;
  const codes = Array.from({ length: Math.min(PAGE, b.to - start + 1) }, (_, i) => start + i);
  return (
    <div className="dem-chars">
      <Select
        aria-label={t("chars.block")}
        options={BLOCKS.map((x) => ({ id: x.id, label: t(`chars.block.${x.id}`) }))}
        selectedKey={block}
        onSelectionChange={(k) => {
          setBlock(String(k));
          setPage(0);
        }}
      />
      <TextField
        aria-label={t("chars.jump")}
        placeholder={t("chars.jump")}
        value={jump}
        onChange={setJump}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const code = parseInt(jump.replace(/^u\+/i, ""), 16);
          const hit = BLOCKS.find((x) => code >= x.from && code <= x.to);
          if (!hit) return;
          setBlock(hit.id);
          setPage(Math.floor((code - hit.from) / PAGE));
        }}
      />
      <div className="dem-chars-grid" lang="und" role="group" aria-label={t(`chars.block.${b.id}`)}>
        {codes.map((c) => {
          const ch = String.fromCodePoint(c);
          return (
            <button
              key={c}
              type="button"
              title={`U+${c.toString(16).toUpperCase()}`}
              disabled={!note?.insert}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => note?.insert?.(ch)}
            >
              {ch}
            </button>
          );
        })}
      </div>
      <div className="dem-nav-tools">
        <Button size="sm" variant="quiet" isDisabled={page === 0} onPress={() => setPage(page - 1)}>
          {t("action.back")}
        </Button>
        <span className="dem-nav-count">{`${page + 1}/${pages}`}</span>
        <Button
          size="sm"
          variant="quiet"
          isDisabled={page >= pages - 1}
          onPress={() => setPage(page + 1)}
        >
          {t("action.next")}
        </Button>
      </div>
    </div>
  );
}
