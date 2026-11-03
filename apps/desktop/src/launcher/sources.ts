// Where launcher results come from (docs/05-design.md §4.4): sources register here, the same
// way commands and panels do, so the core's search (P1) and plugins add results without the
// launcher knowing about them. Commands are a built-in source.
import { commands, shortcutOf } from "../shell/commands";
import type { PrivacyLevel } from "../ui/Badge";
import type { IconName } from "../ui/icons";
import { match, type Match } from "./match";
import type { LauncherMode, LauncherQuery } from "./query";

export type OpenHow = "open" | "tab" | "split";

export interface LauncherItem {
  id: string;
  /** Heading of the group it shows under (内容, 命令…). */
  group: string;
  icon?: IconName;
  title: string;
  /** Characters of the title to highlight. */
  ranges?: [number, number][];
  /** The item's own privacy level, shown as its mark. */
  privacy?: PrivacyLevel;
  /** Quiet text on the right: a path, a count. */
  meta?: string;
  shortcut?: string;
  /** Greyed with the reason shown (e.g. private content and AI, §5.6). */
  disabledReason?: string;
  /** What Tab puts into the input (a command name, `@法语 `). */
  complete?: string;
  /** Higher first, across sources in the same group. */
  score?: number;
  run: (how: OpenHow) => void;
}

export interface LauncherContext {
  /** The level of the content the launcher was opened from; AI items follow it (§5.6). */
  privacy: PrivacyLevel;
  /** Puts text into the input (for items that lead somewhere, like a scope). */
  setInput: (text: string) => void;
  close: () => void;
}

export interface LauncherSource {
  id: string;
  modes: LauncherMode[];
  /** Lower comes first: content (0) before commands (10), as §4.2 asks. */
  order: number;
  /** At most this many results, best first (default: all). */
  limit?: number;
  search: (q: LauncherQuery, ctx: LauncherContext) => LauncherItem[];
}

const sources = new Map<string, LauncherSource>();
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((f) => f());
};

export function registerSource(s: LauncherSource): () => void {
  sources.set(s.id, s);
  changed();
  return () => {
    if (sources.get(s.id) !== s) return;
    sources.delete(s.id);
    changed();
  };
}

/** For useSyncExternalStore: an open launcher re-searches when sources come or go. */
export const subscribeSources = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
export const sourcesVersion = () => version;

/** All results for a query, grouped in source order, best first within each source. */
export function searchAll(q: LauncherQuery, ctx: LauncherContext): LauncherItem[] {
  return [...sources.values()]
    .filter((s) => s.modes.includes(q.mode))
    .sort((a, b) => a.order - b.order)
    .flatMap((s) =>
      s
        .search(q, ctx)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, s.limit ?? Infinity),
    );
}

/** Matches an item's title (and optional aliases); null if neither matches. */
export function matchTitle(query: string, title: string, aliases: string[] = []): Match | null {
  const own = match(query, title);
  if (own) return own;
  for (const a of aliases) {
    const m = match(query, a);
    // Found only by its path or another name: well below anything found by its title.
    if (m) return { score: m.score - 400, ranges: [] };
  }
  return null;
}

/** The registered commands, by name; `>切换空间 学` lists the command's options matching 学. */
export function commandSource(groupLabel: string): LauncherSource {
  return {
    id: "commands",
    modes: ["search", "command"],
    order: 10,
    limit: 8,
    search: (q, ctx) => {
      const out: LauncherItem[] = [];
      for (const c of commands()) {
        if (c.hidden) continue;
        // An argument: the text starts with the whole command name and a space.
        if (c.options && c.runWith && q.text.startsWith(`${c.title} `)) {
          const arg = q.text.slice(c.title.length + 1);
          for (const o of c.options()) {
            const m = matchTitle(arg, o.label);
            if (!m) continue;
            out.push({
              id: `${c.id}:${o.id}`,
              group: groupLabel,
              icon: c.icon,
              title: `${c.title} ${o.label}`,
              ranges: m.ranges.map(([a, b]) => [a + c.title.length + 1, b + c.title.length + 1]),
              score: m.score,
              run: () => (ctx.close(), c.runWith?.(o.id)),
            });
          }
          continue;
        }
        const m = matchTitle(q.text, c.title);
        if (!m) continue;
        out.push({
          id: c.id,
          group: groupLabel,
          icon: c.icon,
          title: c.title,
          ranges: m.ranges,
          shortcut: shortcutOf(c.id),
          score: m.score,
          complete: c.options ? `>${c.title} ` : undefined,
          run: () => {
            if (c.options) ctx.setInput(`>${c.title} `);
            else {
              ctx.close();
              c.run();
            }
          },
        });
      }
      // In plain search, commands follow content and only show when they match something.
      return q.mode === "search" && !q.text ? [] : out;
    },
  };
}
