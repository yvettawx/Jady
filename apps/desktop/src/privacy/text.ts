// Interface wording that depends on the privacy level.
import type { PrivacyLevel } from "../ui/Badge";
import { aiAccess } from "./policy";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Why AI is greyed here, or undefined when it is not (§5.6). */
export function aiBlockedReason(t: T, level: PrivacyLevel): string | undefined {
  return aiAccess(level) === "blocked" ? t(`privacy.aiBlocked.${level}`) : undefined;
}
