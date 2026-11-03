// Every state of the P0.5-07 screens in both engines, light and dark, for review on one page
// (docs/plans/p0.5-shots/index.html, built by gallery-page.mjs). Also fails on page errors.
// With --en it walks the same states in English instead, reports text that overflows or is cut
// off, and leaves its shots in a temporary folder: English is checked, not reviewed.
// Run: pnpm run probe:gallery [--en] [--only group]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";
import { buildGalleryPage } from "./gallery-page.mjs";

const english = process.argv.includes("--en");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : 0;
const SHOTS = new URL("../../../docs/plans/p0.5-shots/", import.meta.url);
const OUT = english ? join(tmpdir(), "dem-gallery-en") : new URL("screens/", SHOTS).pathname;
const MODES = english ? ["light"] : ["light", "dark"];

const read = (f) => JSON.parse(readFileSync(new URL(`../src/i18n/${f}.json`, import.meta.url)));
const [zh, en] = [read("zh-CN"), read("en")];
/** The steps name things by their Chinese text; in English, the same key's English text. */
const L = (text) => {
    if (!english) return text;
    const key = Object.keys(zh).find((k) => zh[k] === text);
    if (!key) throw new Error(`not in the string table: ${text}`);
    return en[key];
};
/** Words the user types, which the string table does not hold as such. */
const typed = (zhText, enText) => (english ? enText : zhText);

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];

const workspaceReady = (page) =>
    page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 0);
const showTab = async (page, id) => {
    await page.evaluate((c) => {
        const t = window.__ws.tabs().find((x) => x.contentId === c);
        window.__ws.activate(t.id);
    }, id);
    await page.waitForTimeout(250);
};

/** A hub star that is on screen and not under a widget, in CSS px. */
const hubOnScreen = (page) =>
    page.evaluate(() => {
        const s = window.__starScene;
        const home = document.querySelector(".dem-home");
        for (const [i, b] of s.layout.bodies.entries()) {
            if (!b.node.hub || b.node.cluster === "diary") continue;
            const p = s.screenOf(i);
            if (p && document.elementFromPoint(p.x, p.y) === home) return p;
        }
        return null;
    });

// Each group opens its own page and runs through its states; snap(id, title) takes one.
const unlockStep = (id, title) => ({
    route: `#/screens/unlock?step=${id}`,
    viewport: { width: 1100, height: 760 },
    states: [[`unlock-${id}`, title]],
    run: async (page, snap) => {
        await page.waitForSelector(".gate-card, main", { timeout: 8000 });
        await page.waitForTimeout(500);
        await snap(`unlock-${id}`);
    },
});

