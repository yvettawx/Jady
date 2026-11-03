// The whole app end to end: the real interface in a browser, talking to the real commands and the
// real core over the bridge (src-tauri/src/e2e.rs), on a throwaway library. From creating a library
// to reopening it after a lock; everything checked comes back from the encrypted files.
// Run: pnpm run probe:app   (SHOTS=<dir> also saves screenshots)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { createServer, preview } from "vite";

const ROOT = resolve(import.meta.dirname, "../../..");
const built = spawnSync(
    "cargo",
    ["build", "-q", "-p", "dem-desktop", "--features", "e2e", "--example", "e2e_bridge"],
    { cwd: ROOT, stdio: "inherit" },
);
if (built.status !== 0) process.exit(1);

// BUILT=1 tests the production files under the app's real content security policy instead.
const conf = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8"),
);
const csp = conf.app.security.csp.replace("connect-src", "connect-src http://127.0.0.1:1431");
const server = process.env.BUILT
    ? await preview({
          preview: { port: 4173, host: "127.0.0.1", headers: { "Content-Security-Policy": csp } },
          logLevel: "error",
      })
    : await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
if (!process.env.BUILT) await server.listen();
const base = server.resolvedUrls.local[0];
const SHOTS = process.env.SHOTS;
const ENGINES = process.env.ENGINE === "chromium" ? [chromium] : [webkit];
let failed = 0;
let port = 1431;

const PASSWORD = "Correct-horse-9";

/** Stands in for the parts of Tauri that are not commands: windows, dialogs, events. */
const shim = (bridge) => `
  window.__dialogs = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  let cb = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback: () => cb++,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      if (cmd === "plugin:dialog|open" || cmd === "plugin:dialog|save") return window.__dialogs.shift() ?? null;
      if (cmd === "plugin:notification|is_permission_granted") return false;
      if (cmd.startsWith("plugin:")) return null;
      const r = await fetch("${bridge}/" + cmd, { method: "POST", body: JSON.stringify(args ?? {}) });
      const body = await r.json();
      if (!r.ok) throw body;
      return body;
    },
  };
  window.print = () => { window.__printed = true; };
`;

