// What the unlock and create-library screens need from the core. P1 implements it with the
// shell's commands (dem-core, M2/M9); development pages use a fake.
export interface LibraryRef {
  name: string;
  path: string;
}

export interface PendingLibrary {
  /** 36 Crockford base32 characters; shown once, then only its confirmation is asked for. */
  recoveryCode: string;
  /** Writes the library after the user confirmed the recovery code. */
  commit(): Promise<void>;
  cancel(): void;
}

export interface LibraryGate {
  defaultLocation(): string;
  /** A folder picker; null when cancelled. */
  chooseFolder(): Promise<string | null>;
  prepare(name: string, path: string, password: string): Promise<PendingLibrary>;
  /** Saves the recovery code as a text file (save dialog) or sends it to the printer. */
  exportRecoveryCode(code: string, how: "file" | "print"): Promise<void>;
  /** Reads the master key from the keychain; "unavailable" after a timeout, a refusal or a miss. */
  keychainUnlock(lib: LibraryRef): Promise<"ok" | "unavailable">;
  unlock(lib: LibraryRef, password: string): Promise<"ok" | "wrong">;
  /** A library from another computer: fills a new folder from a sync storage. */
  join?(
    kind: "folder" | "server",
    location: string,
    token: string,
    folder: string,
  ): Promise<LibraryRef>;
  recover(lib: LibraryRef, code: string, newPassword: string): Promise<"ok" | "bad-code">;
}

/** Shortest master password, in characters (2026-10-25). */
export const MIN_PASSWORD = 8;

/** Long enough to be a master password; counts characters, so 汉字 count one each. */
export const passwordLongEnough = (pw: string) => [...pw].length >= MIN_PASSWORD;

/** Rough strength for the hint under the password; P1 swaps in a proper estimator. */
export function passwordStrength(pw: string): "weak" | "fair" | "strong" {
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/, /[^\p{ASCII}]/u].filter((r) => r.test(pw)).length;
  const score = pw.length + kinds * 3;
  return score >= 20 ? "strong" : score >= 13 ? "fair" : "weak";
}
