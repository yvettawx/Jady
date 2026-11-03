// Drives the workspace lab (#/workspace) in Chromium and WebKit and checks the wrapper's rules:
// tab reorder and stacking, the 3 × 3 limit, preview replacement, save and restore, the
// vertical arrangement and the 打开的内容 list. Starts its own Vite server.
// Run: pnpm run probe:workspace   (add "html5" to test HTML5 drag-and-drop instead of pointer)
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const dnd = process.argv.includes("html5") ? "html5" : "pointer";
const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const url = `${server.resolvedUrls.local[0]}#/workspace${dnd === "html5" ? "?dnd=html5" : ""}`;

const results = [];
const check = (engine, name, ok, detail) => {
    results.push({ engine, name, ok });
    console.log(
        `${engine.padEnd(9)} ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`,
    );
};

async function drag(page, from, to) {
    const a = await from.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 4, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 18 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(250);
}

const shape = (page) => page.evaluate(() => window.__ws.shape());
const groupTabs = (page, contentId) =>
    page.evaluate((c) => {
        const ws = window.__ws;
        const t = ws.tabs().find((x) => x.contentId === c);
        return t
            ? ws
                  .tabs()
                  .filter((x) => x.groupId === t.groupId)
                  .map((x) => x.contentId)
            : null;
    }, contentId);
const tabEl = (page, title) => page.locator(".dv-tab", { hasText: title }).first();

