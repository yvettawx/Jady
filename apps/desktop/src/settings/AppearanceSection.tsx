// 通用 and 外观 (docs/05-design.md §15, A.6, B.2–B.4). Each control writes the appearance store
// and the window follows at once.
import { useState } from "react";
import { Radio, RadioGroup } from "react-aria-components";
import { useT } from "../i18n/context";
import { useGlass } from "../ui/glass/context";
import { FONT_SCALES } from "../theme/runtime.ts";
import { ensureContrast } from "../theme/color.ts";
import { FONT_SLOTS, fontChain, type FontSlot } from "../theme/fonts.ts";
import { GLASS, MODES, SCHEMES, type SchemeId } from "../theme/tokens.ts";
import { useColorMode } from "../theme/mode.ts";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/Dialog";
import { Segmented } from "../ui/Segmented";
import { Select } from "../ui/Select";
import { Slider } from "../ui/Slider";
import { Switch } from "../ui/Switch";
import { showToast } from "../ui/toast";
import { resetAppearance, setAppearance, useAppearance, type Density } from "./appearance";
import { useSettingsHost } from "./context";
import { SettingRow } from "./SettingRow";

export function GeneralSection() {
  const t = useT();
  const a = useAppearance();
  return (
    <SettingRow
      label={t("settings.language")}
      keywords={t("settings.keywords.language").split(" ")}
    >
      <Segmented
        aria-label={t("settings.language")}
        options={[
          { id: "zh-CN", label: t("settings.language.zh-CN") },
          { id: "en", label: t("settings.language.en") },
        ]}
        value={a.locale}
        onChange={(id) => setAppearance({ locale: id as "zh-CN" | "en" })}
      />
    </SettingRow>
  );
}

/** Fonts offered for each slot besides the default (B.3: open fonts; system list in P1). */
const FONT_CHOICES: Record<FontSlot, string[]> = {
  ui: ["Source Han Sans SC", "PingFang SC", "Microsoft YaHei UI"],
  long: ["LXGW WenKai Screen", "Source Han Serif SC", "Songti SC"],
  display: ["Source Han Sans SC"],
  mono: ["SF Mono", "Menlo", "Cascadia Code"],
};

function FontRow({ slot }: { slot: FontSlot }) {
  const t = useT();
  const a = useAppearance();
  const value = a.fonts[slot];
  return (
    <SettingRow
      label={t(`settings.font.${slot}`)}
      hint={t(`settings.font.${slot}.default`)}
      keywords={[t("settings.fonts"), ...t("settings.keywords.font").split(" ")]}
      wide
    >
      <div className="dem-font-row">
        <Select
          aria-label={t(`settings.font.${slot}`)}
          options={[
            { id: "", label: t("settings.font.default") },
            ...FONT_CHOICES[slot].map((f) => ({ id: f, label: f })),
          ]}
          selectedKey={value ?? ""}
          onSelectionChange={(k) =>
            setAppearance({ fonts: { ...a.fonts, [slot]: k ? String(k) : null } })
          }
        />
        <p className="dem-font-sample" style={{ fontFamily: fontChain(slot, value) }}>
          {t(`settings.font.${slot}.sample`)}
        </p>
      </div>
    </SettingRow>
  );
}

function SpaceNameRow() {
  const t = useT();
  const host = useSettingsHost();
  const space = host?.spaces.find((s) => s.id === host.space);
  const [confirm, setConfirm] = useState(false);
  if (!host?.renameSpace || !space) return null;
  const { renameSpace, deleteSpace } = host;
  return (
    <SettingRow
      label={t("settings.spaceName")}
      keywords={t("settings.keywords.spaceColor").split(" ")}
    >
      <span className="dem-space-name">
        <input
          key={space.id}
          className="dem-fields-input"
          aria-label={t("settings.spaceName")}
          defaultValue={space.name}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== space.name) renameSpace(space.id, name);
          }}
        />
        {deleteSpace && (
          <Button size="sm" variant="quiet" icon="delete" onPress={() => setConfirm(true)}>
            {t("settings.spaceDelete")}
          </Button>
        )}
      </span>
      <ConfirmDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title={t("settings.spaceDelete.title", { space: space.name })}
        message={t("settings.spaceDelete.message")}
        confirmLabel={t("settings.spaceDelete")}
        danger
        onConfirm={() => {
          deleteSpace?.(space.id);
          setConfirm(false);
        }}
      />
    </SettingRow>
  );
}