const GROUPS = {
    unlock: {
        title: "解锁与建库",
        pages: [
            unlockStep("welcome", "欢迎"),
            unlockStep("location", "选资料库的位置"),
            unlockStep("password", "设主密码"),
            unlockStep("recovery", "恢复码"),
            unlockStep("confirm", "确认恢复码"),
            unlockStep("creating", "正在创建"),
            unlockStep("unlock", "日常解锁：输密码"),
            unlockStep("unlocking", "日常解锁：钥匙串通过"),
            unlockStep("recover", "用恢复码找回"),
            unlockStep("missing", "资料库找不到"),
            unlockStep("broken", "资料库打不开"),
        ],
    },
    shell: {
        title: "外壳",
        pages: [
            {
                route: "#/screens/shell",
                states: [
                    ["shell-main", "主空间，三列"],
                    ["shell-space-fr", "切到法语空间"],
                    ["shell-notifications", "通知"],
                    ["shell-narrow", "窗口变窄：收右列"],
                    ["shell-narrower", "窗口更窄：再收左列"],
                ],
                run: async (page, snap) => {
                    await workspaceReady(page);
                    await page.waitForTimeout(600);
                    await snap("shell-main");
                    await page.keyboard.press("ControlOrMeta+2");
                    await page.waitForTimeout(500);
                    await snap("shell-space-fr");
                    await page.keyboard.press("ControlOrMeta+1");
                    await page.waitForTimeout(500);
                    await page.keyboard.press("ControlOrMeta+Shift+N");
                    await page.waitForTimeout(400);
                    await snap("shell-notifications");
                    await page.keyboard.press("Escape");
                    await page.setViewportSize({ width: 1000, height: 760 });
                    await page.waitForTimeout(400);
                    await snap("shell-narrow");
                    await page.setViewportSize({ width: 680, height: 760 });
                    await page.waitForTimeout(400);
                    await snap("shell-narrower");
                },
            },
        ],
    },
    home: {
        title: "首页",
        pages: [
            {
                route: "#/screens/home",
                states: [
                    ["home-main", "星图和小组件"],
                    ["home-hover", "悬停一颗星"],
                    ["home-float", "最左栏浮出目录"],
                ],
                run: async (page, snap) => {
                    await workspaceReady(page);
                    await page.waitForTimeout(5000); // the cluster names show once it settles
                    await snap("home-main");
                    const hub = await hubOnScreen(page);
                    if (!hub) throw new Error("no star to hover");
                    await page.mouse.move(hub.x, hub.y);
                    await page.waitForTimeout(250);
                    await snap("home-hover");
                    await page.mouse.move(700, 120);
                    await page.getByRole("radio", { name: L("目录") }).click();
                    await page.waitForTimeout(400);
                    await snap("home-float");
                },
            },
        ],
    },
    editor: {
        title: "编辑器",
        pages: [
            {
                route: "#/screens/editor",
                states: [
                    ["editor-main", "正文排版"],
                    ["editor-blocks", "代码和记忆卡"],
                    ["editor-selbar", "选中文字的小工具条"],
                    ["editor-peek", "内链的悬浮预览"],
                    ["editor-mermaid", "Mermaid 图"],
                    ["editor-read", "阅读模式"],
                    ["editor-diff-split", "版本对比：并排"],
                    ["editor-diff-inline", "版本对比：合在一起"],
                ],
                run: async (page, snap) => {
                    await page.waitForSelector(".dem-prose");
                    await page.waitForSelector(".dem-mermaid-svg svg", { timeout: 15000 });
                    await page.waitForTimeout(300);
                    await snap("editor-main");
                    const prose = page.locator(".dem-sheet .dem-prose").first();
                    const body = page.locator(".dem-sheet-body").first();
                    await body.evaluate((el) => (el.scrollTop = 900));
                    await page.waitForTimeout(300);
                    await snap("editor-blocks");
                    await body.evaluate((el) => (el.scrollTop = 0));
                    await prose
                        .locator("p")
                        .first()
                        .evaluate((p) => {
                            const r = document.createRange();
                            r.setStart(p.firstChild, 0);
                            r.setEnd(p.firstChild, 5);
                            const s = getSelection();
                            s.removeAllRanges();
                            s.addRange(r);
                        });
                    await page.waitForTimeout(250);
                    await snap("editor-selbar");
                    await page.keyboard.press("Escape");
                    await page.evaluate(() => getSelection().removeAllRanges());
                    await prose.locator(".dem-wikilink", { hasText: "第 11 课" }).click();
                    await page.waitForTimeout(500);
                    await snap("editor-peek");
                    await page.keyboard.press("Escape");
                    await page.waitForTimeout(200);
                    const mermaid = prose.locator(".dem-mermaid");
                    await mermaid.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(200);
                    await snap("editor-mermaid");
                    await page.getByRole("radio", { name: L("阅读") }).click();
                    await page.waitForTimeout(400);
                    await mermaid.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(200);
                    await snap("editor-read");
                    await page.getByRole("radio", { name: L("编辑") }).click();
                    await showTab(page, "diff");
                    await snap("editor-diff-split");
                    await page
                        .locator(".dem-diff")
                        .getByRole("radio", { name: L("合在一起") })
                        .click();
                    await page.waitForTimeout(200);
                    await snap("editor-diff-inline");
                },
            },
        ],
    },
    records: {
        title: "表格和看板",
        pages: [
            {
                route: "#/screens/board",
                states: [
                    ["board-main", "看板"],
                    ["board-detail", "详情从右边滑出"],
                    ["table-main", "表格"],
                    ["table-batch", "选几行，批量操作"],
                ],
                run: async (page, snap) => {
                    await page.waitForSelector(".dem-records");
                    await page.waitForTimeout(400);
                    await snap("board-main");
                    await page.locator(".dem-board-card", { hasText: "研究助理" }).click();
                    await page.waitForTimeout(500);
                    await snap("board-detail");
                    await page.keyboard.press("Escape");
                    await page.waitForTimeout(450);
                    await page.getByRole("radio", { name: L("表格") }).click();
                    await page.waitForTimeout(300);
                    await snap("table-main");
                    const boxes = page.locator(".dem-table-row .dem-check");
                    await boxes.nth(1).click();
                    await boxes.nth(2).click();
                    await page.waitForTimeout(150);
                    await snap("table-batch");
                },
            },
        ],
    },
    launcher: {
        title: "启动器",
        pages: [
            {
                route: "#/screens/launcher",
                states: [
                    ["launcher-search", "搜索，认拼音首字母"],
                    ["launcher-command", "> 命令"],
                    ["launcher-command-arg", "> 命令带参数"],
                    ["launcher-ask", "? 问 AI"],
                    ["launcher-ask-window", "问 AI 的小窗口"],
                    ["launcher-ai-command", "?/ AI 指令"],
                    ["launcher-scope", "@ 选范围"],
                    ["launcher-scope-ask", "范围加问题"],
                    ["launcher-new", "+ 新建"],
                    ["launcher-new-type", "+ 新建某种类型"],
                    ["launcher-tag", "# 标签"],
                    ["launcher-private", "私密内容里 AI 变灰"],
                ],
                run: async (page, snap) => {
                    await workspaceReady(page);
                    await page.waitForTimeout(600);
                    const box = page.locator(".dem-launcher-box");
                    const typeIn = async (text) => {
                        if (await box.isVisible()) await page.keyboard.press("Escape");
                        await page.keyboard.press("ControlOrMeta+K");
                        await box.waitFor();
                        await page.locator(".dem-launcher-input").fill("");
                        await page.keyboard.type(text);
                        await page.waitForTimeout(200);
                    };
                    await typeIn("fy");
                    await snap("launcher-search");
                    await typeIn(typed(">切换", ">switch"));
                    await snap("launcher-command");
                    await page.keyboard.press("Tab");
                    await page.waitForTimeout(100);
                    await page.keyboard.type("求");
                    await page.waitForTimeout(200);
                    await snap("launcher-command-arg");
                    await typeIn("?这周法语学了什么");
                    await snap("launcher-ask");
                    await page.keyboard.press("Enter");
                    await page.waitForTimeout(500);
                    await snap("launcher-ask-window");
                    await page
                        .locator(".dem-ask")
                        .getByRole("button", { name: L("关闭") })
                        .click();
                    await typeIn("?/");
                    await snap("launcher-ai-command");
                    await typeIn("@法");
                    await snap("launcher-scope");
                    await page.keyboard.press("Enter");
                    await page.waitForTimeout(100);
                    await page.keyboard.type("?总结这周的错误");
                    await page.waitForTimeout(200);
                    await snap("launcher-scope-ask");
                    await page.keyboard.press("Escape");
                    await page.keyboard.press("ControlOrMeta+N");
                    await box.waitFor();
                    await page.waitForTimeout(200);
                    await snap("launcher-new");
                    await page.keyboard.type(typed("记忆卡 le quai 站台", "card le quai 站台"));
                    await page.waitForTimeout(200);
                    await snap("launcher-new-type");
                    await typeIn("#学");
                    await snap("launcher-tag");
                    await typeIn("10月17日");
                    await page.keyboard.press("Enter");
                    await page.waitForTimeout(300);
                    await typeIn("?/");
                    await snap("launcher-private");
                },
            },
            {
                route: "#/screens/capture",
                viewport: { width: 1000, height: 600 },
                states: [["capture", "全局收集小窗口"]],
                run: async (page, snap) => {
                    await page.waitForSelector(".dem-capture-input");
                    await page
                        .locator(".dem-capture-input")
                        .fill(typed("待办 周一问实习 A", "todo 周一问实习 A"));
                    await page.waitForTimeout(150);
                    await snap("capture");
                },
            },
        ],
    },
    settings: {
        title: "设置",
        pages: [
            {
                route: "#/screens/settings",
                states: [
                    ["settings-appearance", "外观"],
                    ["settings-search", "搜索设置"],
                    ["settings-shortcuts", "快捷键"],
                    ["settings-conflict", "快捷键冲突"],
                ],
                run: async (page, snap) => {
                    await page.waitForSelector(".dem-settings");
                    await page.waitForTimeout(500);
                    const settings = page.locator(".dem-settings");
                    await snap("settings-appearance");
                    const search = settings.getByPlaceholder(L("搜索设置"));
                    await search.fill(typed("zh", "size"));
                    await page.waitForTimeout(200);
                    await snap("settings-search");
                    await search.fill("");
                    await settings.getByRole("button", { name: L("快捷键") }).click();
                    await page.waitForTimeout(200);
                    await snap("settings-shortcuts");
                    await settings
                        .locator(".dem-shortcut", {
                            has: page.getByText(L("新建"), { exact: true }),
                        })
                        .locator(".dem-shortcut-kbd")
                        .click();
                    await page.keyboard.press("ControlOrMeta+K");
                    await page.waitForTimeout(200);
                    await snap("settings-conflict");
                },
            },
        ],
    },
    privacy: {
        title: "隐私层级",
        pages: [
            {
                route: "#/screens/privacy",
                states: [
                    ["privacy-normal", "普通"],
                    ["privacy-sensitive", "敏感"],
                    ["privacy-sensitive-auth", "敏感：先开授权对话"],
                    ["privacy-private", "私密：AI 和搜索变灰"],
                    ["privacy-secret-locked", "机密：打开前验证"],
                    ["privacy-secret-password", "机密：用主密码"],
                    ["privacy-secret-open", "机密：验证通过"],
                    ["privacy-ai-answer", "AI 回答里受保护的链接"],
                    ["privacy-lower", "调低层级要确认"],
                ],
                run: async (page, snap) => {
                    await workspaceReady(page);
                    await page.waitForTimeout(600);
                    const sheet = page.locator(".dv-groupview .dem-sheet:visible");
                    await showTab(page, "lesson");
                    await snap("privacy-normal");
                    await showTab(page, "resume");
                    await snap("privacy-sensitive");
                    await sheet.getByRole("button", { name: L("总结") }).click();
                    await page.waitForTimeout(250);
                    await snap("privacy-sensitive-auth");
                    await page.keyboard.press("Escape");
                    await page.waitForTimeout(200);
                    await showTab(page, "diary");
                    await sheet.locator(".dem-prose p").first().click({ button: "right" });
                    await page.waitForTimeout(250);
                    await snap("privacy-private");
                    await page.keyboard.press("Escape");
                    await page.waitForTimeout(200);
                    await showTab(page, "papers");
                    await snap("privacy-secret-locked");
                    const gate = page.locator(".dem-secret-gate:visible");
                    await page.evaluate(() => (window.__systemVerify = "unavailable"));
                    await gate.getByRole("button", { name: L("验证") }).click();
                    await page.waitForTimeout(600);
                    await gate.locator("input").fill("wrong");
                    await gate.getByRole("button", { name: L("打开") }).click();
                    await page.waitForTimeout(500);
                    await snap("privacy-secret-password");
                    await gate.locator("input").fill("correct horse");
                    await gate.getByRole("button", { name: L("打开") }).click();
                    await page.waitForTimeout(600);
                    await snap("privacy-secret-open");
                    await showTab(page, "ai");
                    await snap("privacy-ai-answer");
                    await showTab(page, "diary");
                    await sheet.getByRole("button", { name: L("隐私层级") }).click();
                    await page.waitForTimeout(150);
                    await page.getByRole("menuitem", { name: L("普通") }).click();
                    await page.waitForTimeout(250);
                    await snap("privacy-lower");
                },
            },
        ],
    },
};

