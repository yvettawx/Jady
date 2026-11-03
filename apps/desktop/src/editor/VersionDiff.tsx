// 版本对比 (2026-10-26): two versions side by side by default, old on the left and new on the
// right, paragraphs lined up; or together in one column, removed text struck through and new
// text highlighted. Both use the long-text typography.
import { Fragment, useMemo } from "react";
import { useT } from "../i18n/context";
import { Segmented } from "../ui/Segmented";
import { diffParagraphs, type Piece, type Row } from "./diff";
import "./diff.css";
import "./prose.css";

export interface Version {
  /** e.g. 10月24日 21:06 */
  label: string;
  paragraphs: string[];
}

export type DiffLayout = "split" | "inline";

function Pieces({ pieces, side }: { pieces: Piece[]; side: "before" | "after" | "both" }) {
  return (
    <>
      {pieces.map((p, i) =>
        p.op === "same" ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (side === "before" && p.op === "removed") ||
          (side === "after" && p.op === "added") ||
          side === "both" ? (
          p.op === "removed" ? (
            <del key={i}>{p.text}</del>
          ) : (
            <ins key={i}>{p.text}</ins>
          )
        ) : null,
      )}
    </>
  );
}

/** Old and new in one column: removed text struck through, new text highlighted. */
function InlineRows({ rows }: { rows: Row[] }) {
  return (
    <div className="dem-diff-inline dem-prose">
      {rows.map((r, i) =>
        r.kind === "changed" ? (
          <p key={i} data-kind="changed">
            <Pieces pieces={r.inline} side="both" />
          </p>
        ) : (
          <p key={i} data-kind={r.kind}>
            {r.kind === "removed" ? (
              <del>{r.text}</del>
            ) : r.kind === "added" ? (
              <ins>{r.text}</ins>
            ) : (
              r.text
            )}
          </p>
        ),
      )}
    </div>
  );
}

/** The same, on its own: a proposal shows its change this way. */
export function InlineDiff({ before, after }: { before: string[]; after: string[] }) {
  const rows = useMemo(() => diffParagraphs(before, after), [before, after]);
  return <InlineRows rows={rows} />;
}

export function VersionDiff({
  before,
  after,
  layout,
  onLayout,
}: {
  before: Version;
  after: Version;
  layout: DiffLayout;
  onLayout: (l: DiffLayout) => void;
}) {
  const t = useT();
  const rows = useMemo(
    () => diffParagraphs(before.paragraphs, after.paragraphs),
    [before.paragraphs, after.paragraphs],
  );
  const changes = rows.filter((r) => r.kind !== "same").length;
  return (
    <section className="dem-diff" data-layout={layout}>
      <header className="dem-diff-head">
        <span className="dem-diff-versions">
          <span className="dem-diff-ver" data-side="before">
            {before.label}
          </span>
          <span aria-hidden>→</span>
          <span className="dem-diff-ver" data-side="after">
            {after.label}
          </span>
        </span>
        <span className="dem-diff-count">{t("diff.changes", { n: changes })}</span>
        <span className="dem-diff-gap" />
        <Segmented
          aria-label={t("diff.layout")}
          options={[
            { id: "split", label: t("diff.split") },
            { id: "inline", label: t("diff.inline") },
          ]}
          value={layout}
          onChange={(id) => onLayout(id as DiffLayout)}
        />
      </header>
      <div className="dem-diff-body">
        {layout === "split" ? (
          <div className="dem-diff-grid dem-prose" role="table" aria-label={t("diff.title")}>
            {rows.map((r, i) => (
              <div key={i} className="dem-diff-row" role="row" data-kind={r.kind}>
                <p role="cell">
                  {r.kind === "changed" ? (
                    <Pieces pieces={r.before} side="before" />
                  ) : r.kind === "added" ? null : (
                    r.text
                  )}
                </p>
                <p role="cell">
                  {r.kind === "changed" ? (
                    <Pieces pieces={r.after} side="after" />
                  ) : r.kind === "removed" ? null : (
                    r.text
                  )}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <InlineRows rows={rows} />
        )}
      </div>
    </section>
  );
}
