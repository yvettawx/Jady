// 本次收获 (PRD D7): nothing is saved until 存入. Untick what you do not want. A word with a card
// says it will only gain the example; a mistake says which pattern it adds to.
import { useMemo, useState, type ReactNode } from "react";
import { Checkbox } from "react-aria-components";
import { useT } from "../i18n/context";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { cardKey, planHarvest, planSize, type Harvest, type HarvestPlan } from "./harvest";
import "../ui/table.css";
import "./chat.css";

/** The sentence, with the word in it picked out. */
function Example({ text, word }: { text: string; word: string }) {
  const bare = word.replace(/^(le|la|les|l'|un|une)\s+/iu, "");
  const at = text.toLowerCase().indexOf(bare.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b>{text.slice(at, at + bare.length)}</b>
      {text.slice(at + bare.length)}
    </>
  );
}

function Row({
  label,
  on,
  onChange,
  children,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <li className="dem-harvest-row" data-off={!on || undefined}>
      <Checkbox className="dem-check" aria-label={label} isSelected={on} onChange={onChange}>
        <span className="dem-check-box" aria-hidden>
          <Icon name="check" size={12} />
        </span>
      </Checkbox>
      <div className="dem-harvest-body">{children}</div>
    </li>
  );
}

export function HarvestSheet({
  harvest,
  cards,
  onSave,
  onUndo,
  onDiscard,
  onOpen,
}: {
  harvest: Harvest;
  /** Cards that exist, by cardKey → id. */
  cards: ReadonlyMap<string, string>;
  onSave: (plan: HarvestPlan) => void;
  onUndo: () => void;
  onDiscard: () => void;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = useState<HarvestPlan | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const plan = useMemo(() => planHarvest(harvest, unticked, cards), [harvest, unticked, cards]);
  const on = (id: string) => !unticked.has(id);
  const toggle = (id: string, value: boolean) =>
    setUnticked((s) => {
      const next = new Set(s);
      if (value) next.delete(id);
      else next.add(id);
      return next;
    });
  const seenWords = new Set<string>();
  return (
    <div className="dem-harvest" data-focus-home="page" tabIndex={-1}>
      <div className="dem-harvest-page">
        <h2>{t("harvest.title")}</h2>
        <p className="dem-harvest-summary">{harvest.summary}</p>

        {saved ? (
          <section className="dem-harvest-saved" data-testid="harvest-saved">
            <h3>
              <Icon name="check" size={14} />
              {t("harvest.saved")}
            </h3>
            <ul>
              {saved.newCards.length > 0 && (
                <li>{t("harvest.saved.cards", { n: saved.newCards.length })}</li>
              )}
              {saved.examples.length > 0 && (
                <li>{t("harvest.saved.examples", { n: saved.examples.length })}</li>
              )}
              {saved.grammar.length > 0 && (
                <li>{t("harvest.saved.grammar", { n: saved.grammar.length })}</li>
              )}
              {saved.mistakes.length > 0 && (
                <li>{t("harvest.saved.mistakes", { n: saved.mistakes.length })}</li>
              )}
              {saved.loose.length > 0 && (
                <li>{t("harvest.saved.loose", { n: saved.loose.length })}</li>
              )}
            </ul>
            <Button
              size="sm"
              variant="quiet"
              icon="undo"
              onPress={() => {
                setSaved(null);
                onUndo();
              }}
            >
              {t("ai.undo")}
            </Button>
          </section>
        ) : (
          <>
            {harvest.words.length > 0 && (
              <section>
                <h3>{t("harvest.words")}</h3>
                <ul>
                  {harvest.words.map((w) => {
                    const key = cardKey(w.word);
                    const repeat = seenWords.has(key);
                    seenWords.add(key);
                    return (
                      <Row
                        key={w.id}
                        label={w.word}
                        on={on(w.id)}
                        onChange={(v) => toggle(w.id, v)}
                      >
                        <p className="dem-harvest-head">
                          <strong lang="fr">{w.word}</strong>
                          <span>{w.meaning}</span>
                          {cards.has(key) && <Badge>{t("harvest.addExample")}</Badge>}
                          {repeat && <Badge>{t("harvest.repeat")}</Badge>}
                        </p>
                        <p className="dem-harvest-quote" lang="fr">
                          <Example text={w.example} word={w.word} />
                        </p>
                      </Row>
                    );
                  })}
                </ul>
              </section>
            )}
            {harvest.grammar.length > 0 && (
              <section>
                <h3>{t("harvest.grammar")}</h3>
                <ul>
                  {harvest.grammar.map((g) => (
                    <Row key={g.id} label={g.title} on={on(g.id)} onChange={(v) => toggle(g.id, v)}>
                      <p className="dem-harvest-head">
                        <strong>{g.title}</strong>
                        {g.link && (
                          <a
                            className="dem-chat-target"
                            href={`#item:${g.link.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              if (g.link) onOpen(g.link.id);
                            }}
                          >
                            {g.link.title}
                          </a>
                        )}
                      </p>
                      <p className="dem-harvest-note">{g.note}</p>
                    </Row>
                  ))}
                </ul>
              </section>
            )}
            {harvest.mistakes.length > 0 && (
              <section>
                <h3>{t("harvest.mistakes")}</h3>
                <ul>
                  {harvest.mistakes.map((m) => (
                    <Row key={m.id} label={m.right} on={on(m.id)} onChange={(v) => toggle(m.id, v)}>
                      <p className="dem-harvest-head dem-diff-inline" lang="fr">
                        <del>{m.wrong}</del>
                        <ins>{m.right}</ins>
                      </p>
                      <p className="dem-harvest-note">
                        {m.why}
                        {m.pattern &&
                          ` ${t("harvest.pattern", { name: m.pattern.name, n: m.pattern.times + 1 })}`}
                      </p>
                    </Row>
                  ))}
                </ul>
              </section>
            )}
            {harvest.loose.length > 0 && (
              <section>
                <h3>{t("harvest.loose")}</h3>
                <ul>
                  {harvest.loose.map((l) => (
                    <Row key={l.id} label={l.text} on={on(l.id)} onChange={(v) => toggle(l.id, v)}>
                      <p className="dem-harvest-head">{l.text}</p>
                    </Row>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
      {!saved && (
        <footer className="dem-harvest-foot">
          <span>{t("harvest.count", { n: planSize(plan) })}</span>
          <span className="dem-chat-gap" />
          <Button variant="quiet" onPress={() => setDiscarding(true)}>
            {t("harvest.discard")}
          </Button>
          <Button
            variant="primary"
            isDisabled={planSize(plan) === 0}
            onPress={() => {
              setSaved(plan);
              onSave(plan);
            }}
          >
            {t("harvest.save")}
          </Button>
        </footer>
      )}
      <ConfirmDialog
        isOpen={discarding}
        onOpenChange={setDiscarding}
        title={t("harvest.discard.title")}
        message={t("harvest.discard.message")}
        confirmLabel={t("harvest.discard")}
        onConfirm={() => {
          setDiscarding(false);
          onDiscard();
        }}
      />
    </div>
  );
}