for (const engine of [chromium, webkit]) {
    const name = engine.name();
    const browser = await engine.launch();
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1280, height: 820 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 0);
    await page.waitForTimeout(300);

    let s = await shape(page);
    check(name, "初始布局 3 列，左右各 2 格", s.columns === 3 && s.rows.join() === "2,1,2", s);

    // Reorder within the centre group: drop 第三章草稿 onto the left half of 首页.
    const home = await tabEl(page, "首页").boundingBox();
    await drag(page, tabEl(page, "第三章草稿"), { x: home.x + 6, y: home.y + home.height / 2 });
    let order = await groupTabs(page, "home");
    check(name, "同组页签拖动换位", order?.indexOf("draft") < order?.indexOf("l12"), order);

    // Stack: drop 反向链接 onto the centre tab strip.
    const strip = await page
        .locator(".dv-groupview", { has: tabEl(page, "首页") })
        .locator(".dv-void-container, .dv-tabs-container")
        .first()
        .boundingBox();
    await drag(page, tabEl(page, "反向链接"), {
        x: strip.x + strip.width - 20,
        y: strip.y + strip.height / 2,
    });
    order = await groupTabs(page, "links");
    s = await shape(page);
    check(name, "拖到另一组的页签栏叠放", order?.includes("home") && s.rows.join() === "2,1,1", {
        order,
        s,
    });

    // A 4th column at the left edge is refused.
    const ws = await page.locator(".dem-workspace").boundingBox();
    await drag(page, tabEl(page, "大纲"), { x: ws.x + 4, y: ws.y + ws.height / 2 });
    s = await shape(page);
    check(name, "拖到最左边缘（第 4 列）被拦下", s.columns === 3, s);

    // Dropping at the bottom of the centre cell splits that cell downward; no row ever spans
    // all columns (the root stays a row of columns).
    await drag(page, tabEl(page, "反向链接"), { x: ws.x + ws.width / 2, y: ws.y + ws.height - 2 });
    s = await shape(page);
    check(name, "把一格上下分开可以，没有横跨各列的一行", s.columns === 3 && s.rows[1] === 2, s);

    // Splitting the centre cell sideways is refused.
    const centre = await page.locator(".dv-groupview", { has: tabEl(page, "首页") }).boundingBox();
    await drag(page, tabEl(page, "大纲"), {
        x: centre.x + centre.width - 30,
        y: centre.y + centre.height / 2,
    });
    s = await shape(page);
    check(name, "把一格左右分开被拦下", s.columns === 3, s);

    // A 4th cell in a column is refused (left column already has 2; make 3, then try a 4th).
    const left = page.locator(".dv-groupview", { has: tabEl(page, "目录") });
    let lb = await left.boundingBox();
    await drag(page, tabEl(page, "第 12 课"), { x: lb.x + lb.width / 2, y: lb.y + lb.height - 15 });
    lb = await left.boundingBox();
    await drag(page, tabEl(page, "首页"), { x: lb.x + lb.width / 2, y: lb.y + lb.height - 15 });
    s = await shape(page);
    check(name, "一列第 4 格被拦下", s.rows[0] === 3, s);

    // Preview: a new preview replaces the old one in the same group. Focus that group first;
    // earlier drags leave a different cell active.
    await page.evaluate(() =>
        window.__ws.activate(window.__ws.tabs().find((t) => t.kind === "preview").id),
    );
    const before = await page.evaluate(() =>
        window.__ws
            .tabs()
            .filter((t) => t.kind === "preview")
            .map((t) => t.contentId),
    );
    await page.evaluate(() =>
        window.__ws.open(
            { contentId: "cv", title: "简历 2026 秋", component: "note" },
            { kind: "preview" },
        ),
    );
    const previews = await page.evaluate(() =>
        window.__ws
            .tabs()
            .filter((t) => t.kind === "preview")
            .map((t) => t.contentId),
    );
    check(name, "新预览替换旧预览", before.length === 1 && previews.join() === "cv", {
        before,
        previews,
    });

    // Typing in a preview makes it temporary.
    await page
        .locator(".dv-groupview", { has: tabEl(page, "简历 2026 秋") })
        .locator("textarea:visible")
        .fill("x");
    const kind = await page.evaluate(
        () => window.__ws.tabs().find((t) => t.contentId === "cv")?.kind,
    );
    check(name, "预览里开始编辑变成临时页签", kind === "temp", kind);

    // The API adds columns up to 3; then 分屏 splits below while the column has room, and only
    // stacks as a tab when the 3 × 3 grid is full there too.
    const split = () =>
        page.evaluate(() =>
            window.__ws.open(
                { contentId: "l11", title: "第 11 课", component: "note" },
                { split: "right" },
            ),
        );
    for (let i = 0; i < 3 && (await shape(page)).columns < 3; i++) await split();
    const at3 = await shape(page);
    await split();
    const after = await shape(page);
    check(
        "接口分屏：满三列后往下分出一格",
        at3.columns === 3 &&
            after.columns === 3 &&
            after.rows.reduce((a, b) => a + b) === at3.rows.reduce((a, b) => a + b) + 1 &&
            after.rows.every((r) => r <= 3),
        { at3, after },
    );

    // Save and restore.
    const saved = await page.evaluate(() => JSON.stringify(window.__ws.save()));
    await page.evaluate(() =>
        window.__ws.open({ contentId: "x", title: "临时", component: "note" }),
    );
    const restored = await page.evaluate(
        (j) => window.__ws.load(JSON.parse(j)) && JSON.stringify(window.__ws.save()),
        saved,
    );
    const strip0 = (j) =>
        JSON.parse(j)
            .columns.map((c) => c.cells.map((x) => x.tabs.join("|")).join("/"))
            .join(" ; ");
    check(name, "保存再恢复布局", strip0(restored) === strip0(saved), {
        saved: strip0(saved),
        restored: strip0(restored),
    });
    const bad = await page.evaluate(() =>
        window.__ws.load({ version: 1, columns: [], floating: [], tabs: {} }),
    );
    check(name, "坏掉的布局不加载", bad === false, bad);

    // Vertical arrangement shows only the active tab of each cell.
    await page.getByText("竖排", { exact: true }).click();
    await page.waitForTimeout(150);
    const visible = await page.evaluate(() =>
        [...document.querySelectorAll(".dv-groupview")].map(
            (g) =>
                [...g.querySelectorAll(".dv-tab")].filter(
                    (t) => getComputedStyle(t).display !== "none",
                ).length,
        ),
    );
    check(
        name,
        "竖排时每格只显示当前页签",
        visible.every((n) => n === 1),
        visible,
    );
    await page.getByText("横排", { exact: true }).click();

    // 打开的内容: pinned first, and dragging within the temporary section reorders.
    const rows = () =>
        page.locator(".dem-open-row").evaluateAll((els) => els.map((e) => e.textContent.trim()));
    const list1 = await rows();
    const firstTemp = list1.findIndex((t) => !t.startsWith("◆"));
    check(
        name,
        "打开的内容：固定的在上",
        list1.slice(0, firstTemp).every((t) => t.startsWith("◆")) &&
            list1.slice(firstTemp).every((t) => !t.startsWith("◆")),
        list1,
    );
    const tempRows = page.locator(".dem-open-row:not([data-kind=pin])");
    const lastTemp = tempRows.last();
    const firstBox = await tempRows.first().boundingBox();
    await lastTemp.hover();
    await drag(page, lastTemp.locator(".dem-open-drag"), { x: firstBox.x + 40, y: firstBox.y + 3 });
    const list2 = await rows();
    check(name, "打开的内容：拖动换位", list2[firstTemp] === list1[list1.length - 1], {
        list1,
        list2,
    });

    check(name, "页面没有报错", errors.length === 0, errors);
    await browser.close();
}

await server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (${dnd} drag)`);
process.exit(failed.length ? 1 : 0);
