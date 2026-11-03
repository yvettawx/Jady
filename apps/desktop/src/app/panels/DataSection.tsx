// 设置 › 资料库: bringing things in, taking everything out, and locking.
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { commands } from "../../bindings";
import { useT } from "../../i18n/context";
import { SettingRow } from "../../settings/SettingRow";
import { Button } from "../../ui/Button";
import { Switch } from "../../ui/Switch";
import { showToast } from "../../ui/toast";
import { failed } from "../actions";
import { api, itemsChanged } from "../api";
import { useLive } from "../live";

const baseName = (path: string) => (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, "");

export function DataSection() {
  const t = useT();
  const { data: path } = useLive<string>(() => api.libraryPath(), "");
  const { data: info } = useLive(() => commands.appInfo(), null);
  const [withSecret, setWithSecret] = useState(false);

  const importTable = async () => {
    const file = await open({
      multiple: false,
      filters: [{ name: t("data.tables"), extensions: ["csv", "tsv", "xlsx", "xls"] }],
    });
    if (typeof file !== "string") return;
    const r = await api.importTable(file, baseName(file));
    itemsChanged();
    showToast({ text: t("data.imported", { n: r.created }), tone: "ok" });
  };
  const importMd = async () => {
    const files = await open({
      multiple: true,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (!files?.length) return;
    const r = await api.importMarkdown(files);
    itemsChanged();
    showToast({ text: t("data.imported", { n: r.created }), tone: "ok" });
  };
  const importFiles = async () => {
    const files = await open({ multiple: true });
    if (!files?.length) return;
    const r = await api.importFiles(files);
    itemsChanged();
    showToast({ text: t("data.imported", { n: r.created }), tone: "ok" });
  };
  const exportAll = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    const r = await api.exportAll(dir, withSecret);
    showToast({
      text: r.skippedConfidential
        ? t("data.exportedSkipped", { n: r.items, skipped: r.skippedConfidential })
        : t("data.exported", { n: r.items }),
      tone: "ok",
    });
  };
  const rebuild = async () => {
    const n = await api.indexRebuild();
    itemsChanged();
    showToast({ text: t("data.rebuilt", { n }), tone: "ok" });
  };

  return (
    <>
      <SettingRow label={t("data.location")} hint={path}>
        {null}
      </SettingRow>
      <SettingRow
        label={t("data.importTable")}
        hint={t("data.importTable.hint")}
        keywords={t("data.keywords.import").split(" ")}
      >
        <Button
          size="sm"
          icon="import"
          onPress={() => void importTable().catch(failed(t, t("data.importTable")))}
        >
          {t("data.choose")}
        </Button>
      </SettingRow>
      <SettingRow label={t("data.importMd")} keywords={t("data.keywords.import").split(" ")}>
        <Button
          size="sm"
          icon="import"
          onPress={() => void importMd().catch(failed(t, t("data.importMd")))}
        >
          {t("data.choose")}
        </Button>
      </SettingRow>
      <SettingRow
        label={t("data.importFiles")}
        hint={t("data.importFiles.hint")}
        keywords={t("data.keywords.import").split(" ")}
      >
        <Button
          size="sm"
          icon="import"
          onPress={() => void importFiles().catch(failed(t, t("data.importFiles")))}
        >
          {t("data.choose")}
        </Button>
      </SettingRow>
      <SettingRow
        label={t("data.exportAll")}
        hint={t("data.exportAll.hint")}
        keywords={t("data.keywords.export").split(" ")}
      >
        <Button
          size="sm"
          icon="export"
          onPress={() => void exportAll().catch(failed(t, t("data.exportAll")))}
        >
          {t("data.chooseFolder")}
        </Button>
      </SettingRow>
      <SettingRow label={t("data.exportSecret")} hint={t("data.exportSecret.hint")}>
        <Switch
          aria-label={t("data.exportSecret")}
          isSelected={withSecret}
          onChange={setWithSecret}
        >
          {null}
        </Switch>
      </SettingRow>
      <SettingRow label={t("data.rebuild")} hint={t("data.rebuild.hint")}>
        <Button
          size="sm"
          icon="sync"
          onPress={() => void rebuild().catch(failed(t, t("data.rebuild")))}
        >
          {t("data.rebuildNow")}
        </Button>
      </SettingRow>
      {info && (
        <SettingRow label={t("data.about")}>
          <span className="dem-setting-value">
            {t("app.about", {
              name: info.name,
              version: info.version,
              format: info.formatVersion,
            })}
          </span>
        </SettingRow>
      )}
    </>
  );
}