function SpaceColorRow() {
  const t = useT();
  const a = useAppearance();
  const mode = useColorMode();
  const host = useSettingsHost();
  const space = host?.spaces.find((s) => s.id === host.space);
  if (!host || !space) return null;
  const sets = SCHEMES[a.scheme];
  const custom = typeof space.color === "string" ? space.color : null;
  // A picked colour is raised to readable link text on paper (B.5), and the page says so.
  const shown = custom ? ensureContrast(custom, MODES[mode].paper, 4.5, MODES[mode].text) : null;
  return (
    <SettingRow
      label={t("settings.spaceColor", { space: space.name })}
      hint={custom && shown !== custom ? t("settings.spaceColor.adjusted") : undefined}
      keywords={t("settings.keywords.spaceColor").split(" ")}
      wide
    >
      <RadioGroup
        aria-label={t("settings.spaceColor", { space: space.name })}
        className="dem-swatches"
        orientation="horizontal"
        value={custom ? "custom" : String(space.color)}
        onChange={(v) => v !== "custom" && host.setSpaceColor(space.id, Number(v))}
      >
        {sets.map((set, i) => (
          <Radio
            key={i}
            value={String(i)}
            className="dem-swatch"
            aria-label={t("settings.spaceColor.set", { n: i + 1 })}
          >
            <span
              className="dem-swatch-chip"
              style={{ background: `linear-gradient(135deg, ${set[0]}, ${set[1]} 60%, ${set[2]})` }}
            />
          </Radio>
        ))}
        <Radio
          value="custom"
          className="dem-swatch dem-swatch-custom"
          aria-label={t("settings.spaceColor.pick")}
        >
          <span className="dem-swatch-chip" style={{ background: shown ?? undefined }} />
          <input
            type="color"
            aria-label={t("settings.spaceColor.pick")}
            value={custom ?? sets[0]?.[0]}
            onChange={(e) => host.setSpaceColor(space.id, e.target.value)}
          />
        </Radio>
      </RadioGroup>
    </SettingRow>
  );
}

