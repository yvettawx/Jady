// The unlock and create-library screens' real door to the core.
import { open, save } from "@tauri-apps/plugin-dialog";
import { commands } from "../bindings";
import type { LibraryGate, PendingLibrary } from "../screens/unlock/gate";
import { showToast } from "../ui/toast";
import { api, CoreFailure } from "./api";

let keychain: Promise<"ok" | "unavailable"> | null = null;

export function realGate(defaultLocation: string, text: (k: string) => string): LibraryGate {
  return {
    defaultLocation: () => defaultLocation,
    chooseFolder: async () => {
      const dir = await open({ directory: true, multiple: false, defaultPath: defaultLocation });
      return typeof dir === "string" ? dir : null;
    },
    prepare: async (name, path, password): Promise<PendingLibrary> => {
      const recoveryCode = await api.libraryPrepare(name, path, password);
      return {
        recoveryCode,
        commit: () => api.libraryCommit().then(() => undefined),
        cancel: () => void commands.libraryCancel(),
      };
    },
    join: (kind, location, token, folder) =>
      api.syncJoin({ kind, location }, token || null, folder),
    exportRecoveryCode: async (code, how) => {
      if (how === "print") {
        window.print();
        return;
      }
      const path = await save({ defaultPath: `${text("gate.recoveryFile")}.txt` });
      if (!path) return;
      await api.fileWriteText(path, code);
      showToast({ text: text("gate.recoverySaved"), tone: "ok" });
    },
    keychainUnlock: (lib) => {
      // One attempt at a time, however often the screen asks.
      keychain ??= api
        .libraryUnlockKeychain(lib.path)
        .then((ok): "ok" | "unavailable" => (ok ? "ok" : "unavailable"))
        .catch((): "unavailable" => "unavailable")
        .finally(() => (keychain = null));
      return keychain;
    },
    unlock: async (lib, password) => {
      try {
        return (await api.libraryUnlockPassword(lib.path, password)) ? "ok" : "wrong";
      } catch (e) {
        if (e instanceof CoreFailure && e.code === "wrong-password") return "wrong";
        // Something else is wrong (another process has it open, a disk problem): say that.
        showToast({ text: e instanceof Error ? e.message : String(e), tone: "danger" });
        return "wrong";
      }
    },
    recover: async (lib, code, newPassword) =>
      (await api.libraryRecover(lib.path, code, newPassword)) ? "ok" : "bad-code",
  };
}
