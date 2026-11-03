// 版本对比 (PRD A7, docs/05-design.md §3): pick two points in an item's history and compare them,
// or give one a name so it is easy to find again.
import { useEffect, useState } from "react";
import type { VersionView } from "../../bindings";
import { VersionDiff, type DiffLayout } from "../../editor/VersionDiff";
import { useLocale, useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { EmptyState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import type { PanelProps } from "../../workspace/registry";
import { failed } from "../actions";
import { refreshEditors } from "../../editor/pm/ProseEditor";
import { api, itemsChanged } from "../api";
import { useLive } from "../live";

export function VersionsPanel({ params }: PanelProps) {
  const t = useT();
  const locale = useLocale();
  const id = String(params.item ?? "");
  const [seq, setSeq] = useState(0);
  const { data: versions } = useLive<VersionView[]>(() => api.versionList(id), [], [id, seq]);
  const [pair, setPair] = useState<[string, string] | null>(null);
  const [layout, setLayout] = useState<DiffLayout>("split");
  const [texts, setTexts] = useState<[string[], string[]] | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [restoring, setRestoring] = useState(false);

  // By default, the newest against the one before it.
  const picked: [string, string] | null =
    pair ??
    (versions.length >= 2 ? [versions[1]?.version ?? "", versions[0]?.version ?? ""] : null);
  const [from, to] = picked ?? ["", ""];
  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    void Promise.all([api.versionText(id, from), api.versionText(id, to)]).then(([a, b]) => {
      // A link inside a line comes as an object character; show that something is there.
      const clean = (lines: string[]) => lines.map((l) => l.replaceAll("\ufffc", "[[…]]"));
      if (alive) setTexts([clean(a), clean(b)]);
    });
    return () => {
      alive = false;
    };
  }, [id, from, to]);

  const when = (v: VersionView | undefined) =>
    v?.label ||
    (v?.at != null
      ? new Date(v.at).toLocaleString(locale, {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "");

  if (!versions.length) return <EmptyState icon="history" title={t("versions.none")} />;
  return (
    <div className="dem-versions" data-focus-home="page" tabIndex={-1}>
      <div className="dem-versions-side">
        <ul className="dem-versions-list" aria-label={t("versions.list")}>
          {versions.map((v) => (
            <li key={v.version} data-picked={v.version === from || v.version === to || undefined}>
              <button
                type="button"
                className="dem-versions-row"
                onClick={() =>
                  setPair([to, v.version].sort((a, b) => order(a) - order(b)) as [string, string])
                }
              >
                <span>{when(v)}</span>
                <span className="dem-versions-origin">{t(`versions.origin.${v.origin}`)}</span>
              </button>
              <Button
                size="sm"
                variant="quiet"
                icon="edit"
                aria-label={t("versions.name")}
                onPress={() => {
                  setName(v.label ?? "");
                  setNaming(v.version);
                }}
              />
            </li>
          ))}
        </ul>
        {from && (
          <div className="dem-versions-restore">
            <Button size="sm" icon="undo" onPress={() => setRestoring(true)}>
              {t("versions.restore", { when: when(versions.find((v) => v.version === from)) })}
            </Button>
          </div>
        )}
      </div>
      <div className="dem-versions-diff">
        {texts ? (
          <VersionDiff
            before={{ label: when(versions.find((v) => v.version === from)), paragraphs: texts[0] }}
            after={{ label: when(versions.find((v) => v.version === to)), paragraphs: texts[1] }}
            layout={layout}
            onLayout={setLayout}
          />
        ) : (
          <EmptyState icon="history" title={t("versions.pick")} />
        )}
      </div>
      <ConfirmDialog
        isOpen={restoring}
        onOpenChange={setRestoring}
        title={t("versions.restore.title")}
        message={t("versions.restore.message")}
        confirmLabel={t("versions.restore.confirm")}
        onConfirm={() => {
          setRestoring(false);
          void api
            .versionRestore(
              id,
              from,
              t("versions.beforeRestore", {
                when: new Date().toLocaleString(locale, {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                }),
              }),
            )
            .then(() => refreshEditors(id))
            .then(() => {
              itemsChanged();
              setPair(null);
              setSeq((n) => n + 1);
            })
            .catch(failed(t, t("versions.restore.confirm")));
        }}
      />
      <Dialog
        title={t("versions.name")}
        isOpen={naming !== null}
        onOpenChange={(o) => !o && setNaming(null)}
      >
        <TextField aria-label={t("versions.name")} autoFocus value={name} onChange={setName} />
        <div className="dem-dialog-actions">
          <Button
            variant="primary"
            isDisabled={!name.trim()}
            onPress={() => {
              if (naming)
                void api
                  .versionName(id, naming, name.trim())
                  .then(() => setSeq((n) => n + 1))
                  .catch(failed(t, t("versions.name")));
              setNaming(null);
            }}
          >
            {t("action.save")}
          </Button>
        </div>
      </Dialog>
    </div>
  );

  // Older first, whichever was clicked last: the list runs newest to oldest.
  function order(version: string) {
    return -versions.findIndex((v) => v.version === version);
  }
}
