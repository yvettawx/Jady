// 本次收获 (D7): what the closing turn sends back, ready for the sheet; and what saving does.
import type { Harvest, HarvestPlan } from "../../ai/harvest";
import type { ItemView } from "../../bindings";
import { newItem } from "../actions";
import { api, itemsChanged, parseFields } from "../api";
import { patch } from "../model";
import { library } from "../store";
import { blockOf } from "./chats";

interface RawHarvest {
  summary?: string;
  words?: { word: string; meaning: string; example?: string }[];
  grammar?: { title: string; note?: string }[];
  mistakes?: { wrong: string; right: string; why?: string }[];
  loose?: string[];
}

export function parseHarvest(answer: string): Harvest | null {
  const h = blockOf<RawHarvest>(answer, "harvest");
  if (!h) return null;
  return {
    summary: h.summary ?? "",
    words: (h.words ?? []).map((w, i) => ({
      id: `w${i}`,
      word: w.word,
      meaning: w.meaning,
      example: w.example ?? "",
    })),
    grammar: (h.grammar ?? []).map((g, i) => ({ id: `g${i}`, title: g.title, note: g.note ?? "" })),
    mistakes: (h.mistakes ?? []).map((m, i) => ({
      id: `m${i}`,
      wrong: m.wrong,
      right: m.right,
      why: m.why ?? "",
      pattern: patternFor(m.why ?? ""),
    })),
    loose: (h.loose ?? []).map((text, i) => ({ id: `l${i}`, text })),
  };
}

function patternFor(why: string) {
  const known = library().items.find((i) => i.typeId === "error_pattern" && i.title === why);
  if (!known) return undefined;
  const times = Number(parseFields(known.fields).times) || 1;
  return { id: known.id, name: known.title ?? "", times };
}

/** Cards that exist, by the word on their front. */
export function cardIndex(key: (w: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of library().items) {
    if (i.typeId !== "card") continue;
    const front = parseFields(i.fields).front;
    const word = typeof front === "string" && front ? front : i.title;
    if (word) out.set(key(word), i.id);
  }
  return out;
}

/** Saves what was kept. Returns what to take back if the user undoes it. */
export async function saveHarvest(
  plan: HarvestPlan,
  container: string | null,
  source: "aiMemory" | "aiSearch" = "aiMemory",
): Promise<{ created: ItemView[] }> {
  const created: ItemView[] = [];
  const mark = async (item: ItemView) => {
    created.push(item);
    await api.itemUpdate(
      item.id,
      patch({
        source: { origin: source, needsCheck: false, conflict: false, recheckOn: null, refs: [] },
      }),
    );
  };
  for (const w of plan.newCards) {
    await mark(
      await api.itemCreate(
        newItem({
          typeId: "card",
          title: w.word,
          container,
          // Cards from a learning chat take part in review by default (C1).
          fields: JSON.stringify({ front: w.word, back: w.meaning, review: true }),
          markdown: w.example ? `${w.example}\n` : null,
        }),
      ),
    );
  }
  for (const { word, card } of plan.examples) {
    if (word.example) await api.bodyAppend(card, word.example);
  }
  for (const g of plan.grammar) {
    await mark(
      await api.itemCreate(
        newItem({
          typeId: "note",
          title: g.title,
          container,
          markdown: g.note ? `${g.note}\n` : null,
        }),
      ),
    );
  }
  for (const m of plan.mistakes) {
    const line = `${m.wrong} → ${m.right}`;
    if (m.pattern) {
      await api.itemUpdate(
        m.pattern.id,
        patch({ fields: JSON.stringify({ times: m.pattern.times + 1 }) }),
      );
      await api.bodyAppend(m.pattern.id, line);
    } else {
      await mark(
        await api.itemCreate(
          newItem({
            typeId: "error_pattern",
            title: m.why || line,
            container,
            fields: JSON.stringify({ times: 1 }),
            markdown: `${line}\n`,
          }),
        ),
      );
    }
  }
  itemsChanged();
  return { created };
}
