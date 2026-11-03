// Create a library, unlock it, or recover it (P0.5-07-4; PRD F1, M9, format-spec §4.3–4.4).
// Everything talks to the core through LibraryGate, so P1 only swaps the implementation.
import { useEffect, useState, type ReactNode } from "react";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { Glass } from "../../ui/glass/Glass";
import { PasswordField } from "../../ui/PasswordField";
import { Spinner } from "../../ui/States";
import { Switch } from "../../ui/Switch";
import { TextField } from "../../ui/TextField";
import { showToast } from "../../ui/toast";
import {
  MIN_PASSWORD,
  passwordLongEnough,
  passwordStrength,
  type LibraryGate,
  type LibraryRef,
  type PendingLibrary,
} from "./gate";
import { CODE_LENGTH, formatCode, groupCode, normalizeCode } from "./recoveryCode";
import "./gate.css";

export type GateStep =
  | "welcome"
  | "join"
  | "location"
  | "password"
  | "recovery"
  | "confirm"
  | "creating"
  | "unlocking"
  | "unlock"
  | "recover"
  | "missing"
  | "broken";

export type GateStart =
  | { mode: "first-run" }
  /** `locked`: the user locked it themselves, so it waits for the password, not the keychain. */
  | { mode: "unlock"; library: LibraryRef; locked?: boolean }
  | { mode: "missing"; library: LibraryRef }
  | { mode: "broken"; library: LibraryRef; details: string };

function pickTwoGroups(): readonly [number, number] {
  const a = 1 + Math.floor(Math.random() * 9);
  let b = 1 + Math.floor(Math.random() * 8);
  if (b >= a) b++;
  return [Math.min(a, b), Math.max(a, b)];
}

