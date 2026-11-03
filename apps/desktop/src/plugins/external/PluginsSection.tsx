// 设置 › 插件: install a plugin from a folder, see what it asks for, and turn it on or off. Only you
// do this, here; no AI tool reaches it.
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { Manifest, PluginInfo } from "../../bindings";
import { failed } from "../../app/actions";
import { api } from "../../app/api";
import { useLive } from "../../app/live";
import { useLocale, useT } from "../../i18n/context";
import { SettingRow } from "../../settings/SettingRow";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { Switch } from "../../ui/Switch";
import { showToast } from "../../ui/toast";
import { localized, pluginsChanged } from "./host";
import "./plugin.css";

export function PluginsSection() {
  const t = useT();
  const locale = useLocale();
  const [seq, setSeq] = useState(0);
  const { data: list } = useLive<PluginInfo[]>(() => api.pluginList(), [], [seq]);
  const [asking, setAsking] = useState<Manifest | null>(null);
  const [removing, setRemoving] = useState<Manifest | null>(null);
  const changed = () => {
    setSeq((n) => n + 1);
    pluginsChanged();
  };
  const name = (m: Manifest) => localized(m.name, locale);
  const perms = (m: Manifest) => m.permissions ?? [];
  return (
    <>
      <SettingRow label={t("plugins.install")} hint={t("plugins.install.hint")}>
        <Button
          size="sm"
          icon="plugin"
          onPress={() =>
            void open({ directory: true, multiple: false })
              .then(async (dir) => {
                if (typeof dir !== "string") return;
                await api.pluginInstall(dir);
                changed();
                showToast({ text: t("plugins.installed") });
              })
              .catch(failed(t, t("plugins.install")))
          }
        >
          {t("plugins.install")}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          onPress={() => void api.pluginFolder().catch(failed(t, t("plugins.folder")))}
        >
          {t("plugins.folder")}
        </Button>
      </SettingRow>
      {list.length === 0 ? (
        <p className="dem-setting-hint">{t("plugins.none")}</p>
      ) : (
        <ul className="dem-plugin-list">
          {list.map((p) => {
            const m = p.manifest;
            return (
              <li key={p.folder} className="dem-plugin-row">
                <span className="dem-plugin-row-text">
                  <span>{m ? `${name(m)} ${m.version}` : p.folder}</span>
                  <small>
                    {!m
                      ? t("plugins.broken")
                      : p.asksMore
                        ? t("plugins.asksMore")
                        : localized(m.description, locale)}
                  </small>
                </span>
                {m && (
                  <>
                    <Switch
                      aria-label={name(m)}
                      isSelected={p.enabled}
                      onChange={(on) =>
                        on
                          ? setAsking(m)
                          : void api
                              .pluginDisable(m.id)
                              .then(changed)
                              .catch(failed(t, name(m)))
                      }
                    >
                      {null}
                    </Switch>
                    <Button size="sm" variant="quiet" onPress={() => setRemoving(m)}>
                      {t("plugins.remove")}
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {asking && (
        <ConfirmDialog
          isOpen
          onOpenChange={(o) => !o && setAsking(null)}
          title={t("plugins.enable.title", { name: name(asking) })}
          confirmLabel={t("plugins.enable")}
          message={
            <>
              <ul className="dem-plugin-perms">
                {perms(asking).length ? (
                  perms(asking).map((x) => (
                    <li key={x}>{t(`plugins.perm.${x.replace(":", ".")}`)}</li>
                  ))
                ) : (
                  <li>{t("plugins.perm.none")}</li>
                )}
              </ul>
              <p>{t("plugins.never")}</p>
            </>
          }
          onConfirm={() =>
            void api
              .pluginEnable(asking.id)
              .then(changed)
              .catch(failed(t, name(asking)))
          }
        />
      )}
      {removing && (
        <ConfirmDialog
          isOpen
          danger
          onOpenChange={(o) => !o && setRemoving(null)}
          title={t("plugins.remove.title", { name: name(removing) })}
          message={t("plugins.remove.message")}
          confirmLabel={t("plugins.remove")}
          onConfirm={() =>
            void api
              .pluginRemove(removing.id)
              .then(changed)
              .catch(failed(t, name(removing)))
          }
        />
      )}
    </>
  );
}
