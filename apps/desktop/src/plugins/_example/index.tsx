// An example that uses every extension point once. To try it, copy this folder to
// src/plugins/browse (no underscore) and build. See docs/extending/README.md.
import { useEffect, useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { SettingRow } from "../../settings/SettingRow";
import { Button } from "../../ui/Button";
import { Switch } from "../../ui/Switch";
import type { SchemeSets } from "../../theme/tokens.ts";
import { definePlugin, type PluginContext } from "../api";
import messages from "./messages.json";
import forest from "./forest.json";
import "./example.css";

const STORE_KEY = "example.pickOnStart";

async function pickOne(ctx: PluginContext): Promise<ItemView | null> {
  const items = await ctx.data.itemList({
    typeId: "note",
    states: ["active"],
    container: null,
    tag: null,
    order: "updated",
    limit: 200,
  });
  // Lists keep 机密 titles out; opening one would ask for the password anyway, so skip those.
  const open = items.filter((i) => i.privacy !== "confidential");
  return open[Math.floor(Math.random() * open.length)] ?? null;
}

function openPick(ctx: PluginContext) {
  void pickOne(ctx).then((item) => {
    if (!item) return ctx.toast({ text: ctx.t("example.pick.none") });
    ctx.workspace()?.open({
      contentId: item.id,
      title: item.title ?? "",
      component: "note",
      params: { privacy: item.privacy },
    });
  });
}

export default definePlugin({
  id: "example",
  apiVersion: 1,
  activate(ctx) {
    // Text never lives in code: it goes in the tables, one per language.
    for (const [locale, table] of Object.entries(messages)) ctx.addMessages(locale, table);

    function Panel() {
      const t = useT();
      const [count, setCount] = useState<number | null>(null);
      useEffect(() => {
        void ctx.data
          .itemList({
            typeId: null,
            states: ["active"],
            container: null,
            tag: null,
            order: null,
            limit: null,
          })
          .then((all) => setCount(all.length));
      }, []);
      return (
        <div className="example-panel">
          {count !== null && <p>{t("example.count", { n: count })}</p>}
          <Button icon="read" onPress={() => openPick(ctx)}>
            {t("example.again")}
          </Button>
        </div>
      );
    }

    ctx.registerPanel({ id: "example-panel", icon: "read", role: "widget", render: Panel });
    ctx.registerTemplate({
      id: "example-plants",
      icon: "life",
      name: "example.template",
      about: "example.template.about",
      types: [
        {
          id: "example_plant",
          name: "example.template.type",
          view: "table",
          privacy: "normal",
          fields: [
            { key: "watered", name: "example.template.watered", kind: { type: "date" } },
            { key: "lat", name: "template.trip.lat", kind: { type: "number" } },
            { key: "lng", name: "template.trip.lng", kind: { type: "number" } },
          ],
        },
      ],
    });
    ctx.registerCommand({
      id: "example.pick",
      title: ctx.t("example.pick"),
      icon: "read",
      run: () => openPick(ctx),
    });
    ctx.registerLauncherSource({
      id: "example",
      modes: ["search"],
      order: 20,
      search: (q) =>
        q.text.startsWith("?")
          ? []
          : [
              {
                id: "example:pick",
                group: ctx.t("example.launcher.group"),
                icon: "read",
                title: ctx.t("example.pick"),
                score: 0,
                run: () => openPick(ctx),
              },
            ],
    });
    ctx.registerHomeWidget({
      id: "example",
      panel: "example-panel",
      title: "example.widget",
      col: 9,
      row: 0,
      w: 3,
      h: 2,
    });
    ctx.registerNavView({
      id: "example",
      icon: "read",
      label: "example.panel",
      render: Panel,
    });
    ctx.registerSettingsSection({
      id: "example",
      icon: "read",
      Body: function Section() {
        const t = useT();
        const [on, setOn] = useState(() => localStorage.getItem(STORE_KEY) === "1");
        return (
          <SettingRow label={t("example.settings.title")}>
            <Switch
              aria-label={t("example.settings.title")}
              isSelected={on}
              onChange={(v) => {
                setOn(v);
                localStorage.setItem(STORE_KEY, v ? "1" : "0");
              }}
            >
              {null}
            </Switch>
          </SettingRow>
        );
      },
    });
    ctx.registerScheme("example-forest", forest as unknown as SchemeSets);

    if (localStorage.getItem(STORE_KEY) === "1") setTimeout(() => openPick(ctx), 500);
  },
});
