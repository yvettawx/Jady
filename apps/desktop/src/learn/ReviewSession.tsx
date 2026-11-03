// 记忆卡复习 (PRD C2): say how sure you are or write your answer, then look. All of it works from
// the keyboard; the keys are on the buttons. Keys go to the page, not while you type an answer.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "../i18n/context";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import {
  hasAnswered,
  isOverconfident,
  nextRound,
  peek,
  rate,
  ratingsFor,
  show,
  startReview,
  undoRate,
  type Confidence,
  type Rating,
  type ReviewCard,
  type ReviewEntry,
} from "./review";
import "./review.css";

const CONFIDENCE: Confidence[] = [1, 2, 3];

function Key({ children }: { children: ReactNode }) {
  return <kbd className="dem-review-key">{children}</kbd>;
}

export function ReviewSession({
  cards,
  intervalOf,
  onLog,
  onDone,
  active = true,
}: {
  cards: ReviewCard[];
  /** When this card would come back after each rating; the core's FSRS works it out. */
  intervalOf: (card: ReviewCard, rating: Rating) => string;
  onLog?: (entries: ReviewEntry[]) => void;
  onDone?: () => void;
  /** It is the tab in front. A tab behind it must not take the keyboard from whatever has it. */
  active?: boolean;
}) {
  const t = useT();
  const [s, setS] = useState(() => startReview(cards, performance.now()));
  const root = useRef<HTMLDivElement>(null);
  const card = s.queue[s.at];

  // Keys belong to the page again whenever the step changes or the tab comes to the front.
  useEffect(() => {
    if (active) root.current?.focus();
  }, [active, s.at, s.phase]);
  useEffect(() => {
    if (s.phase === "done") onLog?.(s.log);
  }, [s.phase, s.log, onLog]);

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement) {
      // Enter ends the answer; while an input method composes it picks characters instead.
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        setS(show);
      } else if (e.key === "Escape") root.current?.focus();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (s.phase === "answer") {
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        setS((x) => ({ ...x, confidence: Number(e.key) as Confidence }));
      } else if (e.key === " " || e.key === "Enter") {
        // A focused button answers Space and Enter for itself.
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        setS(show);
      } else if (e.key.toLowerCase() === "p") setS(peek);
    } else if (s.phase === "rate") {
      const rating = ratingsFor(s.peeked)[Number(e.key) - 1];
      if (rating) setS((x) => rate(x, rating, performance.now()));
    }
    if (e.key.toLowerCase() === "z") setS((x) => undoRate(x, performance.now()));
  };

  if (s.phase === "done" || !card) {
    const again = nextRound(s);
    const sureWrong = s.log.filter(isOverconfident);
    const peeks = s.log.filter((e) => e.peeked).length;
    const titleOf = (id: string) => s.queue.find((c) => c.id === id)?.front ?? "";
    return (
      <div ref={root} className="dem-review" data-focus-home="page" tabIndex={-1} onKeyDown={onKey}>
        <div className="dem-review-page" data-testid="review-done">
          <h2>{t("review.done", { n: s.log.length })}</h2>
          <p className="dem-review-tally">
            {t("review.tally", {
              forgot: s.log.filter((e) => e.rating === "again").length,
              peeked: peeks,
            })}
          </p>
          {sureWrong.length > 0 && (
            <section className="dem-review-sure">
              <h3>{t("review.sureWrong")}</h3>
              <ul>
                {sureWrong.map((e) => (
                  <li key={e.card} lang="fr">
                    {titleOf(e.card)}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="dem-review-actions">
            <Button
              variant="quiet"
              icon="undo"
              onPress={() => setS((x) => undoRate(x, performance.now()))}
            >
              {t("review.undo")}
            </Button>
            <span className="dem-review-gap" />
            {onDone && <Button onPress={onDone}>{t("review.finish")}</Button>}
            {again.length > 0 && (
              <Button
                variant="primary"
                onPress={() => setS(() => startReview(again, performance.now()))}
              >
                {t("review.again", { n: again.length })}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={root}
      className="dem-review"
      data-focus-home="page"
      tabIndex={-1}
      onKeyDown={onKey}
      aria-label={t("review.title")}
    >
      <div
        className="dem-review-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={s.queue.length}
        aria-valuenow={s.at}
      >
        <i style={{ width: `${(s.at / s.queue.length) * 100}%` }} />
      </div>
      <div className="dem-review-page">
        <p className="dem-review-count">
          {s.at + 1} / {s.queue.length}
        </p>
        <p className="dem-review-front" lang="fr" data-testid="review-front">
          {card.front}
        </p>

        {s.phase === "answer" ? (
          <>
            <div className="dem-review-sure-pick" role="group" aria-label={t("review.confidence")}>
              {CONFIDENCE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="dem-review-pick"
                  aria-pressed={s.confidence === c}
                  onClick={() => setS((x) => ({ ...x, confidence: c }))}
                >
                  {t(`review.confidence.${c}`)}
                  <Key>{c}</Key>
                </button>
              ))}
            </div>
            <textarea
              className="dem-review-answer"
              rows={2}
              aria-label={t("review.answer")}
              placeholder={t("review.answer")}
              value={s.typed}
              onChange={(e) => {
                const typed = e.target.value;
                setS((x) => ({ ...x, typed }));
              }}
            />
            <div className="dem-review-actions">
              {!hasAnswered(s) && (
                <Button variant="quiet" onPress={() => setS(peek)}>
                  {t("review.peek")}
                  <Key>{t("review.peek.key")}</Key>
                </Button>
              )}
              <span className="dem-review-gap" />
              <Button variant="primary" isDisabled={!hasAnswered(s)} onPress={() => setS(show)}>
                {t("review.show")}
              </Button>
            </div>
          </>
        ) : (
          <>
            {s.typed.trim() && (
              <p className="dem-review-mine" lang="fr">
                {s.typed}
              </p>
            )}
            <p className="dem-review-back" data-testid="review-back">
              {card.back}
            </p>
            {card.example && (
              <p className="dem-review-example" lang="fr">
                {card.example}
              </p>
            )}
            {s.peeked && (
              <p className="dem-review-peeked">
                <Icon name="show" size={12} />
                {t("review.peeked")}
              </p>
            )}
            <div className="dem-review-rates" data-testid="review-rates">
              {ratingsFor(s.peeked).map((r, i) => (
                <button
                  key={r}
                  type="button"
                  className="dem-review-rate"
                  data-rating={r}
                  onClick={() => setS((x) => rate(x, r, performance.now()))}
                >
                  <span>{t(`review.rate.${r}`)}</span>
                  <small>{intervalOf(card, r)}</small>
                  <Key>{i + 1}</Key>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
