/* eslint-disable react-refresh/only-export-components -- the parts share helpers with the view that starts them */
// 学习 (M7): the parts on real data. Review, mastery and the schedule need no AI at all; lessons,
// conversation and marking go through a chat with the mode saying what it is.
import { useEffect, useMemo, useState } from "react";
import type { DueCard, ItemView, MasteryGroup, CodeRun } from "../../bindings";
import { useT } from "../../i18n/context";
import { TalkPage, type TalkTurn } from "../../learn/TalkPage";
import { ReviewSession } from "../../learn/ReviewSession";
import type { ReviewCard, ReviewEntry } from "../../learn/review";
import { reviewedBy, type Correction, type DueWord } from "../../learn/talk";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import { showToast } from "../../ui/toast";
import type { WorkspaceApi } from "../../workspace/api";
import type { PanelProps } from "../../workspace/registry";
import { createAndOpen, failed, newItem, openItem } from "../actions";
import { blockOf, endChat, getChat, sendChat, startChat, useChats } from "../ai/chats";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { patch, titleOf } from "../model";
import { useLibrary } from "../store";
import { dockChat, finishChat } from "./AiPanels";

export const REVIEW_PANEL = "learn-review";
export const TALK_PANEL = "learn-talk";
export const PRACTICE_PANEL = "learn-practice";
export const RECITE_PANEL = "learn-recite";
export const DERIVE_PANEL = "learn-derive";
export const MASTERY_PANEL = "learn-mastery";

const days = (d: number, t: (k: string, v?: Record<string, string | number>) => string) =>
  d < 1 / 24
    ? t("learn.minutes", { n: Math.max(1, Math.round(d * 1440)) })
    : d < 1
      ? t("learn.hours", { n: Math.round(d * 24) })
      : d < 60
        ? t("learn.days", { n: Math.round(d) })
        : t("learn.months", { n: Math.round(d / 30) });

const RATINGS = ["again", "hard", "good", "easy"] as const;

export function ReviewPanel({ workspace, tabId }: PanelProps) {
  const t = useT();
  const [queue, setQueue] = useState<DueCard[] | null>(null);
  const [run, setRun] = useState(0);
  useEffect(() => {
    let alive = true;
    void api.reviewQueue(100).then((q) => alive && setQueue(q));
    return () => {
      alive = false;
    };
  }, [run]);
  const cards = useMemo<ReviewCard[]>(
    () => (queue ?? []).map((c) => ({ id: c.id, front: c.front, back: c.back })),
    [queue],
  );
  if (!queue) return null;
  if (!queue.length)
    return (
      <EmptyState
        icon="card"
        title={t("learn.review.none")}
        description={t("learn.review.noneHint")}
      />
    );
  const interval = new Map(queue.map((c) => [c.id, c.intervals]));
  const seen = new Set<number>();
  return (
    <ReviewSession
      key={run}
      cards={cards}
      intervalOf={(card, rating) => days(interval.get(card.id)?.[RATINGS.indexOf(rating)] ?? 1, t)}
      onLog={(entries: ReviewEntry[]) => {
        entries.forEach((e, i) => {
          if (seen.has(i)) return;
          seen.add(i);
          void api
            .reviewRecord({
              item: e.card,
              rating: e.rating,
              confidence: e.confidence,
              peeked: e.peeked,
              durationMs: Math.min(e.durationMs, 3_600_000),
              context: e.context,
            })
            .catch(failed(t, t("learn.review")));
        });
      }}
      onDone={() => {
        itemsChanged();
        workspace.close(tabId);
        setRun((n) => n + 1);
      }}
    />
  );
}

/** What corrections came with an answer. */
function correctionsOf(answer: string, turn: string): Correction[] {
  const list =
    blockOf<{ wrong: string; right: string; why?: string }[]>(answer, "corrections") ?? [];
  return list.map((c, i) => ({
    id: `${turn}-${i}`,
    turn,
    wrong: c.wrong,
    right: c.right,
    why: c.why ?? "",
  }));
}

