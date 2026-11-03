// Drives the table and board review page (#/screens/board, P0.5-07-6) in Chromium and WebKit:
// keyboard dragging between columns, the detail sliding in and Esc bringing focus back, links
// in the detail, search and filters, sorting, batch changes and delete with confirmation, and
// a 1000-row table that only draws what is visible. Mouse dragging uses the browser's native
// drag and drop, which Playwright can only drive in Chromium. Starts its own Vite server.
// Run: pnpm run probe:board
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
let failed = 0;

const counts = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll(".dem-board-col")]
            .map((c) => c.querySelectorAll(".dem-board-card").length)
            .join(","),
    );

for (const engine of [chromium, webkit]) {
    const name = engine.name();
    const check = (label, ok, detail) => {
        if (!ok) failed++;
        console.log(
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 表格看板：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
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
        await page.goto(`${base}#/screens/board${query}`);
        await page.waitForSelector(".dem-records");
        await page.waitForTimeout(400);
        return { page, errors };
    };

    // Dark first, just to look at.
    {
        const { page, errors } = await open("dark");
        check("深色页面没有报错", errors.length === 0, errors);
        await page.close();
    }

    const { page, errors } = await open("light");
    check("看板按状态分五栏", (await counts(page)) === "4,3,2,1,1", await counts(page));

    // Keyboard: focus the card, move to its handle, Enter, Tab to the next column, Enter.
    await page.locator(".dem-board-card", { hasText: "后端开发实习" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    check("键盘把卡片拖到已投", (await counts(page)) === "3,4,2,1,1", await counts(page));

    if (engine === chromium) {
        const card = page.locator(".dem-board-card", { hasText: "数据分析实习" });
        const target = page.locator(".dem-board-list").nth(2);
        await card.dragTo(target);
        await page.waitForTimeout(500);
        check("鼠标把卡片拖到面试", (await counts(page)) === "2,4,3,1,1", await counts(page));
    }

    // The detail slides in; Esc puts it away and focus returns to the card.
    const detail = page.locator(".dem-detail");
    await page.locator(".dem-board-card", { hasText: "研究助理" }).click();
    await page.waitForTimeout(500);
    check(
        "点卡片详情从右边滑出，焦点进详情",
        (await detail.getAttribute("data-open")) !== null &&
            (await page.evaluate(() => document.activeElement?.className)) === "dem-detail-title",
    );

    // A link in the notes peeks; the first Esc closes the peek, the second the detail.
    await detail.locator(".dem-wikilink").first().click();
    await page.waitForTimeout(300);
    check("详情里点链接出小预览", await page.locator(".dem-peek").isVisible());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check(
        "第一次 Esc 只关预览",
        !(await page.locator(".dem-peek").isVisible()) &&
            (await detail.getAttribute("data-open")) !== null,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(450);
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    check(
        "第二次 Esc 收回详情，焦点回到卡片",
        (await detail.getAttribute("data-open")) === null && focused.includes("研究助理"),
        focused,
    );

    // Changing the status in the detail moves the card.
    await page.locator(".dem-board-card", { hasText: "游戏客户端实习" }).click();
    await page.waitForTimeout(300);
    await detail.getByRole("button", { name: /状态/ }).click();
    await page.getByRole("option", { name: "录用" }).click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const recorded = await page
        .locator(".dem-board-col")
        .nth(3)
        .locator(".dem-board-card", { hasText: "游戏客户端实习" })
        .count();
    check("在详情里改状态，卡片换到录用栏", recorded === 1, await counts(page));

    // Search and the status filter apply to both views.
    await page.getByPlaceholder("搜索").fill("Rust");
    await page.waitForTimeout(200);
    check("搜索 Rust 只剩一张", (await page.locator(".dem-board-card").count()) === 1);
    await page.getByPlaceholder("搜索").fill("");
    await page.waitForTimeout(200);
    const interview = await page
        .locator(".dem-board-col")
        .nth(2)
        .locator(".dem-board-card")
        .count();
    await page.getByRole("button", { name: "面试" }).click();
    await page.waitForTimeout(200);
    const onlyInterview = await page.locator(".dem-board-card").count();
    await page.getByRole("button", { name: "面试" }).click();
    check("按状态筛选", onlyInterview === interview, { onlyInterview, interview });

    // Table: sort by date, select two rows, change them together, delete with confirmation.
    await page.getByRole("radio", { name: "表格" }).click();
    await page.waitForTimeout(300);
    await page.getByRole("columnheader", { name: "截止" }).click();
    await page.waitForTimeout(200);
    const firstRow = await page.locator(".dem-table-row").first().textContent();
    check("按截止日期排序，过期的在最前", firstRow?.includes("全栈开发"), firstRow);
    const boxes = page.locator(".dem-table-row .dem-check");
    await boxes.nth(1).click();
    await boxes.nth(2).click();
    const batch = page.locator(".dem-records-batch");
    check("选两行出现批量操作", (await batch.textContent())?.includes("已选 2 条"));
    await batch.getByRole("button", { name: /改状态/ }).click();
    await page.getByRole("menuitem", { name: "结束" }).click();
    await page.waitForTimeout(200);
    const closed = await page.locator(".dem-table-row", { hasText: "结束" }).count();
    check("批量改成结束", closed === 3, closed);
    const before = await page.locator(".dem-table-row").count();
    await batch.getByRole("button", { name: "删除" }).click();
    await page.waitForTimeout(200);
    const dialog = page.getByRole("alertdialog");
    check("删除前要确认", await dialog.isVisible());
    await dialog.getByRole("button", { name: "删除" }).click();
    await page.waitForTimeout(300);
    check("确认后删掉两行", (await page.locator(".dem-table-row").count()) === before - 2);

    // Keyboard in the table: Enter on a row opens its detail.
    await page.locator(".dem-table-row").first().focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    check("表格里回车打开详情", (await detail.getAttribute("data-open")) !== null);
    await page.keyboard.press("Escape");
    check("页面没有报错", errors.length === 0, errors);
    await page.close();

    // 1000 rows: only the visible ones are drawn, and the end is reachable.
    {
        const { page: big, errors: bigErrors } = await open("light", "?layout=table&rows=1000");
        const drawn = await big.locator(".dem-table-row").count();
        const scroller = big.locator(".dem-table");
        const frames = await scroller.evaluate(
            (el) =>
                new Promise((resolve) => {
                    const gaps = [];
                    let last = performance.now();
                    const step = (now) => {
                        gaps.push(now - last);
                        last = now;
                        el.scrollTop += 400;
                        if (el.scrollTop + el.clientHeight < el.scrollHeight - 2)
                            requestAnimationFrame(step);
                        else resolve(gaps);
                    };
                    requestAnimationFrame(step);
                }),
        );
        await big.waitForTimeout(300);
        // Virtual rows are reused, so look for the last one by name, not by place in the DOM.
        const reached = await big.getByRole("rowheader", { name: "职位 1000" }).isVisible();
        const sorted = [...frames].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
        check("1000 行只画看得见的，能滚到最后一行", drawn < 80 && reached, { drawn, reached });
        // Headless browsers do not draw to a screen, so this is a rough number, not a check.
        console.log(
            `${name.padEnd(9)} INFO 1000 行滚动：p95 ${Math.round(p95)} ms，${frames.length} 帧`,
        );
        check("1000 行页面没有报错", bigErrors.length === 0, bigErrors);
        await big.close();
    }
    await browser.close();
}

await server.close();
console.log(failed ? `${failed} checks failed` : "all board checks passed");
process.exit(failed ? 1 : 0);
