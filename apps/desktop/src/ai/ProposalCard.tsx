// One proposal, the same wherever it shows (docs/05-design.md §5.4): what would change, and the
// choice. All three places read the one store, so deciding anywhere updates them all.
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Popover,
} from "react-aria-components";
import { InlineDiff } from "../editor/VersionDiff";
import { useT } from "../i18n/context";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Tooltip } from "../ui/Tooltip";
import { useProposals } from "./context";
import { canAllowAlways } from "./proposals";
import "./chat.css";

export function ProposalCard({ id, onOpen }: { id: string; onOpen?: (id: string) => void }) {
  const t = useT();
  const { store, items } = useProposals();
  const p = items.find((x) => x.id === id);
  if (!p) return null;
  const stale = store.isStale(id);
  const rule = t("ai.rule", { action: t(`ai.action.${p.action}`), scope: p.scope.label });
  return (
    <article
      className="dem-chat-prop"
      data-state={p.state}
      data-stale={stale || undefined}
      data-testid="proposal"
      data-proposal={p.id}
      data-focus-home="card"
      tabIndex={-1}
    >
      <h4>
        <i className="dem-chat-dot" aria-hidden />
        {p.summary}
      </h4>
      <a
        className="dem-chat-target"
        href={`#item:${p.target.id}`}
        onClick={(e) => {
          e.preventDefault();
          onOpen?.(p.target.id);
        }}
      >
        {p.target.title}
      </a>
      <InlineDiff before={p.before} after={p.after} />
      <footer>
        {p.state !== "pending" ? (
          <>
            <span className="dem-chat-done">
              {p.state === "confirmed" && <Icon name="check" size={12} />}
              {p.state === "ignored"
                ? t("ai.prop.ignored")
                : p.byRule
                  ? t("ai.prop.byRule", { rule })
                  : p.madeRule
                    ? t("ai.prop.allowed", { rule })
                    : t("ai.prop.confirmed")}
            </span>
            <Button size="sm" variant="quiet" icon="undo" onPress={() => store.undo(p.id)}>
              {t("ai.undo")}
            </Button>
          </>
        ) : stale ? (
          <>
            <span className="dem-chat-done">{t("ai.prop.stale")}</span>
            <Button size="sm" variant="quiet" onPress={() => store.ignore(p.id)}>
              {t("ai.prop.ignore")}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="quiet" onPress={() => store.ignore(p.id)}>
              {t("ai.prop.ignore")}
            </Button>
            {canAllowAlways(p) && (
              <Tooltip label={rule}>
                <Button size="sm" onPress={() => store.confirm(p.id, true)}>
                  {t("ai.prop.always")}
                </Button>
              </Tooltip>
            )}
            <Button
              size="sm"
              variant={p.action === "delete" ? "danger" : "primary"}
              onPress={() => store.confirm(p.id)}
            >
              {t(p.action === "delete" ? "ai.prop.delete" : "ai.prop.once")}
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}

/** The small dot beside a paragraph with a waiting proposal; opens the same card. */
export function ProposalDot({ id, onOpen }: { id: string; onOpen?: (id: string) => void }) {
  const { items } = useProposals();
  const p = items.find((x) => x.id === id);
  if (!p) return null;
  return (
    <span className="dem-prop-mark" contentEditable={false}>
      <DialogTrigger>
        <AriaButton className="dem-prop-dot" aria-label={p.summary} data-proposal-dot={p.id}>
          <i className="dem-chat-dot" aria-hidden />
        </AriaButton>
        <Popover className="dem-popover dem-prop-popover" placement="left top" offset={8}>
          <AriaDialog aria-label={p.summary}>
            <ProposalCard id={id} onOpen={onOpen} />
          </AriaDialog>
        </Popover>
      </DialogTrigger>
    </span>
  );
}

/** 左栏的 AI 提议: what is waiting, and what was just decided. */
export function ProposalList({ onOpen }: { onOpen?: (id: string) => void }) {
  const t = useT();
  const { store, items } = useProposals();
  const pending = items.filter((p) => p.state === "pending");
  const batch = pending.filter((p) => p.action !== "delete" && !store.isStale(p.id));
  return (
    <div className="dem-prop-list">
      {items.length === 0 ? (
        <p className="dem-prop-none">{t("ai.prop.none")}</p>
      ) : (
        <>
          {batch.length > 1 && (
            <div className="dem-prop-batch">
              <Button size="sm" onPress={() => store.confirmAll()}>
                {t("ai.prop.all", { n: batch.length })}
              </Button>
            </div>
          )}
          {items.map((p) => (
            <ProposalCard key={p.id} id={p.id} onOpen={onOpen} />
          ))}
        </>
      )}
    </div>
  );
}