export function TalkPanel({ params, tabId, workspace }: PanelProps) {
  const t = useT();
  const chatId = String(params.chat ?? "");
  const [turns, setTurns] = useState<TalkTurn[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [due, setDue] = useState<DueWord[]>([]);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const chats = useChats();
  const chat = chats.find((c) => c.id === chatId);
  useEffect(() => {
    void api.reviewQueue(12).then((q) => setDue(q.map((c) => ({ id: c.id, word: c.front }))));
  }, []);
  if (!chat) return <EmptyState icon="chat" title={t("ai.chat.ended")} />;
  const strip = (answer: string) => answer.replace(/```corrections[\s\S]*$/, "").trim();
  return (
    <TalkPage
      title={chat.title}
      turns={turns}
      corrections={corrections}
      due={due}
      reviewed={reviewed}
      typing={chat.running}
      onSend={(text) => {
        const id = `t${turns.length}`;
        setTurns((all) => [...all, { id, who: "me", text }]);
        const words =
          due.length && !turns.length
            ? `${t("learn.talk.dueHint")} ${due.map((d) => d.word).join(", ")}\n\n`
            : "";
        void sendChat(chatId, `${words}${text}`, "").then((answer) => {
          const fixes = correctionsOf(answer, id);
          setCorrections((all) => [...all, ...fixes]);
          setTurns((all) => [...all, { id: `${id}-ai`, who: "partner", text: strip(answer) }]);
          // Used correctly, and not the thing just corrected, counts as reviewed (C6).
          const hit = reviewedBy(text, due, reviewed, fixes);
          if (hit.length) {
            setReviewed((old) => new Set([...old, ...hit.map((h) => h.id)]));
            for (const h of hit)
              void api.reviewRecord({
                item: h.id,
                rating: "good",
                confidence: null,
                peeked: false,
                durationMs: 0,
                context: "chat",
              });
          }
        });
      }}
      onEnd={() => {
        const live = getChat(chatId);
        workspace.close(tabId);
        if (live)
          void finishChat({ ...live, messages: [{ id: "x", kind: "me", text: "" }] }, workspace, t);
      }}
    />
  );
}

export async function startTalk(workspace: WorkspaceApi, title: string, container: string | null) {
  const chat = await startChat({ session: "plain", mode: "talk", title, container });
  workspace.open({ contentId: `talk:${chat}`, title, component: TALK_PANEL, params: { chat } });
}

export async function startLesson(
  workspace: WorkspaceApi,
  t: (k: string, v?: Record<string, string | number>) => string,
  mode: "lecture" | "explain",
  item: ItemView,
) {
  const title = t(`learn.${mode}.title`, { title: titleOf(t, item) });
  const chat = await startChat({ session: "plain", mode, title, container: item.container });
  dockChat(workspace, chat, title);
  void sendChat(chat, t(`learn.${mode}.first`, { title: titleOf(t, item), id: item.id }));
}

/** One attempt at problems: with AI marking if it is set up, by hand if not (M7). */
export function PracticePanel({ params, workspace }: PanelProps) {
  const t = useT();
  const { items } = useLibrary();
  const scope = typeof params.scope === "string" ? params.scope : null;
  const timed = typeof params.minutes === "number" ? params.minutes : null;
  const [order] = useState(() => Math.random());
  // Different kinds interleaved (C7): a stable shuffle, not sorted by kind.
  const list = useMemo(
    () =>
      items
        .filter((i) => i.typeId === "problem" && (!scope || i.container === scope))
        .map((i) => ({
          i,
          k: (parseInt(i.id.replace(/\D/g, "").slice(-6) || "0", 10) * (order + 1)) % 997,
        }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.i),
    [items, scope, order],
  );
  const [at, setAt] = useState(0);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [run, setRun] = useState<CodeRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [right, setRight] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    if (timed == null) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [timed]);
  const left =
    timed == null ? null : Math.max(0, timed * 60 - Math.floor((now - startedAt) / 1000));
  const problem = list[at];
  const { data: body } = useLive<string>(
    () => (problem ? api.bodyMarkdown(problem.id) : Promise.resolve("")),
    "",
    [problem?.id],
  );
  if (!problem || left === 0)
    return (
      <EmptyState
        icon="check"
        title={
          list.length
            ? t("learn.practice.done", { right, all: Math.min(at, list.length) })
            : t("learn.practice.none")
        }
      />
    );
  const fields = parseFields(problem.fields);
  const language = typeof fields.language === "string" ? fields.language : "";
  const cases = parseCases(typeof fields.tests === "string" ? fields.tests : "");
  const record = (rating: "again" | "good", mistake: string) => {
    void (async () => {
      await api.reviewRecord({
        item: problem.id,
        rating,
        confidence: null,
        peeked: false,
        durationMs: Math.min(Date.now() - startedAt, 3_600_000),
        context: "problem",
      });
      if (rating === "good") setRight((n) => n + 1);
      else {
        await api.itemUpdate(
          problem.id,
          patch({
            fields: JSON.stringify({ wrong: (Number(fields.wrong) || 0) + 1, review: true }),
          }),
        );
        // A mistake of a kind seen before counts up; a new kind starts a pattern (C8).
        if (mistake) {
          const known = items.find((i) => i.typeId === "error_pattern" && i.title === mistake);
          if (known)
            await api.itemUpdate(
              known.id,
              patch({
                fields: JSON.stringify({
                  times: (Number(parseFields(known.fields).times) || 1) + 1,
                }),
              }),
            );
          else
            await api.itemCreate(
              newItem({
                typeId: "error_pattern",
                title: mistake,
                container: problem.container,
                fields: JSON.stringify({ times: 1 }),
              }),
            );
        }
      }
      itemsChanged();
    })().catch(failed(t, t("learn.practice")));
  };
  const next = () => {
    setAt((n) => n + 1);
    setAnswer("");
    setFeedback(null);
    setCheck(null);
    setRun(null);
  };
  const submit = () => {
    setBusy(true);
    void (async () => {
      let compiled = "";
      if (language) {
        const r = await api.codeCheck(language, answer);
        if (r.ran) {
          compiled = r.ok ? t("learn.practice.compiled") : r.output;
          setCheck(compiled);
        }
      }
      const status = await api.aiStatus();
      if (!status.current) {
        setFeedback(t("learn.practice.noAi"));
        return;
      }
      const chat = await startChat({
        session: "plain",
        mode: "judge",
        title: titleOf(t, problem),
        container: problem.container,
      });
      const said = await sendChat(
        chat,
        `${t("learn.practice.prompt", { id: problem.id })}\n\n${answer}${compiled ? `\n\n${t("learn.practice.compilerSaid")}\n${compiled}` : ""}`,
      );
      const verdict = blockOf<{ correct?: boolean; mistake?: string }>(said, "verdict");
      setFeedback(said.replace(/```verdict[\s\S]*$/, "").trim());
      await endChat(chat, null, []);
      if (verdict) record(verdict.correct ? "good" : "again", verdict.mistake ?? "");
    })()
      .catch(failed(t, t("learn.practice")))
      .finally(() => setBusy(false));
  };
  return (
    <div className="dem-flow" data-focus-home="page" tabIndex={-1}>
      <header className="dem-flow-head dem-flow-head-row">
        <h1>{titleOf(t, problem)}</h1>
        <span className="dem-nav-count">{`${at + 1}/${list.length}`}</span>
        {left !== null && (
          <span className="dem-practice-timer">
            {`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
          </span>
        )}
      </header>
      <div className="dem-flow-body">
        <p className="dem-practice-body">{body}</p>
        <textarea
          className="dem-flow-text"
          data-code={language ? "" : undefined}
          aria-label={t("learn.practice.answer")}
          placeholder={t("learn.practice.answer")}
          spellCheck={false}
          value={answer}
          disabled={feedback !== null}
          onChange={(e) => setAnswer(e.target.value)}
        />
        {check && <pre className="dem-practice-check">{check}</pre>}
        {run && (
          <ul className="dem-practice-cases">
            {run.state !== "ran" && <RunProblem run={run} />}
            {run.results.map((r, i) => (
              <li key={i} data-verdict={r.verdict}>
                <strong>{t(`learn.run.${r.verdict}`)}</strong>
                {r.verdict !== "pass" && (
                  <code>
                    {t("learn.run.detail", { input: r.input, expected: r.expected, got: r.got })}
                  </code>
                )}
              </li>
            ))}
          </ul>
        )}
        {feedback && <p className="dem-practice-feedback">{feedback}</p>}
      </div>
      <footer className="dem-flow-foot">
        {feedback === null ? (
          <span className="dem-nav-actions">
            {language && cases.length > 0 && (
              <Button
                isDisabled={busy || !answer.trim()}
                onPress={() =>
                  void api
                    .codeRun(language, answer, cases)
                    .then(setRun)
                    .catch(failed(t, t("learn.run")))
                }
              >
                {t("learn.run")}
              </Button>
            )}
            <Button variant="primary" isDisabled={busy || !answer.trim()} onPress={submit}>
              {t("learn.practice.submit")}
            </Button>
          </span>
        ) : (
          <span className="dem-nav-actions">
            {feedback === t("learn.practice.noAi") && (
              <>
                <Button
                  onPress={() => {
                    record("good", "");
                    next();
                  }}
                >
                  {t("learn.practice.iWasRight")}
                </Button>
                <Button
                  onPress={() => {
                    record("again", "");
                    next();
                  }}
                >
                  {t("learn.practice.iWasWrong")}
                </Button>
              </>
            )}
            {feedback !== t("learn.practice.noAi") && (
              <Button variant="primary" onPress={next}>
                {t("action.next")}
              </Button>
            )}
          </span>
        )}
        <Button variant="quiet" onPress={() => openItem(workspace, t, problem)}>
          {t("learn.practice.open")}
        </Button>
      </footer>
    </div>
  );
}

/** 渐进背诵 (C6): a line at a time, more hidden each round; each line counts by itself. */
/** One test case a line: `input => expected`, with `\\n` for a line break. */
export function parseCases(text: string): { input: string; expected: string }[] {
  const un = (s: string) => s.trim().replace(/\\n/g, "\n");
  return text.split("\n").flatMap((line) => {
    const at = line.indexOf("=>");
    return at < 0 ? [] : [{ input: un(line.slice(0, at)), expected: un(line.slice(at + 2)) }];
  });
}

/**
 * 推导重建 (C6): the earlier lines stay, the next one is hidden. Write it yourself, then compare and
 * say how it went; each step is reviewed like a line of a recitation.
 */
export function DerivePanel({ params }: PanelProps) {
  const t = useT();
  const id = String(params.item ?? "");
  const { data: text } = useLive<string>(() => api.bodyMarkdown(id), "", [id]);
  const steps = useMemo(
    () =>
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    [text],
  );
  const [at, setAt] = useState(1);
  const [attempt, setAttempt] = useState("");
  const [shown, setShown] = useState(false);
  const [missed, setMissed] = useState(0);
  if (!steps.length) return <EmptyState icon="read" title={t("learn.recite.empty")} />;
  const rate = (rating: "again" | "good") => {
    void api
      .reviewRecord({
        item: `${id}#${at}`,
        rating,
        confidence: null,
        peeked: false,
        durationMs: 0,
        context: "derive",
      })
      .catch(failed(t, t("learn.derive")));
    if (rating === "again") setMissed((n) => n + 1);
    setAt((n) => n + 1);
    setAttempt("");
    setShown(false);
  };
  const done = at >= steps.length;
  return (
    <div className="dem-flow" data-focus-home="page" tabIndex={-1}>
      <header className="dem-flow-head dem-flow-head-row">
        <h1>{t("learn.derive")}</h1>
        <span className="dem-nav-count">{`${Math.min(at, steps.length)}/${steps.length}`}</span>
      </header>
      <div className="dem-flow-body">
        <ol className="dem-derive">
          {steps.slice(0, at).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {done ? (
          <p className="dem-practice-feedback">{t("learn.derive.done", { n: missed })}</p>
        ) : (
          <>
            <textarea
              className="dem-flow-text"
              aria-label={t("learn.derive.next")}
              placeholder={t("learn.derive.next")}
              value={attempt}
              readOnly={shown}
              onChange={(e) => setAttempt(e.target.value)}
            />
            {shown && <p className="dem-practice-feedback">{steps[at]}</p>}
          </>
        )}
      </div>
      {!done && (
        <footer className="dem-flow-foot">
          {shown ? (
            <span className="dem-nav-actions">
              <Button onPress={() => rate("again")}>{t("learn.practice.iWasWrong")}</Button>
              <Button variant="primary" onPress={() => rate("good")}>
                {t("learn.practice.iWasRight")}
              </Button>
            </span>
          ) : (
            <Button variant="primary" onPress={() => setShown(true)}>
              {t("learn.derive.compare")}
            </Button>
          )}
        </footer>
      )}
    </div>
  );
}

export function RecitePanel({ params }: PanelProps) {
  const t = useT();
  const id = String(params.item ?? "");
  const { data: text } = useLive<string>(() => api.bodyMarkdown(id), "", [id]);
  const lines = useMemo(
    () =>
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    [text],
  );
  const [round, setRound] = useState(0);
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const { data: due } = useLive<boolean[]>(
    () => api.reciteDue(id, lines.length),
    [],
    [id, lines.length],
  );
  const hidden = (i: number) => (i + round) % 3 !== 0 || round >= 3;
  const rate = (i: number, rating: "again" | "good") =>
    void api
      .reviewRecord({
        item: `${id}#${i}`,
        rating,
        confidence: null,
        peeked: false,
        durationMs: 0,
        context: "recite",
      })
      .then(() => setShown((s) => new Set(s).add(i)))
      .catch(failed(t, t("learn.recite")));
  if (!lines.length) return <EmptyState icon="read" title={t("learn.recite.empty")} />;
  return (
    <div className="dem-flow" data-focus-home="page" tabIndex={-1}>
      <header className="dem-flow-head dem-flow-head-row">
        <h1>{t("learn.recite")}</h1>
        <Button
          size="sm"
          onPress={() => {
            setRound((r) => r + 1);
            setShown(new Set());
          }}
        >
          {t("learn.recite.harder")}
        </Button>
      </header>
      <ol className="dem-recite dem-flow-body">
        {lines.map((line, i) => (
          <li key={i} data-due={due[i] || undefined}>
            {hidden(i) && !shown.has(i) ? (
              <>
                <button
                  type="button"
                  className="dem-recite-cover"
                  aria-label={t("learn.recite.show")}
                  onClick={() => setShown((s) => new Set(s).add(i))}
                >
                  {line.replace(/\S/g, "＿").slice(0, 40)}
                </button>
              </>
            ) : (
              <span>{line}</span>
            )}
            {hidden(i) && shown.has(i) && (
              <span className="dem-nav-actions">
                <Button size="sm" variant="quiet" onPress={() => rate(i, "good")}>
                  {t("learn.rating.good")}
                </Button>
                <Button size="sm" variant="quiet" onPress={() => rate(i, "again")}>
                  {t("learn.rating.again")}
                </Button>
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function MasteryBars({ limit }: { limit?: number }) {
  const t = useT();
  const { tree } = useLibrary();
  const { data } = useLive<MasteryGroup[]>(() => api.masteryOverview(), []);
  const names = new Map(tree.map((n) => [n.id, n.title ?? ""]));
  const rows = data
    .filter((g) => g.kind === "tag" || names.has(g.key))
    .sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0))
    .slice(0, limit ?? 200);
  if (!rows.length) return <p className="dem-widget-empty">{t("learn.mastery.none")}</p>;
  return (
    <ul className="dem-mastery">
      {rows.map((g) => (
        <li key={`${g.kind}:${g.key}`}>
          <span className="dem-nav-title">{g.kind === "tag" ? `#${g.key}` : names.get(g.key)}</span>
          <span className="dem-nav-count">{`${Math.round((g.mastery ?? 0) * 100)}%`}</span>
          <span className="dem-okr-bar" aria-hidden>
            <i style={{ width: `${(g.mastery ?? 0) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function MasteryPanel() {
  const t = useT();
  return (
    <div className="dem-flow" data-focus-home="page" tabIndex={-1}>
      <header className="dem-flow-head">
        <h1>{t("learn.mastery")}</h1>
      </header>
      <div className="dem-flow-body">
        <MasteryBars />
      </div>
    </div>
  );
}

export const MasteryWidget = () => <MasteryBars limit={6} />;

/** 学习 in the leftmost bar: what is due, how it stands, what to do. */
export function LearnView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const { data: due } = useLive<DueCard[]>(() => api.reviewQueue(500), []);
  const { data: redo } = useLive<DueCard[]>(() => api.practiceQueue(500), []);
  const projects = items.filter((i) => i.typeId === "learning_project");
  const patterns = items
    .filter((i) => i.typeId === "error_pattern")
    .sort(
      (a, b) =>
        (Number(parseFields(b.fields).times) || 0) - (Number(parseFields(a.fields).times) || 0),
    );
  const [topic, setTopic] = useState("");
  return (
    <div className="dem-nav">
      <div className="dem-nav-tools dem-nav-tools-wrap">
        <Button
          size="sm"
          variant="primary"
          icon="card"
          isDisabled={!due.length}
          onPress={() =>
            workspace.open({
              contentId: REVIEW_PANEL,
              title: t("learn.review"),
              component: REVIEW_PANEL,
            })
          }
        >
          {t("learn.review.count", { n: due.length })}
        </Button>
        <Button
          size="sm"
          onPress={() =>
            workspace.open({
              contentId: PRACTICE_PANEL,
              title: t("learn.practice"),
              component: PRACTICE_PANEL,
              params: {},
            })
          }
        >
          {redo.length ? t("learn.practice.count", { n: redo.length }) : t("learn.practice")}
        </Button>
        <Button
          size="sm"
          onPress={() =>
            workspace.open({
              contentId: MASTERY_PANEL,
              title: t("learn.mastery"),
              component: MASTERY_PANEL,
            })
          }
        >
          {t("learn.mastery")}
        </Button>
      </div>
      <TextField
        aria-label={t("learn.talk.topic")}
        placeholder={t("learn.talk.topic")}
        icon="chat"
        value={topic}
        onChange={setTopic}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !topic.trim() || e.nativeEvent.isComposing) return;
          const title = topic.trim();
          setTopic("");
          void startTalk(workspace, title, null).catch(failed(t, t("learn.talk.topic")));
        }}
      />
      <h3 className="dem-nav-group">{t("learn.projects")}</h3>
      <ul className="dem-nav-list">
        {projects.map((p) => (
          <li key={p.id} className="dem-nav-row">
            <button
              type="button"
              className="dem-nav-open"
              onClick={() => openItem(workspace, t, p)}
            >
              <span className="dem-nav-title">{titleOf(t, p)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="dem-nav-tools">
        <Button
          size="sm"
          variant="quiet"
          icon="plus"
          onPress={() =>
            void createAndOpen(workspace, t, { typeId: "learning_project" }).catch(
              failed(t, t("learn.projects")),
            )
          }
        >
          {t("learn.projects.new")}
        </Button>
      </div>
      {patterns.length > 0 && <h3 className="dem-nav-group">{t("learn.patterns")}</h3>}
      <ul className="dem-nav-list">
        {patterns.slice(0, 8).map((p) => (
          <li key={p.id} className="dem-nav-row">
            <button
              type="button"
              className="dem-nav-open"
              onClick={() => openItem(workspace, t, p)}
            >
              <span className="dem-nav-title">{titleOf(t, p)}</span>
              <span className="dem-nav-count">{String(parseFields(p.fields).times ?? 1)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** C5: what suits this aim and stage. Data, to change as it proves wrong. */
const METHODS: Record<string, Record<string, string[]>> = {
  speak: {
    new: ["lecture", "talk"],
    learning: ["talk", "review"],
    consolidating: ["talk"],
    fluent: ["talk"],
  },
  read: {
    new: ["lecture", "read"],
    learning: ["read", "review"],
    consolidating: ["read"],
    fluent: ["read"],
  },
  exam: {
    new: ["lecture", "practice"],
    learning: ["practice", "review"],
    consolidating: ["exam", "practice"],
    fluent: ["exam"],
  },
  know: {
    new: ["lecture"],
    learning: ["explain", "review"],
    consolidating: ["explain"],
    fluent: ["explain"],
  },
};

/** What a learning project's page offers (C3, C4, C5, C9). */
export function ProjectLearn({
  item,
  workspace,
  onTask,
}: {
  item: ItemView;
  workspace: WorkspaceApi;
  onTask: (task: "sprint" | "questions") => void;
}) {
  const t = useT();
  const f = parseFields(item.fields);
  const aim = typeof f.aim === "string" ? f.aim : "know";
  const { data: groups } = useLive<MasteryGroup[]>(() => api.masteryOverview(), []);
  const here = groups.find((g) => g.kind === "container" && g.key === item.id);
  const stage = here?.stage ?? "new";
  const suggested = METHODS[aim]?.[stage] ?? [];
  const deadline = typeof f.deadline === "string" ? f.deadline : "";
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const over = !!deadline && deadline < today;
  const run = (what: string) => {
    switch (what) {
      case "lecture":
      case "explain":
        return void startLesson(workspace, t, what, item).catch(
          failed(t, t(`learn.method.${what}`)),
        );
      case "talk":
        return void startTalk(workspace, titleOf(t, item), item.id).catch(
          failed(t, t("learn.method.talk")),
        );
      case "review":
        return void workspace.open({
          contentId: REVIEW_PANEL,
          title: t("learn.review"),
          component: REVIEW_PANEL,
        });
      case "exam":
        return void workspace.open({
          contentId: `${PRACTICE_PANEL}:exam:${item.id}`,
          title: t("learn.method.exam"),
          component: PRACTICE_PANEL,
          params: { scope: item.id, minutes: 30 },
        });
      case "practice":
        return void workspace.open({
          contentId: `${PRACTICE_PANEL}:${item.id}`,
          title: t("learn.method.practice"),
          component: PRACTICE_PANEL,
          params: { scope: item.id },
        });
      case "read":
        return showToast({ text: t("learn.method.read.hint") });
    }
  };
  const all = ["lecture", "talk", "explain", "practice", "exam", "review"];
  return (
    <div className="dem-extras">
      <section className="dem-extras-part">
        <h3>{t("learn.method.suggested", { stage: t(`learn.stage.${stage}`) })}</h3>
        <div className="dem-nav-tools dem-nav-tools-wrap">
          {all.map((m) => (
            <Button
              key={m}
              size="sm"
              variant={suggested.includes(m) ? "primary" : "quiet"}
              onPress={() => run(m)}
            >
              {t(`learn.method.${m}`)}
            </Button>
          ))}
        </div>
      </section>
      <section className="dem-extras-part">
        {over && <p className="dem-flow-note">{t("learn.sprint.over")}</p>}
        <div className="dem-nav-tools dem-nav-tools-wrap">
          <Button size="sm" isDisabled={!deadline} onPress={() => onTask("sprint")}>
            {t("learn.sprint.plan")}
          </Button>
          <Button size="sm" onPress={() => onTask("questions")}>
            {t("learn.questions")}
          </Button>
        </div>
      </section>
    </div>
  );
}

/** Why the cases did not run, and for a missing language the line that installs it. */
function RunProblem({ run }: { run: CodeRun }) {
  const t = useT();
  if (run.state === "no-toolchain") {
    const install = run.install ?? "";
    return (
      <li className="dem-practice-install">
        <span>{t("learn.run.noTool", { language: run.language ?? "" })}</span>
        <code>{install}</code>
        <Button
          variant="quiet"
          onPress={() => {
            void navigator.clipboard?.writeText(install);
            showToast({ text: t("learn.run.copied") });
          }}
        >
          {t("menu.copy")}
        </Button>
      </li>
    );
  }
  if (run.state === "unsupported") return <li>{t("learn.run.unsupported")}</li>;
  return <li>{run.output}</li>;
}