for (const engine of ENGINES) {
    const name = engine.name();
    const check = (label, ok, detail) => {
        if (!ok) failed++;
        console.log(
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 软件：${label}${ok ? "" : "  " + JSON.stringify(detail ?? null)}`,
        );
    };
    const dir = mkdtempSync(join(tmpdir(), "dem-e2e-"));
    const bridgePort = port++;
    const bridge = spawn(
        join(ROOT, "target/debug/examples/e2e_bridge"),
        [String(bridgePort), dir],
        { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise((ok) => bridge.stdout.once("data", ok));

    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});
    const context = await browser.newContext({
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: process.env.DARK ? "dark" : "light",
    });
    await context.addInitScript(shim(`http://127.0.0.1:${bridgePort}`));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const shot = async (n) => {
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${n}.png`) });
    };
    const wait = (ms) => page.waitForTimeout(ms);
    const button = (n) => page.getByRole("button", { name: n, exact: true });

    try {
        await page.goto(base);

        // --- Creating a library ---
        await button("新建资料库").click({ timeout: 15000 });
        await shot("01-location");
        await button("下一步").click();
        await page.getByLabel("主密码", { exact: true }).fill(PASSWORD);
        await page.getByLabel("再输一次").fill(PASSWORD);
        await button("下一步").click();
        await page.getByText("我已经把恢复码存在安全的地方").waitFor({ timeout: 20000 });
        await wait(800);
        await shot("02-recovery");
        const text = await page.locator("body").innerText();
        const groups = [...text.matchAll(/^\d\n([0-9A-Z]{4})$/gm)].map((m) => m[1]);
        check("建库时显示恢复码", groups.length === 9, text.slice(0, 300));
        await page.getByText("我已经把恢复码存在安全的地方").click();
        await button("下一步").click();
        const lead = await page.getByText(/输入恢复码的第/).textContent();
        const [a, b] = lead.match(/\d+/g).map(Number);
        await page.getByLabel(`第 ${a} 组`).fill(groups[a - 1]);
        await page.getByLabel(`第 ${b} 组`).fill(groups[b - 1]);
        await button("创建").click();
        await page.waitForSelector(".dem-shell", { timeout: 15000 });
        await wait(1500);
        // --- 新手引导：语言、AI、模板，每一步都能跳过 ---
        await page.waitForSelector(".dem-welcome", { timeout: 5000 }).catch(async (e) => {
            await shot("02-welcome-missing");
            throw e;
        });
        await shot("02-welcome");
        await button("下一步").click();
        await page.getByText("Claude Code").first().waitFor({ timeout: 15000 });
        await shot("02-welcome-ai");
        check(
            "引导里能设置 AI",
            (await page.locator(".dem-welcome").innerText()).includes("Claude Code"),
        );
        await button("下一步").click();
        await wait(300);
        await shot("02-welcome-templates");
        await page.locator(".dem-templates").getByRole("button", { name: "添加" }).first().click();
        await wait(600);
        check(
            "引导里能加模板",
            (await page.locator(".dem-templates").innerText()).includes("已添加"),
        );
        await button("开始用").click();
        await wait(500);
        check("引导走完就关", (await page.locator(".dem-welcome").count()) === 0);
        await shot("03-home");
        check("建好进入工作台", (await page.locator(".dem-home").count()) === 1);

        const files = readdirSync(join(dir, "documents"), { recursive: true }).map(String);
        check(
            "资料库建在选的位置",
            files.some((f) => f.endsWith("library.dexm") || f.includes("items")),
            files.slice(0, 10),
        );

        // --- The directory and the first note ---
        await page.keyboard.press("Meta+Shift+E");
        await wait(800);
        await shot("04-after-tree");
        check(
            "欢迎笔记在目录里",
            (await page
                .locator(".dem-home-float, .dv-groupview")
                .getByText("从这里开始")
                .count()) >= 1,
        );
        await page.locator(".dem-tree-row:visible", { hasText: "从这里开始" }).click();
        await page.waitForSelector(".dem-pm", { timeout: 10000 });
        await wait(800);
        await shot("05-welcome");
        const prose = page.locator(".dem-pm:visible");
        check(
            "欢迎笔记的正文从核心来",
            (await prose.textContent()).includes("这是你的第一条笔记") &&
                (await prose.locator("h2").count()) === 2 &&
                (await prose.locator("li").count()) >= 4,
            await prose.innerHTML(),
        );
        await page.locator(".dem-sheet-title-input:visible").click();

        // --- A new note: title, text, formatting, autosave ---
        await page.keyboard.press("Meta+K");
        await wait(200);
        await page.keyboard.type("+笔记 第一篇");
        await wait(250);
        await page.keyboard.press("Enter");
        await page.waitForFunction(
            () =>
                [...document.querySelectorAll(".dem-sheet-title-input")].some(
                    (i) => i.value === "第一篇",
                ),
            null,
            { timeout: 8000 },
        );
        await wait(500);
        const body = page.locator(".dem-pm:visible");
        await body.click();
        await page.keyboard.type("## 小标题");
        await page.keyboard.press("Enter");
        await page.keyboard.type("第一段文字，搜索用词 chrysanthème。");
        await page.keyboard.press("Enter");
        await page.keyboard.type("- 列表一");
        await page.keyboard.press("Enter");
        await page.keyboard.type("列表二");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await page.keyboard.type("[ ] 任务一");
        await wait(200);
        check("输入规则生成标题", (await body.locator("h2").textContent()) === "小标题");
        check("输入规则生成列表", (await body.locator("ul li").count()) >= 2);
        check(
            "输入规则生成任务",
            (await body.locator("ul.dem-tasks input[type=checkbox]").count()) === 1,
            await body.innerHTML(),
        );
        await wait(1500);
        const noteId = await page.evaluate(() => window.__TAURI_INTERNALS__ && null);
        const status = await page.locator(".dem-statusbar").textContent();
        check("状态栏写已保存和字数", status.includes("已保存") && /\d+/.test(status), status);
        await shot("06-note");
        const outline = await page
            .locator(".dem-outline")
            .textContent()
            .catch(() => "");
        check("大纲跟着当前笔记", outline.includes("小标题"), outline);

        // Bold through the keyboard, then a link to another item through [[.
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await page.keyboard.type("看 [[从这里");
        await wait(300);
        await shot("07-link-picker");
        check("[[ 弹出链接列表", (await page.locator(".dem-suggest li").count()) >= 1);
        await page.keyboard.press("Enter");
        await wait(300);
        check(
            "选中后变成内链",
            (await body.locator(".dem-wikilink").textContent()).includes("从这里开始"),
            await body.innerHTML(),
        );
        await page.keyboard.press("Enter");
        await page.keyboard.type("/mer");
        await wait(300);
        check("/ 弹出插入菜单", (await page.locator(".dem-suggest li").count()) === 1);
        await page.keyboard.press("Enter");
        await page.keyboard.type("graph TD; A-->B");
        await wait(1200);
        check(
            "Mermaid 块画出图",
            (await body.locator(".dem-pm-diagram svg").count()) === 1,
            await body
                .locator(".dem-pm-code")
                .innerHTML()
                .catch((e) => String(e)),
        );
        await shot("08-mermaid");
        await page.keyboard.press("Meta+Enter");
        await wait(1200);

        // --- Undo, reading mode ---
        await page.keyboard.type("撤销这句");
        await wait(200);
        await page.keyboard.press("Meta+Z");
        await wait(300);
        check("⌘Z 撤销打的字", !(await body.textContent()).includes("撤销这句"));
        await page
            .locator(".dem-sheet:visible")
            .getByRole("radio", { name: "阅读" })
            .click({ force: true });
        await wait(200);
        check("阅读模式不能改", (await body.getAttribute("contenteditable")) === "false");
        await page
            .locator(".dem-sheet:visible")
            .getByRole("radio", { name: "编辑" })
            .click({ force: true });
        await wait(200);

        // --- A block can be dragged ---
        const order = () => body.locator("> *").evaluateAll((els) => els.map((e) => e.tagName));
        const was = await order();
        await body.locator("h2").first().hover();
        await wait(100);
        const hb = await page.locator(".dem-pm-handle:visible").first().boundingBox();
        const tb = await body.locator("ul").first().boundingBox();
        await page.mouse.move(hb.x + 5, hb.y + 5);
        await page.mouse.down();
        await page.mouse.move(hb.x + 30, hb.y + 40, { steps: 5 });
        await page.mouse.move(tb.x + 40, tb.y + 2, { steps: 5 });
        await wait(100);
        await page.mouse.up();
        await wait(400);
        const moved = await order();
        check("拖动手柄把块换了位置", moved.indexOf("H2") > was.indexOf("H2"), { was, moved });
        if (moved.indexOf("H2") !== was.indexOf("H2")) await page.keyboard.press("Meta+Z");
        await wait(300);

        // --- An image goes into the encrypted store and comes back ---
        await body.click();
        await page.evaluate(async () => {
            const png = Uint8Array.from(
                atob(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==",
                ),
                (c) => c.charCodeAt(0),
            );
            const dt = new DataTransfer();
            dt.items.add(new File([png], "dot.png", { type: "image/png" }));
            document.querySelector(".dem-pm").dispatchEvent(
                new ClipboardEvent("paste", {
                    clipboardData: dt,
                    bubbles: true,
                    cancelable: true,
                }),
            );
        });
        await wait(1200);
        check(
            "贴图存进库再显示出来",
            await body
                .locator(".dem-image img")
                .evaluate((i) => i.naturalWidth === 1)
                .catch(() => false),
            await body.locator(".dem-image").count(),
        );
        await page.keyboard.press("Meta+Enter");
        await wait(1200);

        // --- Search finds it through the real index ---
        await page.keyboard.press("Meta+Shift+F");
        await wait(300);
        await page.getByPlaceholder("搜索全部内容").fill("chrysantheme");
        await wait(700);
        await shot("09-search");
        check(
            "搜索不带重音也找到",
            (await page.locator(".dem-nav-title", { hasText: "第一篇" }).count()) === 1 &&
                (await page.locator(".dem-nav-snippet mark").count()) >= 1,
        );
        await page.getByPlaceholder("搜索全部内容").fill("第一段");
        await wait(700);
        check(
            "搜索中文也找到",
            (await page.locator(".dem-nav-title", { hasText: "第一篇" }).count()) === 1,
        );

        // --- Back link ---
        await page.keyboard.press("Meta+Shift+E");
        await wait(300);
        await page.locator(".dem-tree-row", { hasText: "从这里开始" }).click();
        await wait(1000);
        const backs = await page
            .locator(".dv-groupview .dem-nav-title", { hasText: "第一篇" })
            .count();
        check("反向链接列出链到这里的笔记", backs >= 1);

        // --- Fields, tags, privacy ---
        await page.keyboard.press("Meta+K");
        await wait(150);
        await page.keyboard.type("+待办 买火车票");
        await wait(250);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() =>
            [...document.querySelectorAll(".dem-sheet-title-input")].some(
                (i) => i.value === "买火车票",
            ),
        );
        await wait(500);
        check(
            "待办有状态字段",
            (await page.locator(".dem-fields-row:visible", { hasText: "状态" }).count()) === 1,
        );
        const tagInput = page.getByPlaceholder("加标签").locator("visible=true");
        await tagInput.fill("出行");
        await tagInput.press("Enter");
        await wait(500);
        check(
            "加标签",
            (await page.locator(".dem-tag:visible", { hasText: "出行" }).count()) === 1,
        );
        check(
            "新待办默认是下一步",
            (
                await page.locator(".dem-fields-row:visible", { hasText: "状态" }).textContent()
            ).includes("下一步"),
        );
        const due = page.locator(".dem-fields-date:visible input");
        await due.fill(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
        await wait(1000);
        await page.keyboard.press("Meta+Shift+H");
        await wait(900);
        await shot("10b-home-todo");
        check(
            "今日待办在首页",
            (await page.locator(".dem-home-widget", { hasText: "买火车票" }).count()) >= 1,
        );
        check(
            "过期的进提醒",
            (await page.locator(".dem-home-widget", { hasText: "提醒" }).textContent()).includes(
                "买火车票",
            ),
        );
        await page.keyboard.press("Meta+Shift+D");
        await wait(300);
        await page.locator(".dem-home-float .dem-nav-title", { hasText: "买火车票" }).click();
        await wait(600);
        await page.keyboard.press("Meta+Shift+D");
        await wait(500);
        check(
            "待办列表有这条",
            (await page.locator(".dem-nav-title", { hasText: "买火车票" }).count()) === 1,
        );
        await shot("10-todo");
        const box = page
            .locator(".dem-nav-row", { hasText: "买火车票" })
            .locator("input[type=checkbox]");
        await box.click();
        await wait(600);
        check("勾掉后到完成组", await box.isChecked());

        // --- Privacy: 机密 ---
        await page.keyboard.press("Meta+K");
        await wait(150);
        await page.keyboard.type("+笔记 证件号码");
        await wait(250);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() =>
            [...document.querySelectorAll(".dem-sheet-title-input")].some(
                (i) => i.value === "证件号码",
            ),
        );
        await wait(500);
        await page.locator(".dem-pm:visible").click();
        await page.keyboard.type("秘密文字 zzsecretzz");
        await wait(1200);
        await page.locator(".dem-privacy-picker:visible").click();
        await page.getByRole("menuitem", { name: "机密" }).click();
        await wait(800);
        check("调成机密立刻要验证", (await page.locator(".dem-secret-gate:visible").count()) === 1);
        check("验证前正文不在页面里", !(await page.content()).includes("zzsecretzz"));
        await shot("11-secret");
        const gate = page.locator(".dem-secret-gate:visible");
        await gate.getByLabel("主密码").fill("wrong password");
        await gate.getByRole("button", { name: "打开" }).click();
        await gate
            .getByText("主密码不对")
            .waitFor({ timeout: 20000 })
            .catch(() => {});
        check("主密码错了进不去", (await gate.textContent()).includes("主密码不对"));
        await gate.getByLabel("主密码").fill(PASSWORD);
        await gate.getByRole("button", { name: "打开" }).click();
        await page.waitForSelector(".dem-pm:visible", { timeout: 8000 });
        await wait(500);
        check(
            "主密码对了看到正文",
            (await page.locator(".dem-pm:visible").textContent()).includes("zzsecretzz"),
        );
        await page.keyboard.press("Meta+Shift+F");
        await wait(300);
        await page.getByPlaceholder("搜索全部内容").fill("zzsecretzz");
        await wait(800);
        check(
            "机密正文搜不到",
            (await page.locator(".dem-nav-title", { hasText: "证件号码" }).count()) === 0,
        );
        await page.getByPlaceholder("搜索全部内容").fill("证件");
        await wait(800);
        check(
            "机密标题搜不到",
            (await page.locator(".dem-nav-title", { hasText: "证件号码" }).count()) === 0,
        );
        await page.getByPlaceholder("搜索全部内容").fill("");
        await page.keyboard.press("Meta+K");
        await wait(150);
        await page.keyboard.type("证件");
        await wait(300);
        check(
            "机密在启动器里搜不到",
            !(await page.locator(".dem-launcher-box").textContent()).includes("证件号码"),
        );
        await page.keyboard.press("Escape");
        await wait(200);
        await page.keyboard.press("Meta+Shift+E");
        await wait(400);
        check(
            "机密标题只在目录里",
            (await page.locator(".dem-tree-row", { hasText: "证件号码" }).count()) === 1,
        );

        // --- Import a table: the job database case (P1 completion) ---
        const csv = join(dir, "投递.csv");
        writeFileSync(
            csv,
            "公司,职位,状态,截止日期\n" +
                Array.from(
                    { length: 12 },
                    (_, i) =>
                        `公司${i + 1},职位${i + 1},${["想投", "已投", "面试"][i % 3]},2026-12-${String(i + 1).padStart(2, "0")}`,
                ).join("\n") +
                "\n",
        );
        await page.keyboard.press("Meta+,");
        await wait(500);
        await page.locator(".dem-settings:visible").getByRole("button", { name: "资料库" }).click();
        await wait(300);
        await shot("12-library-settings");
        await page.evaluate((p) => window.__dialogs.push(p), csv);
        await page.locator(".dem-setting", { hasText: "导入表格" }).getByRole("button").click();
        await wait(1200);
        check(
            "导入表格有提示",
            (await page.locator("body").textContent()).includes("导入了 12 条"),
        );
        await page.keyboard.press("Meta+Shift+Y");
        await wait(400);
        await page.locator(".dem-nav-row", { hasText: "投递" }).locator(".dem-nav-open").click();
        await wait(900);
        await shot("13-table");
        const rec = page.locator(".dem-records:visible");
        check(
            "导入的表格显示 12 条",
            (await rec.locator(".dem-records-count").textContent()).includes("12"),
        );
        const seg = rec.getByRole("radio", { name: "看板" });
        if (await seg.count()) await seg.click({ force: true });
        await wait(500);
        await shot("14-board");
        check(
            "看板按状态分列",
            (await rec.getByText("想投").count()) >= 1 &&
                (await rec.getByText("面试").count()) >= 1,
        );

        // --- A custom type ---
        await page.locator(".dem-nav-tools").getByRole("button", { name: "新建类型" }).click();
        await wait(300);
        const editor = page.locator(".dem-type-editor:visible");
        await editor.getByLabel("类型名称").fill("书单");
        await editor.getByPlaceholder("字段名").first().fill("作者");
        await shot("15-type");
        await editor.getByRole("button", { name: "保存" }).click();
        await wait(900);
        check(
            "自定义类型建好并打开",
            (await page.locator(".dem-records-title:visible").textContent()) === "书单",
        );

        // --- Versions ---
        await page.keyboard.press("Meta+Shift+E");
        await wait(300);
        await page.locator(".dem-tree-row", { hasText: "第一篇" }).click();
        await page.waitForSelector(".dem-pm:visible");
        await wait(500);
        await page
            .locator(".dem-sheet:visible")
            .first()
            .getByRole("button", { name: "更多" })
            .click();
        await page.getByRole("menuitem", { name: "版本历史" }).click();
        await wait(1200);
        await shot("16-versions");
        check("版本历史有内容", (await page.locator(".dem-versions-row:visible").count()) >= 2);
        check("版本对比显示", (await page.locator(".dem-diff:visible").count()) === 1);

        // --- Export ---
        const out = join(dir, "第一篇.md");
        await page.locator(".dem-tree-row:visible", { hasText: "第一篇" }).click();
        await wait(600);
        await page.evaluate((p) => window.__dialogs.push(p), out);
        await page
            .locator(".dem-sheet:visible")
            .first()
            .getByRole("button", { name: "更多" })
            .click();
        await page.getByRole("menuitem", { name: "导出 Markdown" }).click();
        await wait(1000);
        const md = readFileSync(out, "utf8");
        check(
            "导出 Markdown",
            md.includes("## 小标题") && md.includes("- 列表一") && md.includes("[[从这里开始]]"),
            md,
        );
        await page
            .locator(".dem-sheet:visible")
            .first()
            .getByRole("button", { name: "更多" })
            .click();
        await page.getByRole("menuitem", { name: "打印或存成 PDF" }).click();
        await wait(200);
        check("打印调用系统打印", await page.evaluate(() => window.__printed === true));

        // --- Going back to an earlier version ---
        await page
            .locator(".dem-sheet:visible")
            .first()
            .getByRole("button", { name: "更多" })
            .click();
        await page.getByRole("menuitem", { name: "版本历史" }).click();
        await wait(1000);
        await page.locator(".dem-versions-restore:visible button").click();
        await page.locator(".dem-dialog").getByRole("button", { name: "恢复" }).click();
        await wait(1200);
        await page.locator(".dem-tree-row:visible", { hasText: "第一篇" }).click();
        await wait(800);
        check(
            "恢复旧版本后正文跟着变",
            !(await page.locator(".dem-pm:visible").textContent()).includes("第一段文字"),
        );
        await page
            .locator(".dem-sheet:visible")
            .first()
            .getByRole("button", { name: "更多" })
            .click();
        await page.getByRole("menuitem", { name: "版本历史" }).click();
        await wait(1000);
        await page.locator(".dem-versions-row:visible", { hasText: "恢复前" }).first().click();
        await wait(500);
        await page.locator(".dem-versions-restore:visible button").click();
        await page.locator(".dem-dialog").getByRole("button", { name: "恢复" }).click();
        await wait(1200);
        await page.locator(".dem-tree-row:visible", { hasText: "第一篇" }).click();
        await wait(800);
        check(
            "再恢复回来，文字都在",
            (await page.locator(".dem-pm:visible").textContent()).includes("第一段文字"),
        );

        // --- Same note in two tabs stays the same ---
        await page
            .locator(".dem-sheet:visible")
            .first()
            .getByRole("button", { name: "更多" })
            .click();
        await page.getByRole("menuitem", { name: "在旁边打开" }).click();
        await wait(1000);
        const twin = page.locator(".dem-pm:visible");
        check("在旁边打开", (await twin.count()) === 2, await twin.count());
        await twin.first().click();
        await page.keyboard.press("Meta+End");
        await page.keyboard.type("两边同步");
        await wait(1500);
        check("一边打字另一边跟着变", (await twin.last().textContent()).includes("两边同步"));
        await page.keyboard.press("Meta+Z");
        await wait(1200);

        // --- Favorites, archive, when ---
        await page
            .locator(".dem-sheet:visible")
            .first()
            .getByRole("button", { name: "更多" })
            .click();
        await page.getByRole("menuitem", { name: "收藏" }).click();
        await page.keyboard.press("Meta+Shift+B");
        await wait(400);
        check(
            "收藏视图有这条",
            (await page.locator(".dem-nav-title:visible", { hasText: "第一篇" }).count()) === 1,
        );
        await page.keyboard.press("Meta+Shift+E");
        await wait(300);
        const when = page.getByPlaceholder("比如 公元前 221 年").locator("visible=true").first();
        await when.fill("前 221");
        await when.press("Enter");
        await wait(700);
        check(
            "历史日期读懂写法",
            (await page
                .getByLabel("时间", { exact: true })
                .locator("visible=true")
                .first()
                .inputValue()) === "公元前221年",
        );

        // --- A file: kept whole, text searchable ---
        const txt = join(dir, "讲义.txt");
        writeFileSync(txt, "文件里的独特词 zzfilezz");
        await page.keyboard.press("Meta+,");
        await wait(500);
        await page.locator(".dem-settings:visible").getByRole("button", { name: "资料库" }).click();
        await wait(300);
        await page.evaluate((p) => window.__dialogs.push([p]), txt);
        await page.locator(".dem-setting", { hasText: "导入文件" }).getByRole("button").click();
        await wait(1200);
        await page.keyboard.press("Meta+Shift+F");
        await wait(300);
        await page.getByPlaceholder("搜索全部内容").fill("zzfilezz");
        await wait(800);
        check(
            "导入的文件文字能搜到",
            (await page.locator(".dem-nav-title:visible", { hasText: "讲义" }).count()) === 1,
        );
        // --- The index can always be rebuilt from the items (P1 completion) ---
        await page.keyboard.press("Meta+,");
        await wait(400);
        await page.locator(".dem-settings:visible").getByRole("button", { name: "资料库" }).click();
        await page.locator(".dem-setting", { hasText: "重建索引" }).getByRole("button").click();
        await wait(1500);
        check("重建索引", (await page.locator("body").textContent()).includes("索引重建完成"));
        await page.keyboard.press("Meta+Shift+F");
        await wait(300);
        await page.getByPlaceholder("搜索全部内容").fill("第一段");
        await wait(800);
        check(
            "重建后还能搜到",
            (await page.locator(".dem-nav-title:visible", { hasText: "第一篇" }).count()) === 1,
        );
        await page.getByPlaceholder("搜索全部内容").fill("");
        await page.keyboard.press("Meta+Shift+E");
        await wait(300);
        await page.locator(".dem-tree-row:visible", { hasText: "第一篇" }).click();
        await wait(600);

        // --- Trash and undo ---
        await page.locator(".dem-tree-row", { hasText: "第一篇" }).click();
        await wait(600);
        await page
            .locator(".dem-sheet:visible")
            .first()
            .getByRole("button", { name: "更多" })
            .click();
        await page.getByRole("menuitem", { name: "放进回收站" }).click();
        await wait(800);
        check(
            "放进回收站后目录没有了",
            (await page.locator(".dem-tree-row", { hasText: "第一篇" }).count()) === 0,
        );
        await page.getByRole("button", { name: "撤销" }).click();
        await wait(800);
        check(
            "撤销放回来",
            (await page.locator(".dem-tree-row", { hasText: "第一篇" }).count()) === 1,
        );

        // --- Layout and text survive a lock ---
        await page.locator(".dem-tree-row", { hasText: "第一篇" }).click();
        await wait(1500);
        await page.keyboard.press("Meta+Shift+L");
        await page.waitForSelector(".gate-card, [class*=gate]", { timeout: 8000 });
        await wait(800);
        await shot("17-locked");
        check("锁定后回到解锁页", (await page.locator(".dem-shell").count()) === 0);
        check("锁定后页面里没有正文", !(await page.content()).includes("第一段文字"));
        await page.getByLabel("主密码").fill(PASSWORD);
        await button("解锁").click();
        await page.waitForSelector(".dem-shell", { timeout: 15000 });
        await wait(1500);
        await shot("18-reopened");
        check(
            "布局还在：标签页恢复",
            await page.evaluate(() => document.querySelectorAll(".dem-ws-tab").length > 3),
        );
        await page.keyboard.press("Meta+Shift+E");
        await wait(400);
        await page.locator(".dem-tree-row:visible", { hasText: "第一篇" }).click();
        await page.waitForSelector(".dem-pm:visible");
        await wait(800);
        const after = await page.locator(".dem-pm:visible").first().textContent();
        check(
            "重新解锁后文字都在",
            after.includes("第一段文字") && after.includes("graph TD"),
            after,
        );
        check(
            "内链和任务都存下来了",
            (await page.locator(".dem-pm:visible .dem-wikilink").count()) >= 1 &&
                (await page.locator(".dem-pm:visible ul.dem-tasks").count()) >= 1,
        );

        // --- 全局收集 in its own window ---
        const cap = await context.newPage();
        await cap.goto(`${base}#/capture`);
        await cap.waitForSelector(".dem-capture-input");
        await cap.locator(".dem-capture-input").fill("随手记一句");
        await cap.keyboard.press("Enter");
        await cap.waitForTimeout(800);
        await cap.close();
        // The real app tells every window through an event; the bridge has no events.
        await page.reload();
        await page.waitForSelector(".dem-shell");
        await wait(1000);
        await page.keyboard.press("Meta+Shift+I");
        await wait(800);
        check(
            "全局收集进收集箱",
            (await page.locator(".dem-nav-title:visible", { hasText: "随手记一句" }).count()) === 1,
        );

        // --- Nothing readable on disk ---
        const walk = (p) =>
            statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : [p];
        const leaked = walk(join(dir, "documents")).filter((f) => {
            const data = readFileSync(f);
            return ["第一段文字", "chrysanth", "zzsecretzz", "买火车票"].some((w) =>
                data.includes(w),
            );
        });
        check("库文件里读不出内容", leaked.length === 0, leaked);
    } catch (e) {
        check("流程走完", false, String(e).slice(0, 800));
        await shot("99-failed");
    }
    const real = errors.filter(
        (e) =>
            !/Failed to load resource|ResizeObserver|texImage3D|Cannot find the loroNode|Notification prompting/.test(
                e,
            ),
    );
    check("页面没有报错", real.length === 0, real.slice(0, 5));
    await context.close();
    await browser.close();
    bridge.kill();
    rmSync(dir, { recursive: true, force: true });
}

await (server.httpServer ?? server).close?.();
console.log(failed ? `${failed} checks failed` : "all app checks passed");
process.exit(failed ? 1 : 0);
