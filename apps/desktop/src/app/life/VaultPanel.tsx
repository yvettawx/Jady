// 密码库 (F1, M9). Its own password, its own lock. Lists hold no passwords; one is fetched only when
// someone presses show, and copying goes straight from the core to the clipboard.
import { open as pickFile, save as pickPath } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import type { VaultItem, VaultRow } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { EmptyState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import { showToast } from "../../ui/toast";
import type { WorkspaceApi } from "../../workspace/api";
import { failed } from "../actions";
import { api, CoreFailure } from "../api";

export const VAULT_PANEL = "vault";
const CHECK_EVERY = 20_000;
const BLANK: VaultItem = { id: "", title: "", username: "", password: "", url: "", notes: "" };

function Door({ exists, onOpen }: { exists: boolean; onOpen: () => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [wrong, setWrong] = useState("");
  const [busy, setBusy] = useState(false);
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    if (!exists && password !== again) return setWrong(t("vault.mismatch"));
    setBusy(true);
    setWrong("");
    void (exists ? api.vaultUnlock(password) : api.vaultCreate(password))
      .then(onOpen)
      .catch((err: unknown) => {
        if (err instanceof CoreFailure && err.code === "wrong-password") setWrong(t("vault.wrong"));
        else if (err instanceof CoreFailure && err.code === "invalid") setWrong(t("vault.short"));
        else failed(t, t("vault.title"))(err);
      })
      .finally(() => setBusy(false));
  };
  return (
    <form className="dem-vault-door" onSubmit={go}>
      <h2>{t(exists ? "vault.locked" : "vault.new")}</h2>
      <p>{t(exists ? "vault.locked.about" : "vault.new.about")}</p>
      <TextField
        autoFocus
        type="password"
        aria-label={t("vault.password")}
        placeholder={t("vault.password")}
        value={password}
        onChange={setPassword}
      />
      {!exists && (
        <TextField
          type="password"
          aria-label={t("vault.again")}
          placeholder={t("vault.again")}
          value={again}
          onChange={setAgain}
        />
      )}
      {wrong && <p role="alert">{wrong}</p>}
      <Button type="submit" variant="primary" isDisabled={busy || !password}>
        {t(exists ? "vault.unlock" : "vault.create")}
      </Button>
    </form>
  );
}

function Editor({
  item,
  onSaved,
  onGone,
}: {
  item: VaultItem;
  onSaved: (id: string) => void;
  onGone: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(item);
  const [shown, setShown] = useState(false);
  const [removing, setRemoving] = useState(false);
  const set = (key: keyof VaultItem) => (v: string) => setDraft((d) => ({ ...d, [key]: v }));
  const save = () =>
    void api
      .vaultSave(draft)
      .then((id) => {
        onSaved(id);
        showToast({ text: t("vault.saved") });
      })
      .catch(failed(t, t("vault.title")));
  return (
    <div className="dem-vault-edit">
      <TextField label={t("vault.field.title")} value={draft.title} onChange={set("title")} />
      <TextField
        label={t("vault.field.username")}
        value={draft.username}
        onChange={set("username")}
      />
      <TextField
        label={t("vault.field.password")}
        type={shown ? "text" : "password"}
        value={draft.password}
        onChange={set("password")}
      />
      <span className="dem-nav-actions">
        <Button size="sm" variant="quiet" onPress={() => setShown((s) => !s)}>
          {t(shown ? "vault.hide" : "vault.show")}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          onPress={() =>
            void api.vaultGenerate(20).then((p) => {
              set("password")(p);
              setShown(true);
            })
          }
        >
          {t("vault.generate")}
        </Button>
        {item.id && (
          <Button
            size="sm"
            variant="quiet"
            onPress={() =>
              void api
                .vaultCopy(item.id)
                .then(() => showToast({ text: t("vault.copied") }))
                .catch(failed(t, t("vault.title")))
            }
          >
            {t("vault.copy")}
          </Button>
        )}
      </span>
      <TextField label={t("vault.field.url")} value={draft.url} onChange={set("url")} />
      <TextField label={t("vault.field.notes")} value={draft.notes} onChange={set("notes")} />
      <span className="dem-nav-actions">
        <Button variant="primary" onPress={save}>
          {t("vault.save")}
        </Button>
        {item.id && (
          <Button variant="danger" onPress={() => setRemoving(true)}>
            {t("vault.remove")}
          </Button>
        )}
      </span>
      <ConfirmDialog
        isOpen={removing}
        onOpenChange={setRemoving}
        title={t("vault.remove.title")}
        message={t("vault.remove.body", { title: draft.title })}
        confirmLabel={t("vault.remove")}
        danger
        onConfirm={() =>
          void api
            .vaultRemove(item.id)
            .then(onGone)
            .catch(failed(t, t("vault.title")))
        }
      />
    </div>
  );
}

function Inside({ onLocked }: { onLocked: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<VaultRow[]>([]);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<VaultItem | null>(null);
  const [exporting, setExporting] = useState(false);
  const reload = useCallback(
    () =>
      void api
        .vaultRows()
        .then(setRows)
        .catch((e: unknown) => {
          if (e instanceof CoreFailure && e.code === "vault-locked") onLocked();
        }),
    [onLocked],
  );
  useEffect(reload, [reload]);
  const lower = query.toLowerCase();
  const shown = rows.filter((r) =>
    `${r.title} ${r.username} ${r.url}`.toLowerCase().includes(lower),
  );
  const importCsv = async () => {
    const file = await pickFile({ filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (typeof file !== "string") return;
    const n = await api.vaultImport(file);
    showToast({ text: t("vault.imported", { n }) });
    reload();
  };
  const exportCsv = async () => {
    const file = await pickPath({ defaultPath: "passwords.csv" });
    if (!file) return;
    const n = await api.vaultExport(file);
    showToast({ text: t("vault.exported", { n }), tone: "danger" });
  };
  return (
    <div className="dem-vault">
      <header className="dem-life-head">
        <TextField
          aria-label={t("vault.search")}
          placeholder={t("vault.search")}
          value={query}
          onChange={setQuery}
        />
        <Button size="sm" variant="primary" onPress={() => setCurrent({ ...BLANK })}>
          {t("vault.add")}
        </Button>
        <span className="dem-life-gap" />
        <Button
          size="sm"
          variant="quiet"
          onPress={() => void importCsv().catch(failed(t, t("vault.import")))}
        >
          {t("vault.import")}
        </Button>
        <Button size="sm" variant="quiet" onPress={() => setExporting(true)}>
          {t("vault.export")}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          icon="lock"
          onPress={() => void api.vaultLock().then(onLocked)}
        >
          {t("vault.lock")}
        </Button>
      </header>
      <div className="dem-vault-body">
        <ul className="dem-vault-list">
          {shown.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="dem-nav-open"
                data-current={current?.id === r.id ? "" : undefined}
                onClick={() =>
                  void api
                    .vaultItem(r.id)
                    .then(setCurrent)
                    .catch(failed(t, t("vault.title")))
                }
              >
                <span className="dem-nav-title">{r.title || r.url || t("item.untitled")}</span>
                <span className="dem-nav-count">{r.username}</span>
              </button>
            </li>
          ))}
        </ul>
        {current ? (
          <Editor
            key={current.id || "new"}
            item={current}
            onSaved={(id) => {
              reload();
              void api.vaultItem(id).then(setCurrent);
            }}
            onGone={() => {
              setCurrent(null);
              reload();
            }}
          />
        ) : (
          !rows.length && <EmptyState icon="passwords" title={t("vault.empty")} />
        )}
      </div>
      <ConfirmDialog
        isOpen={exporting}
        onOpenChange={setExporting}
        title={t("vault.export.title")}
        message={t("vault.export.body")}
        confirmLabel={t("vault.export")}
        danger
        onConfirm={() => void exportCsv().catch(failed(t, t("vault.export")))}
      />
    </div>
  );
}

export function VaultPanel() {
  const [state, setState] = useState<{ exists: boolean; open: boolean } | null>(null);
  const check = useCallback(() => void api.vaultStatus().then(setState), []);
  useEffect(() => {
    check();
    // It locks itself after a while; the page must not keep showing what is behind the lock.
    const timer = setInterval(check, CHECK_EVERY);
    return () => clearInterval(timer);
  }, [check]);
  if (!state) return null;
  if (!state.open)
    return (
      <div className="dem-vault">
        <Door exists={state.exists} onOpen={check} />
      </div>
    );
  return <Inside onLocked={check} />;
}

/** The leftmost bar's way in. */
export function VaultNav({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  return (
    <div className="dem-nav-section dem-life-nav">
      <Button
        size="sm"
        icon="passwords"
        onPress={() =>
          workspace.open({
            contentId: VAULT_PANEL,
            component: VAULT_PANEL,
            title: t("vault.title"),
          })
        }
      >
        {t("vault.open")}
      </Button>
    </div>
  );
}
