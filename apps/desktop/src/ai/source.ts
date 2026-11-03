// 来源和把握 (PRD A8, format spec meta.source): who said this, whether it still needs checking,
// and when to look at it again. 我写的 is the normal case and shows no mark of its own.
import type { SourceKind } from "../ui/Badge";

export interface SourceInfo {
  origin: "mine" | "aiMemory" | "aiSearch" | "import";
  /** 待查: AI was not sure, or you have not looked yet. */
  needsCheck: boolean;
  /** 复查日期, "yyyy-mm-dd". */
  recheckOn?: string;
  /** 出处: links or a note saying where it came from. */
  refs: string[];
  /** 资料冲突: the sources disagree. */
  conflict?: boolean;
}

export const MINE: SourceInfo = { origin: "mine", needsCheck: false, refs: [] };

/** The marks to show, most urgent last so they read left to right as origin, then warnings. */
export function sourceMarks(info: SourceInfo): SourceKind[] {
  return [
    ...(info.origin === "mine" ? [] : [info.origin]),
    ...(info.needsCheck ? (["unverified"] as const) : []),
    ...(info.conflict ? (["conflict"] as const) : []),
  ];
}

/** Dates are "yyyy-mm-dd", so comparing the strings compares the days. */
export const recheckDue = (info: SourceInfo, today: string) =>
  !!info.recheckOn && info.recheckOn <= today;
