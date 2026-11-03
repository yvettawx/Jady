// 本次收获 (PRD D7, the French example in §2): what a learning chat turned up, for you to go
// through before anything is saved. A word that already has a card only gains this example: no
// second card, ever. Everything starts ticked; what you untick is simply not saved.

export interface HarvestWord {
  id: string;
  word: string;
  meaning: string;
  /** The sentence from the chat. */
  example: string;
}
export interface HarvestGrammar {
  id: string;
  title: string;
  note: string;
  /** Reference material, such as a conjugation table. */
  link?: { id: string; title: string };
}
export interface HarvestMistake {
  id: string;
  wrong: string;
  right: string;
  why: string;
  /** The 错误模式 it belongs to, if this has happened before. */
  pattern?: { id: string; name: string; times: number };
}
/** Unfinished, skipped or left open: goes to the 待补清单. */
export interface HarvestLoose {
  id: string;
  text: string;
}

export interface Harvest {
  summary: string;
  words: HarvestWord[];
  grammar: HarvestGrammar[];
  mistakes: HarvestMistake[];
  loose: HarvestLoose[];
}

/** Case, accents kept: in French they tell words apart. Articles do not. */
export const cardKey = (word: string) =>
  word
    .trim()
    .toLowerCase()
    .replace(/^(le|la|les|l'|un|une)\s*/u, "");

export interface HarvestPlan {
  /** New memory cards. */
  newCards: HarvestWord[];
  /** Cards that exist: only this example is added. */
  examples: { word: HarvestWord; card: string }[];
  grammar: HarvestGrammar[];
  mistakes: HarvestMistake[];
  loose: HarvestLoose[];
}

/** What saving would do, given what is unticked and which cards exist (key → card id). */
export function planHarvest(
  h: Harvest,
  unticked: ReadonlySet<string>,
  cards: ReadonlyMap<string, string>,
): HarvestPlan {
  const keep = <T extends { id: string }>(xs: T[]) => xs.filter((x) => !unticked.has(x.id));
  const plan: HarvestPlan = {
    newCards: [],
    examples: [],
    grammar: keep(h.grammar),
    mistakes: keep(h.mistakes),
    loose: keep(h.loose),
  };
  const seen = new Set<string>();
  for (const word of keep(h.words)) {
    const key = cardKey(word.word);
    const card = cards.get(key);
    if (card) plan.examples.push({ word, card });
    // The same word twice in one chat is still one card.
    else if (!seen.has(key)) {
      seen.add(key);
      plan.newCards.push(word);
    }
  }
  return plan;
}

export const planSize = (p: HarvestPlan) =>
  p.newCards.length + p.examples.length + p.grammar.length + p.mistakes.length + p.loose.length;
