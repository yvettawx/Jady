// Opens the P0.5-07 review pages, every step in light and dark, and fails on page errors in
// either engine. Also checks the shell's behaviour (spaces, folding columns, shortcuts, the AI
// button) in both.
// Run: pnpm run probe:screens [group]   (group: unlock, shell; default all)
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const GROUPS = {
    shell: [],
    unlock: [
        "welcome",
        "location",
        "password",
        "recovery",
        "confirm",
        "creating",
        "unlocking",
        "unlock",
        "recover",
        "missing",
        "broken",
    ],
};
const only = process.argv[2];
const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
let failures = 0;

for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});
    for (const [group, steps] of Object.entries(GROUPS)) {
        if (only && only !== group) continue;
        for (const step of steps) {
            for (const mode of ["light", "dark"]) {
                const page = await browser.newPage({
                    locale: "zh-CN",
                    viewport: { width: 1100, height: 760 },
                    deviceScaleFactor: 1,
                    colorScheme: mode,
                });
                const errors = [];
                page.on("pageerror", (e) => errors.push(String(e)));
                await page.goto(`${base}#/screens/${group}?step=${step}`);
                await page.waitForSelector(".gate-card, main", { timeout: 8000 });
                await page.waitForTimeout(500);
                if (errors.length) {
                    failures++;
                    console.log(`${engine.name()} ${group}/${step}/${mode}: ${errors.join("; ")}`);
                }
                await page.close();
            }
        }
    }
    if (!only || only === "shell") failures += await shell(browser);
    await browser.close();
}
await server.close();

async function shell(browser) {
    const name = browser.browserType().name();
    let failed = 0;
    const check = (label, ok, detail) => {
        if (!ok) failed++;
        console.log(
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 外壳：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
        );
    };
    for (const mode of ["light", "dark"]) {
        const page = await browser.newPage({
            locale: "zh-CN",
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            colorScheme: mode,
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(`${base}#/screens/shell`);
        await page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 0);
        await page.waitForTimeout(600);
        if (mode === "dark") {
            check("深色页面没有报错", errors.length === 0, errors);
            await page.close();
            continue;
        }
        const visible = () =>
            page.evaluate(() => [0, 1, 2].map((c) => window.__ws.isColumnVisible(c)));
        const shape = () => page.evaluate(() => window.__ws.shape());
        const accent = () =>
            page.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue("--dem-accent").trim(),
            );

        check("宽窗口三列都在", (await visible()).every(Boolean), await visible());
        const crumb = () => page.locator(".dem-crumb").textContent();
        check("标题栏显示当前内容", (await crumb()).includes("第 12 课"), await crumb());

        // Spaces: ⌘2 brings the 法语 layout and colours, ⌘1 restores the main layout as left.
        const a1 = await accent();
        await page.keyboard.press("ControlOrMeta+2");
        await page.waitForTimeout(500);
        const s2 = await shape();
        check("⌘2 切到法语空间：两列、换颜色", s2.columns === 2 && (await accent()) !== a1, {
            s2,
            a1,
        });
        await page.keyboard.press("ControlOrMeta+1");
        await page.waitForTimeout(500);
        const s1 = await shape();
        check("⌘1 回主空间，布局原样", s1.columns === 3 && s1.rows.join() === "2,1,2", s1);
        check("切回后标题栏显示原来的内容", (await crumb()).includes("第 12 课"), await crumb());
        const openRows = await page.locator(".dem-open-row").count();
        check("切回后打开的内容列表完整", openRows >= 2, openRows);

        const sizes = () =>
            page.evaluate(() =>
                window.__ws.save().columns.flatMap((c) => [c.size, ...c.cells.map((x) => x.size)]),
            );
        const wide = await sizes();
        // Narrow windows fold the right column first, then the left; the edge unfolds.
        await page.setViewportSize({ width: 1000, height: 760 });
        await page.waitForTimeout(400);
        check("变窄先收右列", (await visible()).join() === "true,true,false", await visible());
        await page.setViewportSize({ width: 680, height: 760 });
        await page.waitForTimeout(400);
        check("再窄收左列", (await visible()).join() === "false,true,false", await visible());
        await page.keyboard.press("ControlOrMeta+Backslash");
        await page.waitForTimeout(300);
        check("⌘\\ 展开左列", (await visible())[0] === true, await visible());
        await page.locator('.dem-fold-edge[data-side="right"]').click();
        await page.waitForTimeout(300);
        check("点右边窄边展开右列", (await visible())[2] === true, await visible());
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(400);
        check("变回宽窗口，三列都在", (await visible()).every(Boolean), await visible());
        const back = await sizes();
        check(
            "展开后列宽和格高回到原来的比例",
            back.length === wide.length && back.every((x, i) => Math.abs(x - wide[i]) < 0.03),
            { wide, back },
        );

        // Sidebar views: ⌘⇧F switches the navigation panel to search.
        await page.keyboard.press("ControlOrMeta+Shift+F");
        await page.waitForTimeout(300);
        const navTitle = await page.evaluate(
            () => window.__ws.tabs().find((t) => t.contentId === "nav")?.title,
        );
        check("⌘⇧F 左栏切到搜索", navTitle === "搜索", navTitle);
        await page.keyboard.press("ControlOrMeta+Shift+E");

        // Notifications open with ⌘⇧N.
        await page.keyboard.press("ControlOrMeta+Shift+N");
        await page.waitForTimeout(300);
        check("⌘⇧N 打开通知", await page.locator(".dem-notify").isVisible());
        await page.keyboard.press("Escape");

        // AI status opens the list of places.
        await page.getByText(/AI 正在运行/).click();
        await page.waitForTimeout(300);
        check(
            "状态栏 AI 点开看到运行的地方",
            (await page.locator(".dem-status-dialog li").count()) === 2,
        );
        await page.keyboard.press("Escape");

        // The AI button snaps to the nearest corner after a drag, and remembers it.
        const ai = page.locator(".dem-ai-button");
        const b = await ai.boundingBox();
        await page.mouse.move(b.x + 24, b.y + 24);
        await page.mouse.down();
        await page.mouse.move(400, 300, { steps: 12 });
        await page.mouse.move(300, 200, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(700);
        const after = await ai.boundingBox();
        const corner = await page.evaluate(() => localStorage.getItem("dem.aiButton.corner"));
        check("AI 按钮拖动后吸附到左上角", corner === "tl" && after.x < 120 && after.y < 120, {
            corner,
            after,
        });
        await page.evaluate(() => localStorage.removeItem("dem.aiButton.corner"));
        check("页面没有报错", errors.length === 0, errors);
        await page.close();
    }
    return failed;
}
console.log(failures ? `${failures} pages had errors` : "all pages rendered without errors");
process.exit(failures ? 1 : 0);
