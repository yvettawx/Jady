// 打开前再验证 for 机密 content (M9): only a lock until verified. System verification first
// (Touch ID, Windows Hello); if that is unavailable, the master password. The note itself
// is not rendered before this passes. Real verification comes from the core in P1.
import { useState } from "react";
import { useT } from "../i18n/context";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { PasswordField } from "../ui/PasswordField";
import { Spinner } from "../ui/States";
import "./privacy.css";

export interface SecretVerifier {
  system(): Promise<"ok" | "failed" | "unavailable">;
  password(password: string): Promise<"ok" | "wrong">;
}

export function SecretGate({
  verifier,
  onVerified,
  passwordOnly = false,
}: {
  verifier: SecretVerifier;
  onVerified: () => void;
  /** System verification is not available: go straight to the master password. */
  passwordOnly?: boolean;
}) {
  const t = useT();
  const [how, setHow] = useState<"system" | "password">(passwordOnly ? "password" : "system");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [pw, setPw] = useState("");

  const trySystem = async () => {
    setBusy(true);
    setNote(null);
    const r = await verifier.system();
    setBusy(false);
    if (r === "ok") onVerified();
    else if (r === "failed") setNote(t("privacy.gate.failed"));
    else {
      setNote(t("privacy.gate.unavailable"));
      setHow("password");
    }
  };
  const tryPassword = async () => {
    setBusy(true);
    const r = await verifier.password(pw);
    setBusy(false);
    setPw("");
    if (r === "ok") onVerified();
    else setWrong(true);
  };

  return (
    <div className="dem-secret-gate">
      <Icon name="lock" size={28} strokeWidth={1.25} className="dem-secret-icon" />
      <h2>{t("privacy.secretTitle")}</h2>
      <p>{note ?? t("privacy.gate.lead")}</p>
      {how === "system" ? (
        <Button variant="primary" isDisabled={busy} onPress={() => void trySystem()}>
          {busy ? <Spinner label={t("privacy.gate.checking")} /> : t("privacy.gate.verify")}
        </Button>
      ) : (
        <form
          className="dem-secret-password"
          onSubmit={(e) => {
            e.preventDefault();
            void tryPassword();
          }}
        >
          <PasswordField
            label={t("lib.password")}
            value={pw}
            onChange={(v) => {
              setPw(v);
              setWrong(false);
            }}
            isInvalid={wrong}
            errorMessage={t("privacy.gate.wrong")}
            autoFocus
          />
          <Button variant="primary" type="submit" isDisabled={busy || !pw}>
            {t("privacy.gate.open")}
          </Button>
        </form>
      )}
      {!passwordOnly && (
        <Button
          variant="quiet"
          size="sm"
          onPress={() => {
            setHow(how === "system" ? "password" : "system");
            setNote(null);
            setWrong(false);
          }}
        >
          {how === "system" ? t("privacy.gate.usePassword") : t("privacy.gate.useBiometric")}
        </Button>
      )}
    </div>
  );
}