/** Text wider than its box, or running past something that clips it. Runs in the page. */
function findOverflow() {
    const out = [];
    const visible = (el) => el.checkVisibility?.({ checkVisibilityCSS: true }) ?? true;
    for (const el of document.querySelectorAll("body *")) {
        if (el.closest(".dem-code-view, .dem-code-input, .dem-mermaid-svg, svg, textarea"))
            continue;
        if (el.closest(".dv-live-region")) continue;
        const clipped = getComputedStyle(el);
        if (clipped.position === "absolute" && el.clientWidth <= 1) continue; // for screen readers
        const text = [...el.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent.trim())
            .join("");
        if (!text || !visible(el)) continue;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const style = getComputedStyle(el);
        let kind = null;
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
            kind = style.textOverflow === "ellipsis" ? "truncated" : "overflow";
        if (!kind && (box.right > innerWidth + 1 || box.bottom > innerHeight + 1)) {
            const inScroller = (() => {
                for (let p = el.parentElement; p; p = p.parentElement)
                    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return true;
                return false;
            })();
            if (!inScroller) kind = "offscreen";
        }
        if (!kind)
            for (let p = el.parentElement; p; p = p.parentElement) {
                const o = getComputedStyle(p);
                if (o.overflowX !== "hidden" && o.overflowX !== "clip") continue;
                if (box.right > p.getBoundingClientRect().right + 1) kind = "clipped";
                break;
            }
        if (kind)
            out.push({
                kind,
                text: text.slice(0, 60),
                cls: String(el.className).slice(0, 50),
            });
    }
    return out;
}

