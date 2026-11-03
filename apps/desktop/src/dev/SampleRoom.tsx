// Sample room (P0.5-06): every base component on one page, development builds only.
// Open with #/sample. The bar on top switches light/dark, colour scheme and space, font size,
// density, the glass setting and the language. The demo strings are sample content.
import { useEffect, useState, type ReactNode } from "react";
import { useColorMode } from "../theme/mode.ts";
import { applyVars, FONT_SCALES, spaceVars } from "../theme/runtime.ts";
import { GLASS, SCHEMES, type SchemeId } from "../theme/tokens.ts";
import { Glass } from "../ui/glass/Glass";
import { GlassBackdrop } from "../ui/glass/GlassBackdrop";
import { GlassProvider } from "../ui/glass/GlassProvider";
import { useGlass } from "../ui/glass/context";
import { useWallpaper } from "../ui/glass/wallpaper";
import { Segmented } from "../ui/Segmented";
import { Slider } from "../ui/Slider";
import { useT } from "../i18n/context";
import { I18nProvider } from "../i18n/I18nProvider";
import { Badge, PrivacyMark, SourceMark } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ContentTab } from "../ui/ContentTab";
import { DataTable } from "../ui/DataTable";
import { List, ListItem } from "../ui/List";
import { EmptyState, Skeleton, Spinner } from "../ui/States";
import { Tree } from "../ui/Tree";
import { ConfirmDialog, Dialog, DialogActions, DialogTrigger } from "../ui/Dialog";
import { ContextMenu, MenuButton, type MenuEntry } from "../ui/Menu";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { Tags, type TagItem } from "../ui/Tags";
import { TextField } from "../ui/TextField";
import { showToast } from "../ui/toast";
import { ToastRegion } from "../ui/Toasts";
import { Tooltip } from "../ui/Tooltip";
import "./sample.css";

const MENU: MenuEntry[] = [
  { id: "ask", label: "问 AI", icon: "ai", shortcut: "Mod+J" },
  { id: "translate", label: "翻译", icon: "translate" },
  { id: "card", label: "生成记忆卡", icon: "card" },
  { id: "web", label: "互联网搜索", icon: "web", isDisabled: true, note: "私密内容，AI 看不到" },
  { kind: "separator", id: "s1" },
  {
    id: "move",
    label: "移到",
    icon: "folder",
    children: [
      { id: "fr", label: "语言 / 法语" },
      { id: "inbox", label: "收集箱" },
    ],
  },
  { id: "copy", label: "复制", shortcut: "Mod+C" },
  { kind: "separator", id: "s2" },
  { id: "delete", label: "删除", icon: "delete", danger: true },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sample-section">
      <h2>{title}</h2>
      <div className="sample-row">{children}</div>
    </section>
  );
}

/** ?flow=page lays the room out as one long page, for full-page screenshots in the probe. */
const PAGE_FLOW = new URLSearchParams(location.hash.split("?")[1] ?? "").get("flow") === "page";

const SCHEME_NAMES: Record<SchemeId, string> = {
  aurora: "极光",
  sunset: "日落",
  ocean: "海洋",
  forest: "森林",
  muted: "低饱和",
};
type Density = "compact" | "regular" | "comfortable";

function GlassControls() {
  const t = useT();
  const { settings, setSettings, refracting, reduce, systemReduce } = useGlass();
  return (
    <>
      <Segmented
        aria-label={t("glass.material")}
        options={[
          { id: "clear", label: t("glass.clear") },
          { id: "tinted", label: t("glass.tinted") },
        ]}
        value={settings.tinted ? "tinted" : "clear"}
        onChange={(id) => setSettings({ ...settings, tinted: id === "tinted" })}
      />
      <Slider
        aria-label={t("glass.opacity")}
        minValue={GLASS.alphaMin}
        maxValue={GLASS.alphaMax}
        step={0.01}
        value={settings.alpha}
        onChange={(v) => setSettings({ ...settings, alpha: v })}
      />
      <Switch
        isSelected={reduce}
        isDisabled={systemReduce}
        onChange={(v) => setSettings({ ...settings, reduce: v })}
      >
        {t("glass.reduce")}
      </Switch>
      {systemReduce && <span className="dem-field-hint">{t("glass.reduceBySystem")}</span>}
      <span className="sample-status" data-testid="glass-status">
        {reduce ? "实底" : refracting ? "WebGL" : "CSS"}
      </span>
    </>
  );
}

