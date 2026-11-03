// The launcher's standard sources (docs/05-design.md §4.2), built from plain data so the core
// (P1) feeds them: content and tags, scopes for `@`, types for `+`, and the two AI modes.
import { listedOutsideDirectory } from "../privacy/policy";
import { aiBlockedReason } from "../privacy/text";
import type { PrivacyLevel } from "../ui/Badge";
import type { IconName } from "../ui/icons";
import { matchTitle, type LauncherItem, type LauncherSource, type OpenHow } from "./sources";

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface ContentEntry {
  id: string;
  title: string;
  /** Where it lives, e.g. 语言 / 法语. */
  path: string;
  icon: IconName;
  tags: string[];
  privacy?: PrivacyLevel;
  /** Recently opened first when nothing is typed. */
  recent?: number;
}

export interface ScopeEntry {
  id: string;
  name: string;
  kind: "area" | "project" | "space";
}

export interface TypeEntry {
  id: string;
  name: string;
  icon: IconName;
}

/** Content by title or path, with pinyin initials; recent items when nothing is typed. */
export function contentSource(
  t: T,
  entries: () => ContentEntry[],
  open: (e: ContentEntry, how: OpenHow) => void,
): LauncherSource {
  return {
    id: "content",
    modes: ["search", "tag"],
    order: 0,
    limit: 8,
    search: (q, ctx) => {
      // 机密 items are found through 目录 only, never here.
      const scoped = entries().filter(
        (e) =>
          listedOutsideDirectory(e.privacy ?? "normal") && (!q.scope || e.path.includes(q.scope)),
      );
      const item = (e: ContentEntry, score: number, ranges: [number, number][] = []) =>
        ({
          id: `content:${e.id}`,
          group: t("launcher.group.content"),
          icon: e.icon,
          title: e.title,
          ranges,
          privacy: e.privacy,
          meta: e.path,
          score,
          run: (how) => (ctx.close(), open(e, how)),
        }) satisfies LauncherItem;
      if (q.mode === "tag")
        return scoped
          .filter((e) => e.tags.some((tag) => matchTitle(q.text, tag)))
          .map((e) => item(e, e.recent ?? 0));
      if (!q.text)
        return scoped
          .filter((e) => e.recent !== undefined)
          .sort((a, b) => (b.recent ?? 0) - (a.recent ?? 0))
          .map((e, i) => item(e, -i));
      return scoped.flatMap((e) => {
        const m = matchTitle(q.text, e.title, [e.path]);
        return m ? [item(e, m.score, m.ranges)] : [];
      });
    },
  };
}