mkdirSync(OUT, { recursive: true });
let failed = 0;
const overflow = new Map();
for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});
    for (const mode of MODES) {
        const dir = join(OUT, `${engine.name()}-${mode}`);
        mkdirSync(dir, { recursive: true });
        for (const [gid, group] of Object.entries(GROUPS)) {
            if (only && only !== gid) continue;
            for (const def of group.pages) {
                const context = await browser.newContext({
                    locale: "zh-CN",
                    viewport: def.viewport ?? { width: 1440, height: 900 },
                    deviceScaleFactor: 1,
                    colorScheme: mode,
                });
                if (english)
                    await context.addInitScript(() =>
                        localStorage.setItem(
                            "dem.settings.appearance",
                            JSON.stringify({ locale: "en" }),
                        ),
                    );
                const page = await context.newPage();
                const errors = [];
                page.on("pageerror", (e) => errors.push(String(e)));
                const snap = async (id) => {
                    await page.screenshot({
                        path: join(dir, `${id}.jpg`),
                        type: "jpeg",
                        quality: 82,
                    });
                    for (const o of await page.evaluate(findOverflow)) {
                        const key = `${o.kind} | ${o.cls} | ${o.text}`;
                        if (!overflow.has(key)) overflow.set(key, id);
                    }
                };
                await page.goto(`${base}${def.route}`);
                try {
                    await def.run(page, snap);
                } catch (e) {
                    failed++;
                    console.log(
                        `${engine.name()} ${mode} ${gid}: ${e.message.split("\n").slice(0, 8).join(" / ")}`,
                    );
                }
                if (errors.length) {
                    failed++;
                    console.log(`${engine.name()} ${mode} ${gid}: ${errors.join("; ")}`);
                }
                await context.close();
            }
            console.log(`${engine.name()} ${mode} ${gid} done`);
        }
    }
    await browser.close();
}
await server.close();

const report = [...overflow].map(([k, id]) => `${id}: ${k}`).sort();
console.log(`text that does not fit (${english ? "English" : "Chinese"}): ${report.length}`);
for (const line of report) console.log("  " + line);
if (english) console.log(`shots: ${OUT}`);
else if (!only) {
    const groups = Object.values(GROUPS).map((g) => ({
        title: g.title,
        states: g.pages.flatMap((p) => p.states),
    }));
    writeFileSync(new URL("index.html", SHOTS), buildGalleryPage(groups));
}
console.log(failed ? `${failed} problems` : "gallery done");
process.exit(failed ? 1 : 0);