export function SampleRoom() {
  const [scheme, setScheme] = useState<SchemeId>("aurora");
  const [spaceIndex, setSpaceIndex] = useState(0);
  const space = SCHEMES[scheme][spaceIndex] ?? SCHEMES.aurora[0];
  return (
    <GlassProvider accent={space[0]}>
      <Room
        scheme={scheme}
        setScheme={setScheme}
        spaceIndex={spaceIndex}
        setSpaceIndex={setSpaceIndex}
        space={space}
      />
    </GlassProvider>
  );
}

function Room({
  scheme,
  setScheme,
  spaceIndex,
  setSpaceIndex,
  space,
}: {
  scheme: SchemeId;
  setScheme: (s: SchemeId) => void;
  spaceIndex: number;
  setSpaceIndex: (i: number) => void;
  space: readonly string[];
}) {
  const mode = useColorMode();
  const [locale, setLocale] = useState("zh-CN");
  const [fontScale, setFontScale] = useState<number>(1);
  const [density, setDensity] = useState<Density>("regular");
  const [confirming, setConfirming] = useState(false);
  const [tags, setTags] = useState<TagItem[]>([
    { id: "fr", label: "法语" },
    { id: "gr", label: "Grammar 语法" },
    { id: "rev", label: "复习" },
  ]);
  const root = document.documentElement;
  useEffect(() => applyVars(root, spaceVars(mode, space)), [root, mode, space]);
  useEffect(() => applyVars(root, { "--dem-font-scale": String(fontScale) }), [root, fontScale]);
  useEffect(() => {
    if (density === "regular") delete root.dataset.density;
    else root.dataset.density = density;
  }, [root, density]);
  const wallpaper = useWallpaper(mode, space);

  return (
    <I18nProvider locale={locale}>
      <GlassBackdrop source={wallpaper} accent={space[0]} />
      <main className="sample" data-flow={PAGE_FLOW ? "page" : undefined}>
        <div className="sample-head">
          <Glass className="sample-bar" data-testid="sample-bar">
            <h1>样板间 Sample room</h1>
            <Switch
              isSelected={mode === "dark"}
              onChange={(on) => (root.dataset.theme = on ? "dark" : "light")}
            >
              深色
            </Switch>
            <Switch isSelected={locale === "en"} onChange={(on) => setLocale(on ? "en" : "zh-CN")}>
              English
            </Switch>
            <Select
              aria-label="配色方案"
              selectedKey={scheme}
              onSelectionChange={(k) => {
                setScheme(k as SchemeId);
                setSpaceIndex(0);
              }}
              options={Object.entries(SCHEME_NAMES).map(([id, label]) => ({ id, label }))}
            />
            <Segmented
              aria-label="空间"
              options={SCHEMES[scheme].map((_, i) => ({ id: String(i), label: `空间 ${i + 1}` }))}
              value={String(spaceIndex)}
              onChange={(id) => setSpaceIndex(Number(id))}
            />
            <Segmented
              aria-label="字号"
              options={FONT_SCALES.map((f) => ({
                id: String(f),
                label: `${Math.round(f * 100)}%`,
              }))}
              value={String(fontScale)}
              onChange={(id) => setFontScale(Number(id))}
            />
            <Segmented
              aria-label="密度"
              options={[
                { id: "compact", label: "紧凑" },
                { id: "regular", label: "标准" },
                { id: "comfortable", label: "宽松" },
              ]}
              value={density}
              onChange={(id) => setDensity(id as Density)}
            />
            <GlassControls />
          </Glass>

          <section className="sample-glass-row">
            <Glass className="sample-glass-card">
              <h2>01 今日待办</h2>
              <p>玻璃上的文字和次要文字，背后是当前空间的壁纸。</p>
              <Button size="sm">打开</Button>
            </Glass>
            <Glass className="sample-glass-card">
              <h2>02 提醒</h2>
              <p>6 张记忆卡该复习。</p>
              <PrivacyMark level="private" />
            </Glass>
            <Glass className="sample-glass-card">
              <h2>03 AI</h2>
              <p>待命</p>
              <Badge tone="ai" icon="ai">
                提议 3
              </Badge>
            </Glass>
          </section>
        </div>

        {/* Only this part scrolls: nothing passes under the glass above, and the glass never
            moves with scrolling (the WebGL layer would lag a frame behind). */}
        <div className="sample-body">
          <section className="sample-section sample-type" data-testid="type-sample">
            <h2>中英混排</h2>
            <p className="sample-ui">
              界面字体：第 12 课 Le passé composé，être + participe passé，3 个例句，2026-10-21 复习
              12 次。
            </p>
            <p className="sample-long">
              长文字体（霞鹜文楷）：复合过去时（le passé composé）由助动词 avoir 或 être
              加上过去分词构成，比如 « J’ai mangé une pomme hier soir. »（我昨晚吃了一个苹果。）用
              être 的动词大多表示移动或状态的变化，过去分词要和主语配合：elle est allée, ils sont
              venus。这一课有 24 个生词，其中 7 个已经掌握。
            </p>
            <p className="sample-mono">
              等宽：<code>const passé = &quot;composé&quot;; // 2 个助动词</code>
            </p>
            <p className="sample-display">
              NO.004 <span>21:42</span>
            </p>
          </section>

          <Section title="按钮">
            <Button variant="primary">保存</Button>
            <Button>取消</Button>
            <Button variant="quiet" icon="plus">
              新建笔记
            </Button>
            <Button variant="danger" icon="delete">
              删除
            </Button>
            <Button size="sm" icon="ai">
              问 AI
            </Button>
            <Button icon="search" aria-label="搜索" />
            <Button variant="quiet" size="sm" icon="more" aria-label="更多" />
            <Button isDisabled>不可用</Button>
          </Section>

          <Section title="开关">
            <Switch defaultSelected>减少动态效果</Switch>
            <Switch>减少透明度</Switch>
            <Switch isDisabled>同步（P4）</Switch>
          </Section>

          <Section title="输入框与选择">
            <TextField label="标题" placeholder="比如：第 12 课 Le passé composé" />
            <TextField aria-label="搜索" icon="search" placeholder="搜索内容" />
            <TextField
              label="空间名称"
              defaultValue=""
              isRequired
              isInvalid
              errorMessage="请填写名称"
              description="最多 20 个字"
            />
            <Select
              label="每周复习日"
              defaultSelectedKey="sun"
              options={[
                { id: "sat", label: "周六" },
                { id: "sun", label: "周日" },
              ]}
            />
          </Section>

          <Section title="菜单、对话框、提示">
            <MenuButton
              label="菜单"
              icon="more"
              variant="secondary"
              items={MENU}
              onAction={(id) =>
                id === "delete" ? setConfirming(true) : showToast({ text: `选了 ${String(id)}` })
              }
            />
            <ContextMenu
              items={MENU}
              onAction={(id) => showToast({ text: `右键选了 ${String(id)}` })}
              aria-label="笔记的菜单"
            >
              <div className="sample-context" tabIndex={0}>
                在这里右键（或 Shift+F10）
              </div>
            </ContextMenu>
            <DialogTrigger>
              <Button>重命名空间</Button>
              <Dialog title="重命名空间">
                {({ close }) => (
                  <>
                    <TextField label="名称" defaultValue="法语学习" autoFocus />
                    <DialogActions>
                      <Button onPress={close}>取消</Button>
                      <Button variant="primary" onPress={close}>
                        存入
                      </Button>
                    </DialogActions>
                  </>
                )}
              </Dialog>
            </DialogTrigger>
            <Button variant="danger" icon="delete" onPress={() => setConfirming(true)}>
              删除笔记
            </Button>
            <ConfirmDialog
              isOpen={confirming}
              onOpenChange={setConfirming}
              title="删除这条笔记？"
              message="删除后 30 天内可以在回收站找回。"
              confirmLabel="删除"
              danger
              onConfirm={() =>
                showToast({
                  text: "已删除 1 条笔记",
                  action: { label: "撤销", onAction: () => {} },
                })
              }
            />
            <Tooltip label="搜索" shortcut="Mod+K">
              <Button icon="search" aria-label="搜索" />
            </Tooltip>
            <Tooltip label="新建" shortcut="Mod+N" placement="bottom">
              <Button icon="plus" aria-label="新建" />
            </Tooltip>
            <Button
              onPress={() =>
                showToast({
                  text: "已移到回收站",
                  action: { label: "撤销", onAction: () => {} },
                })
              }
            >
              撤销提示
            </Button>
            <Button onPress={() => showToast({ text: "已保存", tone: "ok" })}>提示条</Button>
            <Button onPress={() => showToast({ text: "同步失败，网络不可用", tone: "danger" })}>
              出错提示
            </Button>
          </Section>

          <Section title="页签">
            <div className="sample-tabs">
              <ContentTab title="首页" kind="pin" icon="home" />
              <ContentTab
                title="第 12 课 Le passé composé"
                icon="file"
                isActive
                onClose={() => {}}
              />
              <ContentTab title="第三章草稿" kind="preview" icon="file" onClose={() => {}} />
              <ContentTab title="复盘这周的计划" icon="chat" session="auth" onClose={() => {}} />
              <ContentTab title="查一下签证政策" icon="chat" session="webAuth" onClose={() => {}} />
            </div>
          </Section>

          <Section title="列表、树、表格">
            <div className="sample-col">
              <Tree
                aria-label="目录"
                defaultExpandedKeys={["lang", "fr"]}
                items={[
                  {
                    id: "lang",
                    label: "语言",
                    icon: "folder",
                    children: [
                      {
                        id: "fr",
                        label: "法语",
                        icon: "folder",
                        trailing: "24",
                        children: [
                          { id: "l11", label: "第 11 课", icon: "file" },
                          { id: "l12", label: "第 12 课 Le passé composé", icon: "file" },
                        ],
                      },
                      {
                        id: "jp",
                        label: "日语",
                        icon: "folder",
                        trailing: "8",
                        children: [{ id: "j1", label: "五十音", icon: "file" }],
                      },
                    ],
                  },
                  {
                    id: "work",
                    label: "求职",
                    icon: "job",
                    children: [{ id: "cv", label: "简历", icon: "file" }],
                  },
                  { id: "inbox", label: "收集箱", icon: "inbox", trailing: "3" },
                ]}
              />
            </div>
            <div className="sample-col">
              <List
                aria-label="最近"
                items={[
                  { id: "1", t: "第 12 课 Le passé composé", d: "语言 / 法语", m: "10:42" },
                  { id: "2", t: "简历 2026 秋", d: "求职", m: "昨天" },
                  { id: "3", t: "复盘这周的计划", d: "对话", m: "10月18日" },
                ]}
              >
                {(it) => (
                  <ListItem
                    id={it.id}
                    textValue={it.t}
                    icon="file"
                    title={it.t}
                    description={it.d}
                    meta={it.m}
                    trailing={it.id === "2" ? <PrivacyMark level="private" /> : undefined}
                  />
                )}
              </List>
            </div>
            <div className="sample-col sample-wide">
              <DataTable
                aria-label="单词"
                columns={[
                  { id: "word", label: "单词", isRowHeader: true },
                  { id: "meaning", label: "意思" },
                  { id: "reviews", label: "复习", numeric: true },
                  { id: "due", label: "下次", numeric: true },
                ]}
                rows={[
                  { id: "1", word: "bonjour", meaning: "你好", reviews: 12, due: "10-24" },
                  { id: "2", word: "la boulangerie", meaning: "面包店", reviews: 3, due: "10-22" },
                  { id: "3", word: "se souvenir", meaning: "记得", reviews: 1, due: "今天" },
                ]}
              />
            </div>
          </Section>

          <Section title="空状态与加载">
            <div className="sample-col">
              <EmptyState
                icon="inbox"
                title="收集箱是空的"
                description="新收集的内容会先放在这里。"
              />
            </div>
            <div className="sample-col">
              <Spinner showLabel />
              <div style={{ height: 12 }} />
              <Skeleton lines={4} />
            </div>
          </Section>

          <Section title="徽章、标记与标签">
            <Badge>笔记</Badge>
            <Badge tone="accent">新</Badge>
            <Badge tone="ai" icon="ai">
              提议 3
            </Badge>
            <Badge tone="ok">已掌握</Badge>
            <Badge tone="warn">快到期</Badge>
            <Badge tone="danger">冲突</Badge>
            <PrivacyMark level="sensitive" />
            <PrivacyMark level="private" />
            <PrivacyMark level="secret" />
            <SourceMark kind="mine" />
            <SourceMark kind="aiMemory" />
            <SourceMark kind="aiSearch" />
            <SourceMark kind="unverified" />
            <SourceMark kind="conflict" />
            <Tags
              aria-label="标签"
              items={tags}
              onRemove={(ids) => setTags((xs) => xs.filter((x) => !ids.has(x.id)))}
            />
          </Section>
        </div>
      </main>
      <ToastRegion />
    </I18nProvider>
  );
}