/** `#求` lists the matching tags with how many items carry each; choosing one narrows to it. */
export function tagSource(t: T, entries: () => ContentEntry[]): LauncherSource {
  return {
    id: "tags",
    modes: ["tag"],
    order: -1,
    limit: 8,
    search: (q, ctx) => {
      const counts = new Map<string, number>();
      for (const e of entries()) {
        if (!listedOutsideDirectory(e.privacy ?? "normal")) continue;
        for (const tag of e.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      return [...counts].flatMap(([tag, n]) => {
        const m = matchTitle(q.text, tag);
        if (!m || q.text === tag) return [];
        return [
          {
            id: `tag:${tag}`,
            group: t("launcher.group.tags"),
            icon: "tag",
            title: `#${tag}`,
            ranges: m.ranges.map(([a, b]) => [a + 1, b + 1] as [number, number]),
            meta: t("launcher.count", { n }),
            score: m.score,
            complete: `#${tag}`,
            run: () => ctx.setInput(`#${tag}`),
          } satisfies LauncherItem,
        ];
      });
    },
  };
}

/** `@法` lists areas, projects and spaces; choosing one puts `@法语 ` in front. */
export function scopeSource(t: T, scopes: () => ScopeEntry[]): LauncherSource {
  const icon: Record<ScopeEntry["kind"], IconName> = {
    area: "folder",
    project: "kanban",
    space: "spaces",
  };
  return {
    id: "scopes",
    modes: ["scope"],
    order: 0,
    search: (q, ctx) =>
      scopes().flatMap((s) => {
        const m = matchTitle(q.text, s.name);
        if (!m) return [];
        return [
          {
            id: `scope:${s.id}`,
            group: t("launcher.group.scopes"),
            icon: icon[s.kind],
            title: s.name,
            ranges: m.ranges,
            meta: t(`launcher.scope.${s.kind}`),
            score: m.score,
            complete: `@${s.name} `,
            run: () => ctx.setInput(`@${s.name} `),
          } satisfies LauncherItem,
        ];
      }),
  };
}

/**
 * `+` (and ⌘N): with nothing typed, the types to choose from; with text, 放进收集箱 first,
 * or the type named by the first word (`+记忆卡 le quai 站台`) first.
 */
export function newSource(
  t: T,
  types: () => TypeEntry[],
  create: (type: TypeEntry | null, text: string) => void,
): LauncherSource {
  return {
    id: "new",
    modes: ["new"],
    order: 0,
    search: (q, ctx) => {
      const group = t("launcher.group.new");
      const all = types();
      if (!q.text)
        return [
          {
            id: "new:inbox",
            group,
            icon: "inbox",
            title: t("launcher.new.inbox"),
            score: 1,
            run: () => ctx.setInput("+"),
          },
          ...all.map((ty): LauncherItem => ({
            id: `new:${ty.id}`,
            group,
            icon: ty.icon,
            title: ty.name,
            complete: `+${ty.name} `,
            run: () => ctx.setInput(`+${ty.name} `),
          })),
        ];
      const [first = "", ...rest] = q.text.split(/\s+/);
      const named = all.find((ty) => ty.name === first);
      const body = named ? rest.join(" ") : q.text;
      const make = (ty: TypeEntry | null, score: number): LauncherItem => ({
        id: `new:${ty?.id ?? "inbox"}:make`,
        group,
        icon: ty?.icon ?? "inbox",
        title: ty
          ? t("launcher.new.as", { type: ty.name, text: body || "…" })
          : t("launcher.new.toInbox", { text: q.text }),
        score,
        run: () => {
          if (ty && !body) return;
          ctx.close();
          create(ty, ty ? body : q.text);
        },
      });
      return named
        ? [make(named, 2), make(null, 1)]
        : [make(null, 2), ...all.map((ty) => make(ty, 0))];
    },
  };
}

/** `?问题`: one item that turns into a small AI window; greyed in private content. */
export function askSource(t: T, ask: (question: string, scope?: string) => void): LauncherSource {
  return {
    id: "ask",
    modes: ["ask"],
    order: 0,
    search: (q, ctx) =>
      q.text
        ? [
            {
              id: "ask",
              group: t("launcher.mode.ask"),
              icon: "ai",
              title: q.text,
              meta: q.scope ? `@${q.scope}` : undefined,
              disabledReason: aiBlockedReason(t, ctx.privacy),
              run: () => (ctx.close(), ask(q.text, q.scope)),
            },
          ]
        : [],
  };
}

/** `?/`: the AI quick commands (§4.2); the same names as the editor's AI buttons. */
export function aiCommandSource(t: T, run: (cmd: string, arg: string) => void): LauncherSource {
  const CMDS = ["summary", "organize", "quiz", "explain"] as const;
  return {
    id: "ai-commands",
    modes: ["ai-command"],
    order: 0,
    search: (q, ctx) => {
      const [first = "", ...rest] = q.text.split(/\s+/);
      return CMDS.flatMap((c) => {
        const name = t(`launcher.ai.${c}`);
        const m = matchTitle(first, name);
        if (!m) return [];
        return [
          {
            id: `ai:${c}`,
            group: t("launcher.mode.ai-command"),
            icon: "ai",
            title: `${name}${rest.length ? ` ${rest.join(" ")}` : ""}`,
            ranges: m.ranges,
            meta: t(`launcher.ai.${c}.hint`),
            score: m.score,
            complete: `?/${name} `,
            disabledReason: aiBlockedReason(t, ctx.privacy),
            run: () => (ctx.close(), run(c, rest.join(" "))),
          } satisfies LauncherItem,
        ];
      });
    },
  };
}
