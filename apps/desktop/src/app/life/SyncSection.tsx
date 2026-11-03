// 设置 › 同步 (F3): where this computer syncs to.
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { refreshEditors } from "../../editor/pm/ProseEditor";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/TextField";
import { showToast } from "../../ui/toast";
import { failed } from "../actions";
import { api, CoreFailure, itemsChanged } from "../api";
import { useLive } from "../live";

export function SyncSection() {
  const t = useT();
  const { data: target } = useLive(() => api.syncTarget(), null);
  const [kind, setKind] = useState<"folder" | "server">("folder");
  const [location, setLocation] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const explain = (e: unknown) => {
    const code = e instanceof CoreFailure ? e.code : "";
    if (code === "sync-storage-lost") showToast({ text: t("sync.lost"), tone: "danger" });
    else if (code === "sync-unauthorized") showToast({ text: t("sync.bad"), tone: "danger" });
    else if (code === "sync-insecure") showToast({ text: t("sync.insecure"), tone: "danger" });
    else failed(t, t("settings.section.sync"))(e);
  };
  const now = () => {
    setBusy(true);
    void api
      .syncRun()
      .then((done) => {
        itemsChanged();
        for (const id of done?.items ?? []) void refreshEditors(id);
        if (done)
          showToast({
            text: t("sync.done", { up: done.uploaded, down: done.downloaded }),
            tone: "ok",
          });
      })
      .catch(explain)
      .finally(() => setBusy(false));
  };
  if (target) {
    return (
      <div className="dem-git">
        <p>{t("sync.about")}</p>
        <strong>{t("sync.to", { where: target.location })}</strong>
        <p>{t("sync.auto")}</p>
        <p>{t("sync.vaultNote")}</p>
        <span className="dem-nav-actions">
          <Button variant="primary" size="sm" isDisabled={busy} onPress={now}>
            {t("sync.now")}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            onPress={() =>
              void api
                .syncDisconnect()
                .then(() => itemsChanged())
                .catch(explain)
            }
          >
            {t("sync.disconnect")}
          </Button>
        </span>
      </div>
    );
  }
  return (
    <div className="dem-git">
      <p>{t("sync.about")}</p>
      <span className="dem-nav-actions">
        <Button
          size="sm"
          variant={kind === "folder" ? "secondary" : "quiet"}
          onPress={() => setKind("folder")}
        >
          {t("sync.kind.folder")}
        </Button>
        <Button
          size="sm"
          variant={kind === "server" ? "secondary" : "quiet"}
          onPress={() => setKind("server")}
        >
          {t("sync.kind.server")}
        </Button>
      </span>
      {kind === "folder" ? (
        <span className="dem-nav-actions">
          <Button
            size="sm"
            icon="folder-open"
            onPress={() =>
              void open({ directory: true }).then((d) => {
                if (typeof d === "string") setLocation(d);
              })
            }
          >
            {t("sync.choose")}
          </Button>
          <span className="dem-nav-title">{location}</span>
        </span>
      ) : (
        <>
          <TextField label={t("sync.address")} value={location} onChange={setLocation} />
          <TextField label={t("sync.token")} type="password" value={token} onChange={setToken} />
        </>
      )}
      <span className="dem-nav-actions">
        <Button
          size="sm"
          variant="primary"
          isDisabled={!location.trim()}
          onPress={() =>
            void api
              .syncConnect({ kind, location: location.trim() }, kind === "server" ? token : null)
              .then(() => {
                itemsChanged();
                now();
              })
              .catch(explain)
          }
        >
          {t("sync.connect")}
        </Button>
      </span>
    </div>
  );
}