function Card({
  title,
  lead,
  children,
  actions,
}: {
  title?: string;
  lead?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const t = useT();
  return (
    <Glass className="gate-card">
      <p className="gate-wordmark">{t("app.name")}</p>
      {title && <h1 className="gate-title">{title}</h1>}
      {lead && <p className="gate-lead">{lead}</p>}
      {children && <div className="gate-body">{children}</div>}
      {actions && <div className="gate-actions">{actions}</div>}
    </Glass>
  );
}

function Strength({ password }: { password: string }) {
  const t = useT();
  if (!password) return null;
  if (!passwordLongEnough(password))
    return <p className="gate-strength">{t("lib.passwordShort", { n: MIN_PASSWORD })}</p>;
  const s = passwordStrength(password);
  return (
    <p className="gate-strength" data-strength={s}>
      <span className="gate-strength-bar" />
      {t(`lib.strength.${s}`)}
    </p>
  );
}

export function RecoveryCodeView({ code }: { code: string }) {
  const t = useT();
  return (
    <ol className="gate-code" aria-label={t("lib.recovery.code")}>
      {groupCode(normalizeCode(code)).map((g, i) => (
        <li key={i}>
          <span className="gate-code-n">{i + 1}</span>
          <span className="gate-code-g">{g}</span>
        </li>
      ))}
    </ol>
  );
}

export function LibraryGateScreen({
  gate,
  start,
  onOpened,
  initialStep,
  initialPending,
}: {
  gate: LibraryGate;
  start: GateStart;
  onOpened: (lib: LibraryRef) => void;
  /** Development review: jump straight to a step (with a prepared library for the code steps). */
  initialStep?: GateStep;
  initialPending?: PendingLibrary;
}) {
  const t = useT();
  const [step, setStep] = useState<GateStep>(
    initialStep ??
      (start.mode === "first-run"
        ? "welcome"
        : start.mode === "unlock"
          ? start.locked
            ? "unlock"
            : "unlocking"
          : start.mode),
  );
  const [name, setName] = useState(() => t("lib.nameDefault"));
  const [path, setPath] = useState(() => gate.defaultLocation());
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pending, setPending] = useState<PendingLibrary | null>(initialPending ?? null);
  const [saved, setSaved] = useState(false);
  const [g, setG] = useState(["", ""]);
  const [error, setError] = useState<string | null>(null);
  const [keychainSlow, setKeychainSlow] = useState(initialStep === "unlock");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [joinKind, setJoinKind] = useState<"folder" | "server">("folder");
  const [joinFrom, setJoinFrom] = useState("");
  const [joinToken, setJoinToken] = useState("");
  // Which two groups the confirmation asks for: different each time.
  const [ask] = useState(pickTwoGroups);
  const lib: LibraryRef = start.mode === "first-run" ? { name, path } : start.library;
  const recoveryCode = pending?.recoveryCode ?? "";

  useEffect(() => {
    if (step !== "unlocking") return;
    let alive = true;
    void gate.keychainUnlock(lib).then((r) => {
      if (!alive) return;
      if (r === "ok") onOpened(lib);
      else {
        setKeychainSlow(true);
        setStep("unlock");
      }
    });
    return () => {
      alive = false;
    };
    // Only the step change starts an attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const go = (s: GateStep) => {
    setError(null);
    setStep(s);
  };

  switch (step) {
    case "welcome":
      return (
        <Card
          lead={t("lib.tagline")}
          actions={
            <>
              <Button
                onPress={() =>
                  void gate
                    .chooseFolder()
                    .then((p) => p && onOpened({ name: p.split("/").at(-1) ?? p, path: p }))
                }
              >
                {t("lib.open")}
              </Button>
              {gate.join && <Button onPress={() => go("join")}>{t("lib.join")}</Button>}
              <Button variant="primary" onPress={() => go("location")}>
                {t("lib.new")}
              </Button>
            </>
          }
        />
      );
    case "join":
      return (
        <Card
          title={t("lib.join")}
          lead={t("lib.join.about")}
          actions={
            <>
              <Button variant="quiet" onPress={() => go("welcome")}>
                {t("action.back")}
              </Button>
              <Button
                variant="primary"
                isDisabled={busy || !joinFrom.trim() || !gate.join}
                onPress={() => {
                  setBusy(true);
                  setError(null);
                  void gate
                    .join?.(joinKind, joinFrom.trim(), joinToken, `${path}/${name.trim() || "DEM"}`)
                    .then((joined) => joined && onOpened(joined))
                    .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setBusy(false));
                }}
              >
                {t("lib.join.go")}
              </Button>
            </>
          }
        >
          <div className="gate-path">
            <Button
              size="sm"
              variant={joinKind === "folder" ? "secondary" : "quiet"}
              onPress={() => setJoinKind("folder")}
            >
              {t("sync.kind.folder")}
            </Button>
            <Button
              size="sm"
              variant={joinKind === "server" ? "secondary" : "quiet"}
              onPress={() => setJoinKind("server")}
            >
              {t("sync.kind.server")}
            </Button>
          </div>
          {joinKind === "folder" ? (
            <div className="gate-path">
              <span className="gate-path-text">{joinFrom}</span>
              <Button
                size="sm"
                icon="folder-open"
                onPress={() => void gate.chooseFolder().then((p) => p && setJoinFrom(p))}
              >
                {t("lib.change")}
              </Button>
            </div>
          ) : (
            <>
              <TextField label={t("sync.address")} value={joinFrom} onChange={setJoinFrom} />
              <TextField
                label={t("sync.token")}
                type="password"
                value={joinToken}
                onChange={setJoinToken}
              />
            </>
          )}
          <TextField label={t("lib.name")} value={name} onChange={setName} />
          {error && (
            <p role="alert" className="gate-strength">
              {error}
            </p>
          )}
        </Card>
      );
    case "location":
      return (
        <Card
          title={t("lib.new")}
          actions={
            <>
              <Button variant="quiet" onPress={() => go("welcome")}>
                {t("action.back")}
              </Button>
              <Button variant="primary" isDisabled={!name.trim()} onPress={() => go("password")}>
                {t("action.next")}
              </Button>
            </>
          }
        >
          <TextField label={t("lib.name")} value={name} onChange={setName} autoFocus />
          <div className="dem-field">
            <span className="dem-field-label">{t("lib.location")}</span>
            <div className="gate-path">
              <span className="gate-path-text">{path}</span>
              <Button
                size="sm"
                icon="folder-open"
                onPress={() => void gate.chooseFolder().then((p) => p && setPath(p))}
              >
                {t("lib.change")}
              </Button>
            </div>
            <span className="dem-field-hint">{t("lib.locationHint")}</span>
          </div>
        </Card>
      );
    case "password": {
      const mismatch = pw2.length > 0 && pw !== pw2;
      return (
        <Card
          title={t("lib.password")}
          lead={t("lib.passwordHint")}
          actions={
            <>
              <Button variant="quiet" onPress={() => go("location")}>
                {t("action.back")}
              </Button>
              <Button
                variant="primary"
                isDisabled={!passwordLongEnough(pw) || pw !== pw2 || busy}
                onPress={() => {
                  setBusy(true);
                  void gate.prepare(name, path, pw).then((p) => {
                    setBusy(false);
                    setPending(p);
                    go("recovery");
                  });
                }}
              >
                {t("action.next")}
              </Button>
            </>
          }
        >
          <PasswordField label={t("lib.password")} value={pw} onChange={setPw} autoFocus />
          <Strength password={pw} />
          <PasswordField
            label={t("lib.passwordAgain")}
            value={pw2}
            onChange={setPw2}
            isInvalid={mismatch}
            errorMessage={t("lib.passwordMismatch")}
          />
        </Card>
      );
    }
    case "recovery":
      return (
        <Card
          title={t("lib.recovery.title")}
          lead={t("lib.recovery.lead")}
          actions={
            <>
              <Button variant="quiet" onPress={() => go("password")}>
                {t("action.back")}
              </Button>
              <Button variant="primary" isDisabled={!saved} onPress={() => go("confirm")}>
                {t("action.next")}
              </Button>
            </>
          }
        >
          <RecoveryCodeView code={recoveryCode} />
          <div className="gate-code-actions">
            <Button
              size="sm"
              icon="copy"
              onPress={() =>
                void navigator.clipboard
                  ?.writeText(formatCode(recoveryCode))
                  .then(() => showToast({ text: t("lib.recovery.copied"), tone: "ok" }))
              }
            >
              {t("lib.recovery.copy")}
            </Button>
            <Button
              size="sm"
              icon="save-file"
              onPress={() => void gate.exportRecoveryCode(recoveryCode, "file")}
            >
              {t("lib.recovery.save")}
            </Button>
            <Button
              size="sm"
              icon="print"
              onPress={() => void gate.exportRecoveryCode(recoveryCode, "print")}
            >
              {t("lib.recovery.print")}
            </Button>
          </div>
          <p className="gate-warning">{t("lib.recovery.warning")}</p>
          <Switch isSelected={saved} onChange={setSaved}>
            {t("lib.recovery.saved")}
          </Switch>
        </Card>
      );
    case "confirm": {
      const groups = groupCode(normalizeCode(recoveryCode));
      const ok =
        normalizeCode(g[0] ?? "") === groups[ask[0] - 1] &&
        normalizeCode(g[1] ?? "") === groups[ask[1] - 1];
      const filled = (g[0] ?? "").length >= 4 && (g[1] ?? "").length >= 4;
      return (
        <Card
          title={t("lib.confirm.title")}
          lead={t("lib.confirm.lead", { a: ask[0], b: ask[1] })}
          actions={
            <>
              <Button variant="quiet" onPress={() => go("recovery")}>
                {t("action.back")}
              </Button>
              <Button
                variant="primary"
                isDisabled={!ok}
                onPress={() => {
                  go("creating");
                  void pending?.commit().then(() => onOpened(lib));
                }}
              >
                {t("lib.create")}
              </Button>
            </>
          }
        >
          <div className="gate-confirm">
            {ask.map((n, i) => (
              <TextField
                key={n}
                label={t("lib.confirm.group", { n })}
                value={g[i]}
                onChange={(v) =>
                  setG((xs) => xs.map((x, j) => (j === i ? normalizeCode(v).slice(0, 4) : x)))
                }
                isInvalid={filled && !ok}
                errorMessage={i === 1 ? t("lib.confirm.wrong") : undefined}
                autoFocus={i === 0}
              />
            ))}
          </div>
        </Card>
      );
    }
    case "creating":
      return (
        <Card title={t("lib.creating")}>
          <Spinner label={t("lib.creating")} />
        </Card>
      );
    case "unlocking":
      return (
        <Card title={lib.name} lead={lib.path}>
          <Spinner label={t("lib.unlocking")} showLabel />
        </Card>
      );
    case "unlock":
      return (
        <Card
          title={lib.name}
          lead={keychainSlow ? t("lib.keychainSlow") : lib.path}
          actions={
            <>
              <Button variant="quiet" onPress={() => go("recover")}>
                {t("lib.useRecovery")}
              </Button>
              <Button
                variant="primary"
                isDisabled={!pw || busy}
                onPress={() => {
                  setBusy(true);
                  void gate.unlock(lib, pw).then((r) => {
                    setBusy(false);
                    if (r === "ok") onOpened(lib);
                    else setError(t("lib.wrongPassword"));
                  });
                }}
              >
                {t("lib.unlock")}
              </Button>
            </>
          }
        >
          <PasswordField
            label={t("lib.password")}
            value={pw}
            onChange={(v) => {
              setPw(v);
              setError(null);
            }}
            isInvalid={!!error}
            errorMessage={error ?? undefined}
            autoFocus
          />
          {busy && <Spinner label={t("lib.unlocking")} showLabel />}
        </Card>
      );
    case "recover": {
      const complete = normalizeCode(code).length === CODE_LENGTH;
      return (
        <Card
          title={t("lib.recover.title")}
          lead={lib.name}
          actions={
            <>
              <Button variant="quiet" onPress={() => go("unlock")}>
                {t("action.back")}
              </Button>
              <Button
                variant="primary"
                isDisabled={!complete || !passwordLongEnough(pw) || pw !== pw2 || busy}
                onPress={() => {
                  setBusy(true);
                  void gate.recover(lib, normalizeCode(code), pw).then((r) => {
                    setBusy(false);
                    if (r === "ok") onOpened(lib);
                    else setError(t("lib.recover.badCode"));
                  });
                }}
              >
                {t("lib.recover.done")}
              </Button>
            </>
          }
        >
          <TextField
            label={t("lib.recover.code")}
            value={formatCode(code)}
            onChange={(v) => {
              setCode(v);
              setError(null);
            }}
            isInvalid={!!error}
            errorMessage={error ?? undefined}
            placeholder={t("lib.recover.codePlaceholder")}
            autoFocus
          />
          <PasswordField label={t("lib.recover.newPassword")} value={pw} onChange={setPw} />
          <Strength password={pw} />
          <PasswordField
            label={t("lib.passwordAgain")}
            value={pw2}
            onChange={setPw2}
            isInvalid={pw2.length > 0 && pw !== pw2}
            errorMessage={t("lib.passwordMismatch")}
          />
        </Card>
      );
    }
    case "missing":
      return (
        <Card
          title={t("lib.missing.title")}
          lead={t("lib.missing.lead", { path: lib.path })}
          actions={
            <>
              <Button onPress={() => go("location")}>{t("lib.new")}</Button>
              <Button
                variant="primary"
                icon="folder-open"
                onPress={() =>
                  void gate.chooseFolder().then((p) => p && onOpened({ name: lib.name, path: p }))
                }
              >
                {t("lib.missing.locate")}
              </Button>
            </>
          }
        />
      );
    case "broken":
      return (
        <Card
          title={t("lib.broken.title")}
          lead={t("lib.broken.lead")}
          actions={
            <Button
              variant="primary"
              onPress={() =>
                void gate.chooseFolder().then((p) => p && onOpened({ name: p, path: p }))
              }
            >
              {t("lib.openOther")}
            </Button>
          }
        >
          <details className="gate-details">
            <summary>{t("lib.broken.details")}</summary>
            <pre>{start.mode === "broken" ? start.details : ""}</pre>
          </details>
        </Card>
      );
  }
}
