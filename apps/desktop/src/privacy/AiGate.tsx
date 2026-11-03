// Before AI touches 敏感 content the user starts an authorised session themselves (M9): this
// asks once. On an item marked 可以联网给 AI 用 it offers both kinds of session. 普通 goes straight
// through; 私密 and 机密 never get here, their AI items are greyed.
import { useState } from "react";
import { useT } from "../i18n/context";
import type { PrivacyLevel } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog, DialogActions } from "../ui/Dialog";
import { sessionsFor, type AiSession } from "./policy";

export function useAiGate(level: PrivacyLevel, aiWeb = false) {
  const t = useT();
  const [pending, setPending] = useState<((session: AiSession) => void) | null>(null);
  const choices = sessionsFor({ level, aiWeb });
  const start = (session: AiSession) => {
    pending?.(session);
    setPending(null);
  };
  return {
    /** Runs `proceed` when AI may go ahead, telling it which session the user chose. */
    request(proceed: (session: AiSession) => void) {
      if (choices.includes("plain")) proceed("plain");
      else if (choices.length) setPending(() => proceed);
    },
    dialog: (
      <Dialog
        role="alertdialog"
        title={t("privacy.auth.title")}
        isOpen={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <p>
          {t(
            choices.includes("webAuthorized") ? "privacy.auth.webMessage" : "privacy.auth.message",
          )}
        </p>
        <DialogActions>
          <Button variant="quiet" autoFocus onPress={() => setPending(null)}>
            {t("action.cancel")}
          </Button>
          {choices.includes("webAuthorized") && (
            <Button onPress={() => start("webAuthorized")}>{t("privacy.auth.confirmWeb")}</Button>
          )}
          <Button variant="primary" onPress={() => start("authorized")}>
            {t("privacy.auth.confirm")}
          </Button>
        </DialogActions>
      </Dialog>
    ),
  };
}
