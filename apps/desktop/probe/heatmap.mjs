// Drives the heat map (#/screens/heatmap and the home page, P0.5-08) in Chromium and WebKit: it
// draws, a day shows its numbers on hover and its card on click, 机密 titles stay off the card,
// the legend filters, the arrow keys and Enter work; on the home page the small one opens the big
// one on that day. Also prints how far apart frames are while the pointer moves over it, with the
// star map running behind. Starts its own Vite server.
// Run: pnpm run probe:heatmap
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
let failed = 0;

/** How many sampled canvas pixels are not empty, to tell whether anything was drawn. */
const painted = (page) =>
    page.locator(".dem-heat-canvas:visible").evaluate((c) => {
        const t = document.createElement("canvas");
        t.width = 120;
        t.height = 60;
        const g = t.getContext("2d");
        g.drawImage(c, 0, 0, 120, 60);
        let n = 0;
        const px = g.getImageData(0, 0, 120, 60).data;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
        return n;
    });

/** Frame gaps in ms over 3 seconds, the pointer crossing the map each frame if `move`. */
const frameGaps = (page, move = true) =>
    page.evaluate(
        (move) =>
            new Promise((done) => {
                const c = [...document.querySelectorAll(".dem-heat-canvas")].find(
                    (x) => x.offsetParent,
                );
                const r = c.getBoundingClientRect();
                const gaps = [];
                let last = performance.now();
                let n = 0;
                const step = (now) => {
                    gaps.push(now - last);
                    last = now;
                    const x = r.left + r.width * (0.1 + 0.8 * ((n % 90) / 90));
                    const y = r.top + r.height * (0.2 + 0.6 * ((n % 37) / 37));
                    if (move)
                        c.dispatchEvent(
                            new PointerEvent("pointermove", {
                                clientX: x,
                                clientY: y,
                                bubbles: true,
                            }),
                        );
                    if (++n < 180) requestAnimationFrame(step);
                    else {
                        gaps.sort((p, q) => p - q);
                        done({
                            p50: gaps[90].toFixed(1),
                            p95: gaps[171].toFixed(1),
                            worst: gaps[179].toFixed(1),
                        });
                    }
                };
                requestAnimationFrame(step);
            }),
        move,
    );

for (const engine of [chromium, webkit]) {
    const name = engine.name();
    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});
    const check = (label, ok, detail) => {
        if (!ok) failed++;
        console.log(
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 热度图：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
        );
    };
    const open = async (route) => {
        const page = await browser.newPage({
            locale: "zh-CN",
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 2,
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(`${base}${route}`);
        await page.waitForSelector(".dem-heat-canvas");
        await page.waitForTimeout(1500);
        return { page, errors };
    };

    // The big one.
    {
        const { page, errors } = await open("#/screens/heatmap?size=large");
        check("画出来了", (await painted(page)) > 200, await painted(page));
        const days = 371;
        let index = days - 3;
        for (; index > days - 40; index--) {
            const at = await page.evaluate((i) => window.__heatLocate?.(i), index);
            await page.mouse.move(at.x, at.y);
            await page.waitForTimeout(120);
            if (await page.locator(".dem-heat-tip").count()) break;
        }
        const tip = page.locator(".dem-heat-tip");
        check(
            "悬停显示这天的数字",
            (await tip.count()) === 1 && /\d/.test(await tip.textContent()),
        );
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(350);
        const card = page.locator(".dem-heat-card");
        check("点一下出当天的卡片", (await card.count()) === 1);
        const text = (await card.textContent().catch(() => "")) ?? "";
        check("卡片列出当天的内容", text.includes("当天改过的内容"), text);
        check("卡片不出现机密标题", !text.includes("证件和保单号"), text);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
        check("Esc 关掉卡片", (await card.count()) === 0);
        await page.mouse.move(5, 5);
        await page.waitForTimeout(150);

        const before = await page.locator(".dem-heat-total").textContent();
        const chip = page.locator(".dem-heat-chip", { hasText: "笔记" });
        await chip.click();
        await page.waitForTimeout(300);
        check(
            "点图例筛掉一种类型",
            (await chip.getAttribute("aria-pressed")) === "false" &&
                (await page.locator(".dem-heat-total").textContent()) !== before,
        );
        await chip.click();
        await page.waitForTimeout(200);

        await page.locator(".dem-heat").focus();
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(150);
        check(
            "方向键换一天并读出来",
            /\d/.test((await page.locator(".dem-heat-live").textContent()) ?? ""),
        );
        await page.keyboard.press("Enter");
        await page.waitForTimeout(350);
        check("回车打开这一天", (await card.count()) === 1);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
        console.log(
            `${name.padEnd(9)} INFO 铺满一格，移动时帧间隔 ${JSON.stringify(await frameGaps(page))} ms`,
        );
        check("页面没有报错", errors.length === 0, errors);
        await page.close();
    }

    // The small one on the home page, with the star map turning behind it.
    {
        const { page, errors } = await open("#/screens/home");
        await page.waitForTimeout(2000);
        console.log(
            `${name.padEnd(9)} INFO 首页星图，指针不动，帧间隔 ${JSON.stringify(await frameGaps(page, false))} ms`,
        );
        check("首页有热度图小组件", (await painted(page)) > 100, await painted(page));
        console.log(
            `${name.padEnd(9)} INFO 首页小组件加星图，移动时帧间隔 ${JSON.stringify(await frameGaps(page))} ms`,
        );
        await page.mouse.move(5, 5);
        const index = 365;
        const at = await page.evaluate((i) => window.__heatLocate?.(i), index);
        await page.mouse.click(at.x, at.y);
        await page.waitForTimeout(500);
        const tab = await page.evaluate(() => window.__ws.tabs().find((t) => t.isActive));
        check("点一天在工作区打开大的", tab?.component === "heatmap", tab);
        check("带上了这一天", typeof tab?.params?.date === "string", tab?.params);
        check("大的有图例", (await page.locator(".dem-heat-chip:visible").count()) === 8);
        check(
            "打开时停在这一天",
            /\d/.test(
                (await page
                    .locator(".dem-heat-live:visible, .dem-heat-live")
                    .last()
                    .textContent()) ?? "",
            ),
        );
        check("首页页面没有报错", errors.length === 0, errors);
        await page.close();
    }
    await browser.close();
}
await server.close();
console.log(failed ? `${failed} checks failed` : "all heatmap checks passed");
process.exit(failed ? 1 : 0);
