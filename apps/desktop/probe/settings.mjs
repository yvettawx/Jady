// Drives the settings tab (#/screens/settings, P0.5-07-8) in Chromium and WebKit: every
// appearance control must change the window at once, shortcuts can be recorded, conflicts are
// caught and can be moved over, a lone key is refused, the change shows in tooltips and works
// right away, search finds settings (pinyin initials too), the language switches, and the
// settings survive a reload.
// Run: pnpm run probe:settings
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
let failed = 0;

const cssVar = (page, name) =>
    page.evaluate(
        (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
        name,
    );

for (const engine of [chromium, webkit]) {
    const name = engine.name();
    const check = (label, ok, detail) => {
        if (!ok) failed++;
        console.log(
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 设置：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
        );
    };
    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});
    const context = await browser.newContext({
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}#/screens/settings`);
    await page.waitForSelector(".dem-settings");
    await page.waitForTimeout(500);
    const settings = page.locator(".dem-settings");
    // React Aria's radio is a hidden input inside its label; the click lands on the label.
    const radio = (label) => ({
        click: () =>
            settings.getByRole("radio", { name: label, exact: true }).click({ force: true }),
    });

    check(
        "⌘, 打开的设置是工作区里的页签",
        await page.evaluate(() =>
            window.__ws.tabs().some((t) => t.component === "settings" && t.isActive),
        ),
    );

    // Mode.
    const paper0 = await cssVar(page, "--dem-paper");
    await radio("深色").click();
    await page.waitForTimeout(150);
    check(
        "深色立刻生效",
        (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark" &&
            (await cssVar(page, "--dem-paper")) !== paper0,
    );
    await radio("跟随系统").click();
    check(
        "跟随系统去掉强制的深浅",
        (await page.evaluate(() => document.documentElement.dataset.theme)) === undefined,
    );

    // Scheme and the space's colour.
    await radio("日落").click();
    await page.waitForTimeout(150);
    check(
        "换配色方案，空间颜色跟着换",
        (await cssVar(page, "--dem-accent")) === "#ff5e62",
        await cssVar(page, "--dem-accent"),
    );
    await settings.locator(".dem-swatch").nth(1).click();
    await page.waitForTimeout(150);
    check(
        "换空间颜色",
        (await cssVar(page, "--dem-accent")) === "#ff9f43",
        await cssVar(page, "--dem-accent"),
    );
    // A colour picker cannot be driven by clicks; set it the way the native picker does.
    await settings.locator(".dem-swatch-custom input[type=color]").evaluate((el) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, "#13a8c4");
        el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(150);
    check(
        "自己挑的颜色",
        (await cssVar(page, "--dem-accent")) === "#13a8c4",
        await cssVar(page, "--dem-accent"),
    );
    await radio("极光").click();
    await settings.locator(".dem-swatch").nth(0).click();

    // Glass.
    const glass0 = await cssVar(page, "--dem-glass");
    await radio("着色").click();
    await page.waitForTimeout(150);
    const glass1 = await cssVar(page, "--dem-glass");
    await settings.getByRole("slider", { name: "玻璃透明度" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    const glass2 = await cssVar(page, "--dem-glass");
    check("玻璃着色和透明度立刻生效", glass0 !== glass1 && glass1 !== glass2, {
        glass0,
        glass1,
        glass2,
    });
    await (async () => {
        await settings.getByRole("switch", { name: "减少透明度" }).focus();
        await page.keyboard.press("Space");
    })();
    await page.waitForTimeout(150);
    check(
        "减少透明度",
        await page.evaluate(() =>
            document.documentElement.hasAttribute("data-reduce-transparency"),
        ),
    );
    await (async () => {
        await settings.getByRole("switch", { name: "减少透明度" }).focus();
        await page.keyboard.press("Space");
    })();
    await radio("透明").click();

    // Tabs, text size, density, fonts.
    await radio("横排").click();
    await page.waitForTimeout(200);
    check(
        "页签改横排",
        (await page.locator(".dem-workspace").getAttribute("data-tabs")) === "horizontal",
    );
    await radio("竖排").click();
    await radio("125%").click();
    check("字号 125%", (await cssVar(page, "--dem-font-scale")) === "1.25");
    await radio("紧凑").click();
    check(
        "密度紧凑",
        (await page.evaluate(() => document.documentElement.dataset.density)) === "compact",
    );
    await settings.getByRole("button", { name: /长文字体/ }).click();
    await page.getByRole("option", { name: "Source Han Serif SC" }).click();
    await page.waitForTimeout(150);
    check(
        "长文字体换了",
        (await cssVar(page, "--dem-font-long")).startsWith('"Source Han Serif SC"'),
    );

    // Home scene: none leaves the wallpaper.
    await radio("不显示").click();
    await page.keyboard.press("ControlOrMeta+Shift+H");
    await page.waitForTimeout(400);
    check("首页场景不显示：没有星图", (await page.locator(".dem-starmap-canvas").count()) === 0);
    await page.evaluate(() => {
        const t = window.__ws.tabs().find((x) => x.component === "settings");
        window.__ws.activate(t.id);
    });
    await page.waitForTimeout(300);
    await radio("星图").click();

    // Glow: the star map follows, and at 0 the pass is off.
    const bloomAt = async (key) => {
        await settings.getByRole("slider", { name: "溢光" }).focus();
        await page.keyboard.press(key);
        await page.waitForTimeout(100);
        await page.keyboard.press("ControlOrMeta+Shift+H");
        await page.waitForTimeout(300);
        const strength = await page.evaluate(() => window.__starScene?.bloomStrength());
        await page.evaluate(() => {
            const t = window.__ws.tabs().find((x) => x.component === "settings");
            window.__ws.activate(t.id);
        });
        await page.waitForTimeout(250);
        return strength;
    };
    const full = await bloomAt("End");
    const off = await bloomAt("Home");
    check("溢光拉到 0，星图的溢光关掉", full > 0 && off === 0, { full, off });
    await bloomAt("End");

    // Survives a reload.
    await page.reload();
    await page.waitForSelector(".dem-workspace");
    await page.waitForTimeout(500);
    check("刷新后设置还在", (await cssVar(page, "--dem-font-scale")) === "1.25");
    await page.evaluate(() => {
        const s = window.__ws.tabs().find((x) => x.component === "settings");
        if (s) window.__ws.activate(s.id);
    });
    if (!(await settings.isVisible())) await page.keyboard.press("ControlOrMeta+,");
    await settings.waitFor();
    await settings.getByRole("button", { name: "恢复默认外观" }).click();
    await page.waitForTimeout(150);
    check("恢复默认外观", (await cssVar(page, "--dem-font-scale")) === "1");

    // Search, pinyin initials included.
    const search = settings.getByPlaceholder("搜索设置");
    await search.fill("zh");
    await page.waitForTimeout(150);
    const labels = await settings.locator(".dem-setting-label").allTextContents();
    check("搜 zh（拼音首字母）找到字号", labels.includes("字号"), labels);
    check(
        "搜索时不显示空的分区和恢复按钮",
        (await settings.locator(".dem-settings-title:visible").count()) === 1 &&
            (await settings.getByRole("button", { name: "恢复默认外观" }).count()) === 0,
    );
    await search.fill("没有这种设置");
    await page.waitForTimeout(150);
    check("没搜到时说明", await settings.getByText("没有找到这项设置").isVisible());
    await search.fill("");

    // Language.
    await settings.getByRole("button", { name: "通用" }).click();
    check(
        "中文界面用简体的语言标记",
        (await page.evaluate(() => document.documentElement.lang)) === "zh-Hans",
    );
    await radio("English").click();
    await page.waitForTimeout(150);
    check(
        "语言标记跟着界面语言",
        (await page.evaluate(() => document.documentElement.lang)) === "en",
    );
    check(
        "界面语言换成英文",
        (await settings.locator(".dem-settings-title").textContent()) === "General",
    );
    await radio("中文").click();

    // Shortcuts: record, use at once, conflict, lone key, reset.
    await settings.getByRole("button", { name: "快捷键" }).click();
    const row = (label) =>
        settings.locator(".dem-shortcut", { has: page.getByText(label, { exact: true }) });
    await row("首页").locator(".dem-shortcut-kbd").click();
    await page.keyboard.press("J");
    check("单个键不行，提示要带 ⌘ 或 ⌥", (await row("首页").textContent())?.includes("要带"));
    await page.keyboard.press("ControlOrMeta+Shift+J");
    await page.waitForTimeout(150);
    const keys = await row("首页").locator(".dem-shortcut-kbd").textContent();
    check("录入新的组合", /J/.test(keys ?? ""), keys);
    await page.keyboard.press("ControlOrMeta+Shift+J");
    await page.waitForTimeout(400);
    check("新组合马上能用", (await page.locator(".dem-home").count()) === 1);
    await page.evaluate(() => {
        const t = window.__ws.tabs().find((x) => x.component === "settings");
        window.__ws.activate(t.id);
    });
    await page.waitForTimeout(300);
    await row("新建").locator(".dem-shortcut-kbd").click();
    await page.keyboard.press("ControlOrMeta+K");
    await page.waitForTimeout(150);
    const note = await row("新建").locator(".dem-shortcut-note").textContent();
    check("冲突时说明给了谁", note?.includes("打开启动器"), note);
    await row("新建").getByRole("button", { name: "改给这一项" }).click();
    await page.waitForTimeout(150);
    check(
        "改给这一项：新建拿到 ⌘K，启动器没有了",
        /K/.test((await row("新建").locator(".dem-shortcut-kbd").textContent()) ?? "") &&
            (await row("打开启动器").locator(".dem-shortcut-kbd").textContent()) === "没有",
    );
    await page.locator(".dem-titlebar .dem-button").last().hover();
    await page.waitForTimeout(900);
    const tip = await page
        .locator(".dem-tooltip")
        .textContent()
        .catch(() => "");
    check("标题栏的提示跟着换", /K/.test(tip ?? ""), tip);
    await settings.getByRole("button", { name: "全部恢复默认" }).click();
    await page.waitForTimeout(150);
    check(
        "全部恢复默认",
        (await row("打开启动器").locator(".dem-shortcut-kbd").textContent()) !== "没有" &&
            (await row("首页").locator(".dem-shortcut-kbd").textContent())?.includes("H"),
    );
    check("页面没有报错", errors.length === 0, errors);
    await context.close();
    await browser.close();
}

await server.close();
console.log(failed ? `${failed} checks failed` : "all settings checks passed");
process.exit(failed ? 1 : 0);
