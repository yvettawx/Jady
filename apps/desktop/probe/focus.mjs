// Focus and Esc on the review pages (docs/05-design.md §3.7), in Chromium and WebKit. When what
// you pressed goes away, the keyboard must not fall off the page: focus stays near where you were.
// Esc closes the top layer only. Starts its own Vite server.
// Run: pnpm run probe:focus
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
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 焦点：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
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
    await page.goto(`${base}#/screens/ai`);
    await page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 0);
    await page.waitForSelector(".dem-chat-window");
    await page.waitForTimeout(500);
    const show = async (id) => {
        await page.evaluate((c) => {
            window.__ws.activate(window.__ws.tabs().find((x) => x.contentId === c).id);
        }, id);
        await page.waitForTimeout(250);
    };
    /** Where the keyboard is: the closest thing with a name we check against. */
    const where = () =>
        page.evaluate(() => {
            const e = document.activeElement;
            if (!e || e === document.body) return "BODY";
            return `${e.tagName}.${String(e.className).slice(0, 40)}|${e.closest("[data-testid],[data-proposal],.dem-harvest,.dem-chat-window,.dem-sheet,.dem-review,.dem-talk")?.className?.toString().slice(0, 30) ?? ""}`;
        });
    const within = async (selector) =>
        page.evaluate((s) => !!document.activeElement?.closest(s), selector);
    const offPage = async () => (await where()) === "BODY";

    await show("lesson");
    const win = page.locator(".dem-chat-window").first();
    const prop = win.getByTestId("proposal");
    const gen = win.getByTestId("chat-generated");

    // What you pressed goes away.
    await prop.getByRole("button", { name: "只这一次" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    check("确认提议后焦点还在这张卡片", await within("[data-proposal]"), await where());
    await prop.getByRole("button", { name: "撤销" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    check("撤销后焦点还在这张卡片", await within("[data-proposal]"), await where());
    await gen.getByRole("button", { name: "插入原文下方" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    check("插入后焦点还在这张卡片", await within("[data-testid=chat-generated]"), await where());
    await gen.getByRole("button", { name: "撤销" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    check("撤销插入后焦点还在", await within("[data-testid=chat-generated]"), await where());

    // Esc: the top layer only.
    await show("resume");
    const sheet = page.locator(".dv-groupview .dem-sheet:visible");
    const ai = sheet.getByRole("button", { name: "总结" });
    await ai.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    check(
        "对话框打开，焦点在取消上",
        (await where()).includes("BUTTON") &&
            (await page.evaluate(() => document.activeElement?.textContent)) === "取消",
        await where(),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check(
        "Esc 只关对话框，窗口还在",
        (await page.locator(".dem-chat-window").count()) === 1 &&
            (await page.locator(".dem-dialog").count()) === 0,
    );
    check(
        "关对话框后焦点回到按钮",
        (await page.evaluate(() => document.activeElement?.textContent))?.includes("总结"),
        await where(),
    );

    // Menu, picked: back to the picker.
    const picker = sheet.getByRole("button", { name: "隐私层级" });
    await picker.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check(
        "Esc 关菜单，焦点回到按钮",
        await picker.evaluate((el) => el === document.activeElement),
        await where(),
    );

    // The launcher: Esc goes back to where you were.
    await picker.focus();
    await page.keyboard.press("ControlOrMeta+K");
    await page.waitForTimeout(250);
    check("启动器打开，焦点在输入框", await within(".dem-launcher-box"), await where());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check(
        "Esc 关启动器，焦点回到原处",
        await picker.evaluate((el) => el === document.activeElement),
        await where(),
    );

    // The dot's card: the dot goes with the decision.
    await show("lesson");
    const dot = page.locator('[data-proposal-dot="p-second"]');
    await dot.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const pop = page.locator(".dem-prop-popover");
    await pop.getByRole("button", { name: "只这一次" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    check("在小点上确认后键盘没掉出页面", !(await offPage()), await where());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Closing a chat window: back to the note, not off the page.
    await win.locator("textarea").focus();
    await win.getByRole("button", { name: "关闭" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    check("关掉对话窗口后键盘没掉出页面", !(await offPage()), await where());

    // Whole pages that change under you.
    await show("harvest");
    const harvest = page.locator(".dem-harvest:visible");
    await harvest.getByRole("button", { name: "存入" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    check("存入后焦点还在本次收获", await within(".dem-harvest"), await where());
    await harvest.getByRole("button", { name: "撤销" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    check("撤销存入后焦点还在本次收获", await within(".dem-harvest"), await where());
    await show("talk");
    const talk = page.locator(".dem-talk");
    await talk.locator("textarea").fill("Bonjour");
    await talk.locator("textarea").press("Enter");
    await page.waitForTimeout(650);
    await talk.getByRole("button", { name: "结束" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    check("结束对话后焦点到本次收获", await within(".dem-harvest"), await where());

    // Review keeps the keyboard between cards.
    await show("review");
    check("切到复习页，键盘就在复习上", await within(".dem-review"), await where());
    check("页面没有报错", errors.length === 0, errors);

    // Esc cancels a tab drag: everything stays where it was.
    await page.goto(`${base}#/workspace`);
    await page.reload();
    await page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 2);
    await page.waitForTimeout(500);
    const layout = () =>
        page.evaluate(
            () =>
                `${JSON.stringify(window.__ws.shape())}|${window.__ws
                    .tabs()
                    .map((t) => `${t.groupId}:${t.title}`)
                    .join()}`,
        );
    const before = await layout();
    const tabBox = await page.locator(".dem-ws-tab").first().boundingBox();
    await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(tabBox.x + 200, tabBox.y + 300, { steps: 10 });
    await page.mouse.move(900, 500, { steps: 10 });
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(350);
    check("Esc 取消拖页签，布局不变", (await layout()) === before, {
        before,
        after: await layout(),
    });

    // The undo toast stays while the pointer is on it, and leaves after 8 s otherwise.
    await page.goto(`${base}#/sample`);
    await page.reload();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "撤销提示" }).first().click();
    await page.waitForTimeout(300);
    const toast = page.locator(".dem-toast");
    await toast.hover();
    await page.waitForTimeout(9000);
    check("指针停在撤销提示上时不消失", (await toast.count()) === 1);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(9000);
    check("离开后 8 秒消失", (await toast.count()) === 0);
    await browser.close();
}
await server.close();
console.log(failed ? `${failed} checks failed` : "all focus checks passed");
process.exit(failed ? 1 : 0);