export function AppearanceSection() {
  const t = useT();
  const a = useAppearance();
  const { systemReduce } = useGlass();
  const glass = (patch: Partial<typeof a.glass>) =>
    setAppearance({ glass: { ...a.glass, ...patch } });
  return (
    <>
      <SettingRow label={t("settings.mode")} keywords={t("settings.keywords.mode").split(" ")}>
        <Segmented
          aria-label={t("settings.mode")}
          options={[
            { id: "system", label: t("settings.mode.system") },
            { id: "light", label: t("settings.mode.light") },
            { id: "dark", label: t("settings.mode.dark") },
          ]}
          value={a.mode}
          onChange={(id) => setAppearance({ mode: id as typeof a.mode })}
        />
      </SettingRow>

      <SettingRow
        label={t("settings.scheme")}
        keywords={t("settings.keywords.scheme").split(" ")}
        wide
      >
        <RadioGroup
          aria-label={t("settings.scheme")}
          className="dem-schemes"
          orientation="horizontal"
          value={a.scheme}
          onChange={(v) => setAppearance({ scheme: v as SchemeId })}
        >
          {(Object.keys(SCHEMES) as SchemeId[]).map((id) => (
            <Radio key={id} value={id} className="dem-scheme">
              <span className="dem-scheme-sets">
                {SCHEMES[id].map((set, i) => (
                  <span
                    key={i}
                    style={{ background: `linear-gradient(135deg, ${set[0]}, ${set[1]})` }}
                  />
                ))}
              </span>
              {t(`scheme.${id}`)}
            </Radio>
          ))}
        </RadioGroup>
      </SettingRow>

      <SpaceNameRow />
      <SpaceColorRow />

      <SettingRow label={t("settings.wallpaper")} hint={t("settings.wallpaper.hint")}>
        <Button
          size="sm"
          icon="image"
          onPress={() => showToast({ text: t("settings.wallpaper.later") })}
        >
          {t("settings.wallpaper.pick")}
        </Button>
      </SettingRow>

      <SettingRow label={t("settings.glass")} keywords={t("settings.keywords.glass").split(" ")}>
        <Segmented
          aria-label={t("settings.glass")}
          options={[
            { id: "clear", label: t("settings.glass.clear") },
            { id: "tinted", label: t("settings.glass.tinted") },
          ]}
          value={a.glass.tinted ? "tinted" : "clear"}
          onChange={(id) => glass({ tinted: id === "tinted" })}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.glass.alpha")}
        keywords={t("settings.keywords.glassAlpha").split(" ")}
      >
        <Slider
          aria-label={t("settings.glass.alpha")}
          minValue={GLASS.alphaMin}
          maxValue={GLASS.alphaMax}
          step={0.01}
          value={a.glass.alpha}
          onChange={(v) => glass({ alpha: v })}
        />
      </SettingRow>
      <SettingRow
        label={t("glass.reduce")}
        hint={systemReduce ? t("glass.reduceBySystem") : undefined}
        keywords={t("settings.keywords.reduce").split(" ")}
      >
        <Switch
          aria-label={t("glass.reduce")}
          isSelected={a.glass.reduce || systemReduce}
          isDisabled={systemReduce}
          onChange={(on) => glass({ reduce: on })}
        >
          {/* The row's label names it; aria-label above. */}
          {null}
        </Switch>
      </SettingRow>

      <SettingRow
        label={t("settings.homeScene")}
        keywords={t("settings.keywords.homeScene").split(" ")}
      >
        <Segmented
          aria-label={t("settings.homeScene")}
          options={[
            { id: "starmap", label: t("settings.homeScene.starmap") },
            { id: "none", label: t("settings.homeScene.none") },
          ]}
          value={a.homeScene}
          onChange={(id) => setAppearance({ homeScene: id as typeof a.homeScene })}
        />
      </SettingRow>

      <SettingRow label={t("settings.glow")} keywords={t("settings.keywords.glow").split(" ")}>
        <Slider
          aria-label={t("settings.glow")}
          minValue={0}
          maxValue={1}
          step={0.05}
          value={a.glow}
          onChange={(v) => setAppearance({ glow: v })}
        />
      </SettingRow>

      <SettingRow
        label={t("settings.tabs")}
        hint={t(`settings.tabs.${a.tabs}.hint`)}
        keywords={t("settings.keywords.tabs").split(" ")}
      >
        <Segmented
          aria-label={t("settings.tabs")}
          options={[
            { id: "vertical", label: t("settings.tabs.vertical") },
            { id: "horizontal", label: t("settings.tabs.horizontal") },
          ]}
          value={a.tabs}
          onChange={(id) => setAppearance({ tabs: id as typeof a.tabs })}
        />
      </SettingRow>

      <SettingRow
        label={t("settings.fontScale")}
        keywords={t("settings.keywords.fontScale").split(" ")}
      >
        <Segmented
          aria-label={t("settings.fontScale")}
          options={FONT_SCALES.map((f) => ({ id: String(f), label: `${Math.round(f * 100)}%` }))}
          value={String(a.fontScale)}
          onChange={(id) => setAppearance({ fontScale: Number(id) })}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.density")}
        keywords={t("settings.keywords.density").split(" ")}
      >
        <Segmented
          aria-label={t("settings.density")}
          options={(["compact", "regular", "comfortable"] as Density[]).map((d) => ({
            id: d,
            label: t(`settings.density.${d}`),
          }))}
          value={a.density}
          onChange={(id) => setAppearance({ density: id as Density })}
        />
      </SettingRow>

      {FONT_SLOTS.map((slot) => (
        <FontRow key={slot} slot={slot} />
      ))}
      <SettingRow label={t("settings.font.import")} hint={t("settings.font.import.hint")}>
        <Button
          size="sm"
          icon="import"
          onPress={() => showToast({ text: t("settings.font.later") })}
        >
          {t("settings.font.import.button")}
        </Button>
      </SettingRow>

      <SettingRow
        label={t("settings.customCss")}
        hint={t("settings.customCss.hint")}
        keywords={t("settings.keywords.customCss").split(" ")}
        wide
      >
        <textarea
          className="dem-custom-css"
          aria-label={t("settings.customCss")}
          spellCheck={false}
          value={a.customCss}
          onChange={(e) => setAppearance({ customCss: e.target.value })}
        />
      </SettingRow>

      <div className="dem-settings-foot">
        <Button variant="quiet" icon="undo" onPress={resetAppearance}>
          {t("settings.reset")}
        </Button>
      </div>
    </>
  );
}
