// Drives the privacy review page (#/screens/privacy, P0.5-07-9) in Chromium and WebKit: what
// each of the four levels shows and allows, changing a level, the gate before 机密 content in
// all its states, secret items staying out of the launcher, and an AI answer that shows no
// title of anything AI cannot read.
// Run: pnpm run probe:privacy
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
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 隐私：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
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
    await page.goto(`${base}#/screens/privacy`);
    await page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 0);
    await page.waitForTimeout(600);

    const show = async (id) => {
        await page.evaluate((c) => {
            const t = window.__ws.tabs().find((x) => x.contentId === c);
            window.__ws.activate(t.id);
        }, id);
        await page.waitForTimeout(250);
    };
    const sheet = page.locator(".dv-groupview .dem-sheet:visible");
    const ai = () => sheet.getByRole("button", { name: "总结" });
    const status = page.locator(".dem-statusbar");
    const menuFor = async () => {
        await sheet.locator(".dem-prose p").first().click({ button: "right" });
        await page.waitForTimeout(200);
        return page.getByRole("menu");
    };

    // 普通
    await show("lesson");
    check(
        "普通：没有标记，AI 可用",
        (await status.locator(".dem-mark").count()) === 0 && !(await ai().isDisabled()),
    );

    // 敏感
    await show("resume");
    check(
        "敏感：笔记和状态栏都有标记",
        (await sheet.locator(".dem-mark").first().textContent())?.includes("敏感") &&
            (await status.locator(".dem-mark").textContent())?.includes("敏感"),
    );
    await ai().click();
    await page.waitForTimeout(200);
    const dialog = page.locator(".dem-dialog");
    check("敏感：点 AI 先问要不要开授权对话", (await dialog.textContent())?.includes("不能上网"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await show("diary");
    await page.waitForTimeout(400);
    check("关掉对话再换页签，不留提示框", (await page.locator(".dem-tooltip").count()) === 0);
    await show("resume");
    await ai().click();
    await page.waitForTimeout(200);
    await dialog.getByRole("button", { name: "开授权对话" }).click();
    await page.waitForTimeout(250);
    check("敏感：确认后才开", await page.getByText("授权对话已开，不上网").isVisible());
    let menu = await menuFor();
    await menu.getByRole("menuitem", { name: /互联网搜索/ }).click();
    await page.waitForTimeout(200);
    check(
        "敏感：互联网搜索先确认",
        (await page.locator(".dem-dialog").textContent())?.includes("搜索引擎"),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // 私密
    await show("diary");
    check("私密：AI 按钮变灰", await ai().isDisabled());
    menu = await menuFor();
    const askItem = menu.getByRole("menuitem", { name: /问 AI/ });
    check(
        "私密：右键里 AI 和搜索变灰并写明原因",
        (await askItem.getAttribute("aria-disabled")) === "true" &&
            (await askItem.textContent())?.includes("私密内容，AI 看不到") &&
            (await menu
                .getByRole("menuitem", { name: /互联网搜索/ })
                .getAttribute("aria-disabled")) === "true",
        await askItem.textContent(),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await page.keyboard.press("ControlOrMeta+K");
    await page.waitForTimeout(200);
    await page.keyboard.type("?这周");
    await page.waitForTimeout(150);
    check(
        "私密：启动器里问 AI 变灰",
        (await page.locator(".dem-launcher-item").first().getAttribute("aria-disabled")) === "true",
    );
    await input(page, "");
    await page.keyboard.type("证件");
    await page.waitForTimeout(150);
    check(
        "机密：启动器搜不到标题",
        !(await page.locator(".dem-launcher-box").textContent())?.includes("证件和保单号"),
    );
    await input(page, "");
    await page.keyboard.type(">隐私层级");
    await page.waitForTimeout(150);
    check("改层级的命令在启动器里", (await page.locator(".dem-launcher-item").count()) === 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // 机密: the gate.
    await show("papers");
    const gate = page.locator(".dem-secret-gate:visible");
    const secretText = "护照和保单的号码";
    const body = () => page.locator(".dv-groupview").first().page().content();
    check(
        "机密：验证前只有锁，正文不在页面里，页签只写机密内容",
        (await gate.isVisible()) &&
            !(await body()).includes(secretText) &&
            (await page.evaluate(
                () => window.__ws.tabs().find((t) => t.contentId === "papers").title,
            )) === "机密内容",
    );
    check(
        "机密：目录里有标题和锁",
        (
            await page
                .locator(".dem-tree-row", { hasText: "证件和保单号" })
                .locator(".dem-mark")
                .textContent()
        )?.includes("机密"),
    );
    await page.evaluate(() => (window.__systemVerify = "failed"));
    await gate.getByRole("button", { name: "验证" }).click();
    await page.waitForTimeout(600);
    check("机密：验证没通过", (await gate.textContent())?.includes("没有通过"));
    await page.evaluate(() => (window.__systemVerify = "unavailable"));
    await gate.getByRole("button", { name: "验证" }).click();
    await page.waitForTimeout(600);
    check("机密：系统验证用不了时退回主密码", (await gate.textContent())?.includes("输入主密码"));
    await gate.getByRole("textbox", { name: "主密码" }).fill("wrong");
    await gate.getByRole("button", { name: "打开" }).click();
    await page.waitForTimeout(500);
    check("机密：主密码错了", (await gate.textContent())?.includes("主密码不对"));
    await gate.getByRole("textbox", { name: "主密码" }).fill("correct horse");
    await gate.getByRole("button", { name: "打开" }).click();
    await page.waitForTimeout(600);
    check(
        "机密：通过后看到内容，页签换回标题",
        (await sheet.textContent())?.includes(secretText) &&
            (await page.evaluate(
                () => window.__ws.tabs().find((t) => t.contentId === "papers").title,
            )) === "证件和保单号",
    );
    await show("lesson");
    await show("papers");
    check("机密：页签开着不用再验", (await gate.count()) === 0);
    await page.evaluate(() => {
        const t = window.__ws.tabs().find((x) => x.contentId === "papers");
        window.__ws.close(t.id);
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => (window.__systemVerify = "ok"));
    await page.locator(".dem-tree-row", { hasText: "证件和保单号" }).click();
    await page.waitForTimeout(400);
    check("机密：关掉再开要重新验证", await gate.isVisible());
    await gate.getByRole("button", { name: "验证" }).click();
    await page.waitForTimeout(600);

    // Links in a note: a 机密 link shows no title.
    await show("lesson");
    const links = await sheet.locator(".dem-wikilink").allTextContents();
    check(
        "笔记里的链接：机密不显示标题",
        links.includes("机密内容") && !links.includes("证件和保单号") && links.includes("10月17日"),
        links,
    );

    // The AI answer: only what AI may read has a title.
    await show("ai");
    const answer = page.locator("[data-testid=ai-answer]");
    const text = await answer.textContent();
    check(
        "AI 回答：看不到的内容只显示受保护的内容",
        text?.includes("第 12 课") &&
            !["投递资料", "10月17日", "证件和保单号", "gone"].some((x) => text.includes(x)) &&
            (await answer.locator(".dem-protected-link").count()) === 4,
        text,
    );

    // Changing a level: up at once, down after a confirmation that says who can read it.
    await show("lesson");
    const picker = sheet.getByRole("button", { name: "隐私层级" });
    await picker.click();
    await page.getByRole("menuitem", { name: "私密" }).click();
    await page.waitForTimeout(250);
    check("调高直接生效", await ai().isDisabled());
    check("打开的内容里有锁", (await page.locator(".dem-open-row .dem-ctab-lock").count()) >= 3);
    await picker.click();
    await page.getByRole("menuitem", { name: "普通" }).click();
    await page.waitForTimeout(200);
    const lower = page.locator(".dem-dialog");
    check("调低要确认并说明谁能读", (await lower.textContent())?.includes("AI 就能读"));
    await lower.getByRole("button", { name: "改成普通" }).click();
    await page.waitForTimeout(250);
    check("确认后调低", !(await ai().isDisabled()));
    await picker.click();
    await page.getByRole("menuitem", { name: "机密" }).click();
    await page.waitForTimeout(300);
    check("调成机密后立刻要验证", await gate.isVisible());
    check("页面没有报错", errors.length === 0, errors);
    await page.close();
    await browser.close();
}

async function input(page, value) {
    await page.locator(".dem-launcher-input").fill(value);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    // Clear any chip too: Backspace at the start removes it.
    await page.keyboard.press("Backspace");
}

await server.close();
console.log(failed ? `${failed} checks failed` : "all privacy checks passed");
process.exit(failed ? 1 : 0);
