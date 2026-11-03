// Drives the launcher (#/screens/launcher, P0.5-07-7) in Chromium and WebKit: ⌘K, ⌘N and the
// AI button, every kind of input in docs/05-design.md §4.2 (full-width symbols included), the
// keys in §4.3, chips coming off with Backspace, AI greyed in private content, Enter ignored
// while an input method composes (Chromium), and the capture window. Starts its own Vite server.
// Run: pnpm run probe:launcher
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
let failed = 0;

for (const engine of [chromium, webkit]) {
    const name = engine.name();
    const check = (label, ok, detail) => {
        if (!ok) failed++;
        console.log(
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 启动器：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
        );
    };
    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});
    const page = await browser.newPage({
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}#/screens/launcher`);
    await page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 0);
    await page.waitForTimeout(600);

    const box = page.locator(".dem-launcher-box");
    const input = page.locator(".dem-launcher-input");
    const items = page.locator(".dem-launcher-item");
    const titles = () => items.locator(".dem-launcher-title").allTextContents();
    /** Opens the launcher afresh and types `text`. */
    const typeIn = async (text) => {
        if (await box.isVisible()) await page.keyboard.press("Escape");
        await page.keyboard.press("ControlOrMeta+K");
        await box.waitFor();
        await input.fill("");
        await page.keyboard.type(text);
        await page.waitForTimeout(150);
    };
    const active = () => page.evaluate(() => window.__ws.tabs().find((t) => t.isActive)?.title);

    // ⌘K, pinyin initials, arrows and Enter.
    await typeIn("fy");
    check("⌘K 打开，拼音首字母 fy 找到法语排第一", (await titles())[0] === "法语", await titles());
    await page.keyboard.press("ArrowDown");
    const second = await page
        .locator(".dem-launcher-item[data-active] .dem-launcher-title")
        .textContent();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    check(
        "↓ 选下一个，回车打开",
        second !== "法语" && (await active()) === "法语" && !(await box.isVisible()),
        {
            second,
            active: await active(),
        },
    );

    // ⌘↵ new tab, ⇧↵ split.
    const tabs0 = await page.evaluate(() => window.__ws.tabs().length);
    await typeIn("第 3 课");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForTimeout(300);
    const tabs1 = await page.evaluate(() => window.__ws.tabs().length);
    await typeIn("第 4 课");
    const shape0 = await page.evaluate(() => JSON.stringify(window.__ws.shape()));
    await page.keyboard.press("Shift+Enter");
    await page.waitForTimeout(400);
    const shape1 = await page.evaluate(() => JSON.stringify(window.__ws.shape()));
    check("⌘↵ 新页签，⇧↵ 分屏", tabs1 === tabs0 + 1 && shape1 !== shape0, {
        tabs0,
        tabs1,
        shape0,
        shape1,
    });

    // Commands: Tab completes the name, then an argument.
    await typeIn(">切换");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
    check("Tab 补全命令名", (await input.inputValue()) === "切换空间 ", await input.inputValue());
    await page.keyboard.type("求");
    await page.waitForTimeout(150);
    const accent0 = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--dem-accent"),
    );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const accent1 = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--dem-accent"),
    );
    check(">切换空间 求 切到求职空间", accent0 !== accent1, { accent0, accent1 });
    await page.keyboard.press("ControlOrMeta+1");
    await page.waitForTimeout(400);

    // Full-width ？ from an IME counts; the question becomes a small AI window.
    await typeIn("？这周法语学了什么");
    check(
        "全角？进入问 AI",
        (await page.locator(".dem-launcher-mode").textContent())?.includes("问 AI"),
    );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const ask = page.locator(".dem-ask");
    check("回车变成小对话窗口", (await ask.textContent())?.includes("这周法语学了什么"));
    await ask.getByRole("button", { name: "关闭" }).click();

    // ?/ lists the AI commands; a scope chip combines with it.
    await typeIn("?/");
    check("?/ 列出四个 AI 指令", (await items.count()) === 4, await titles());
    await typeIn("@法");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    await page.keyboard.type("?总结这周的错误");
    await page.waitForTimeout(150);
    check(
        "@法 选中后变成范围标签，再接 ?",
        (await page.locator(".dem-launcher-scope").textContent()) === "@法语" &&
            (await input.inputValue()) === "总结这周的错误",
        await input.inputValue(),
    );
    // Home does not reach the start of an input on macOS (⌘← does); place the caret directly.
    await input.evaluate((el) => el.setSelectionRange(0, 0));
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(100);
    const afterOne = await page.locator(".dem-launcher-mode").count();
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(100);
    check(
        "在开头按退格，先去掉模式，再去掉范围",
        afterOne === 0 && (await page.locator(".dem-launcher-scope").count()) === 0,
        { afterOne },
    );

    // + : the types, a named type, the inbox; ⌘N opens with +.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+N");
    await box.waitFor();
    await page.waitForTimeout(150);
    check(
        "⌘N 打开并进入新建",
        (await page.locator(".dem-launcher-mode").textContent())?.includes("新建"),
    );
    check("只有 + 时列出收集箱和四种类型", (await items.count()) === 5, await titles());
    await page.keyboard.type("记忆卡 le quai 站台");
    await page.waitForTimeout(150);
    check("认出记忆卡类型", (await titles())[0] === "新建记忆卡：le quai 站台", await titles());
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    check("新建后提示放到了哪里", await page.getByText("已新建记忆卡：le quai 站台").isVisible());
    await typeIn("+买火车票");
    check("没写类型就进收集箱", (await titles())[0] === "放进收集箱：买火车票", await titles());

    // # tags.
    await typeIn("#学");
    check("#学 找到标签 #学习", (await titles()).includes("#学习"), await titles());

    // Private content: AI greyed with the reason.
    await typeIn("10月17日");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await typeIn("?/");
    const disabled = await items.first().getAttribute("aria-disabled");
    check(
        "私密内容里 AI 指令变灰并写明原因",
        disabled === "true" && (await items.first().textContent())?.includes("AI 看不到"),
    );
    await page.keyboard.press("Escape");

    // The AI button opens the launcher ready to ask.
    await page.locator(".dem-ai-button").click();
    await box.waitFor();
    check(
        "点 AI 按钮打开并进入问 AI",
        (await page.locator(".dem-launcher-mode").textContent())?.includes("问 AI"),
    );
    await page.keyboard.press("Escape");

    // Chromium can compose like an IME: Enter while composing picks characters, runs nothing.
    if (engine === chromium) {
        await typeIn("");
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.imeSetComposition", {
            text: "fa",
            selectionStart: 2,
            selectionEnd: 2,
        });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(150);
        check("输入法组字时按回车不执行", await box.isVisible());
        await page.keyboard.press("Escape");
    }
    check("页面没有报错", errors.length === 0, errors);
    await page.close();

    // The capture window.
    for (const mode of ["light", "dark"]) {
        const cap = await browser.newPage({
            locale: "zh-CN",
            viewport: { width: 1000, height: 600 },
            colorScheme: mode,
        });
        await cap.goto(`${base}#/screens/capture`);
        await cap.waitForSelector(".dem-capture-input");
        await cap.locator(".dem-capture-input").fill("待办 周一问实习 A");
        await cap.waitForTimeout(100);
        if (mode === "light") {
            check(
                "收集窗口认出待办",
                (await cap.locator(".dem-capture-where").textContent()) === "待办",
            );
            await cap.locator(".dem-capture-input").press("Enter");
            await cap.waitForTimeout(200);
            check("回车收下", await cap.getByText("已新建待办：周一问实习 A").isVisible());
            await cap.locator(".dem-capture-input").press("Escape");
            check("Esc 关掉", (await cap.locator(".dem-capture").count()) === 0);
        }
        await cap.close();
    }
    await browser.close();
}

await server.close();
console.log(failed ? `${failed} checks failed` : "all launcher checks passed");
process.exit(failed ? 1 : 0);
