// Drives the editor review page (#/screens/editor, P0.5-07-5) in Chromium and WebKit: long-text
// fonts, the Mermaid drawing, edit and read modes, the selection bar, link peeks and ⌘-click,
// memory cards, the private note's greyed AI and the version comparison. Starts its own Vite server.
// Run: pnpm run probe:editor
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
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 编辑器：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
        );
    };
    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});
    const open = async (mode, query = "") => {
        const page = await browser.newPage({
            locale: "zh-CN",
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            colorScheme: mode,
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(`${base}#/screens/editor${query}`);
        await page.waitForSelector(".dem-prose");
        return { page, errors };
    };
    const prose = (page) => page.locator(".dem-sheet .dem-prose").first();

    for (const mode of ["light", "dark"]) {
        const { page, errors } = await open(mode);
        await page.waitForSelector(".dem-mermaid-svg svg", { timeout: 15000 }).catch(() => {});
        check(
            `${mode}：Mermaid 画出来了`,
            (await page.locator(".dem-mermaid-svg svg").count()) === 1,
        );
        const font = await prose(page).evaluate((el) => getComputedStyle(el).fontFamily);
        check(`${mode}：正文用霞鹜文楷`, /LXGW WenKai/.test(font), font);
        if (mode === "dark") {
            await page
                .locator(".dem-sheet-body")
                .first()
                .evaluate((el) => (el.scrollTop = 900));
            await page.waitForTimeout(300);
            check("深色页面没有报错", errors.length === 0, errors);
            await page.close();
            continue;
        }

        // The selection bar follows a selection in the text and Esc puts it away.
        await prose(page)
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
        const bar = page.locator(".dem-selbar");
        check("选中文字浮出小工具条", await bar.isVisible());
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        check("Esc 收起小工具条", !(await bar.isVisible()));
        await page.evaluate(() => getSelection().removeAllRanges());

        // Links: a click peeks, ⌘-click opens a tab, a missing target offers to create it.
        await prose(page).locator(".dem-wikilink", { hasText: "第 11 课" }).click();
        const peek = page.locator(".dem-peek");
        await peek.waitFor({ timeout: 3000 }).catch(() => {});
        check("点内链出悬浮预览", (await peek.textContent())?.includes("être 和 avoir"));
        await page.waitForTimeout(400); // let the opening animation finish
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        check("Esc 关掉悬浮预览", !(await peek.isVisible()));
        const tabsBefore = await page.evaluate(() => window.__ws.tabs().length);
        await prose(page)
            .locator(".dem-wikilink", { hasText: "阴阳性" })
            .click({ modifiers: ["ControlOrMeta"] });
        await page.waitForTimeout(300);
        const tabs = await page.evaluate(() => window.__ws.tabs().map((t) => t.title));
        check(
            "⌘ 点内链在新页签打开",
            tabs.length === tabsBefore + 1 && tabs.includes("讲课：阴阳性"),
            tabs,
        );
        await page.evaluate(() => {
            const t = window.__ws.tabs().find((x) => x.contentId === "l12");
            window.__ws.activate(t.id);
        });
        await page.waitForTimeout(200);
        await prose(page).locator(".dem-wikilink[data-missing]").click();
        await page.waitForTimeout(200);
        check("不存在的条目提供新建", (await peek.textContent())?.includes("新建"));
        await page.keyboard.press("Escape");

        // Memory card: the answer shows on request.
        const card = prose(page).locator(".dem-card-block");
        check("记忆卡先不显示答案", (await card.locator(".dem-card-back").count()) === 0);
        await card.getByRole("button", { name: "看答案" }).click();
        check("点看答案显示背面", await card.locator(".dem-card-back").isVisible());

        // Code: typing re-highlights.
        const input = prose(page).locator(".dem-code-input");
        const venir = () =>
            prose(page).locator(".dem-code-view [data-tok=string]", { hasText: '"venir"' }).count();
        const before = await venir();
        await input.click();
        await input.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
        await page.keyboard.type('auxiliary("venir");');
        await page.waitForTimeout(150);
        check("代码块边打边上色", (await venir()) === before + 1, { before });

        const mermaid = prose(page).locator(".dem-mermaid");
        await mermaid.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);

        // Read mode: nothing editable, Mermaid without its source, formats off.
        await page.getByRole("radio", { name: "阅读" }).click();
        await page.waitForTimeout(400);
        const editable = await prose(page).getAttribute("contenteditable");
        check(
            "阅读：正文不可编辑，图只显示效果，格式按钮变灰",
            editable === "false" &&
                (await page.locator(".dem-mermaid-src").count()) === 0 &&
                (await page.getByRole("button", { name: "加粗" }).isDisabled()),
            { editable },
        );
        await mermaid.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.getByRole("radio", { name: "编辑" }).click();

        // The private note: AI greyed out with the reason.
        await page.evaluate(() => {
            const t = window.__ws.tabs().find((x) => x.contentId === "diary");
            window.__ws.activate(t.id);
        });
        await page.waitForTimeout(300);
        const ai = page.locator(".dem-sheet:visible").getByRole("button", { name: "总结" });
        check("私密笔记里 AI 变灰", await ai.isDisabled());

        // Version comparison: side by side with marks, then together.
        await page.evaluate(() => {
            const t = window.__ws.tabs().find((x) => x.contentId === "diff");
            window.__ws.activate(t.id);
        });
        await page.waitForTimeout(300);
        const diff = page.locator(".dem-diff");
        check(
            "版本对比并排：段落对齐，标出删和加",
            (await diff.locator(".dem-diff-row").count()) >= 5 &&
                (await diff.locator("del").count()) > 0 &&
                (await diff.locator("ins").count()) > 0,
        );
        await diff.getByRole("radio", { name: "合在一起" }).click();
        await page.waitForTimeout(200);
        check("切成合在一起", (await diff.locator(".dem-diff-inline").count()) === 1);
        check("页面没有报错", errors.length === 0, errors);
        await page.close();
    }
    await browser.close();
}

await server.close();
console.log(failed ? `${failed} checks failed` : "all editor checks passed");
process.exit(failed ? 1 : 0);
