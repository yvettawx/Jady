// Targeted stress checks for the workspace and glass (P0.5-06 hand-test follow-up), in Chromium
// and WebKit: window sizes and pixel densities, live resizing, many long tabs, floating groups,
// dark mode and reduced transparency, 125 % text, leaks from opening and closing, closing a
// group's last tab, keyboard focus on tabs, and the smooth tab reorder animation.
// Screenshots go to probe/shots/ (not committed). Run: pnpm run probe:stress
import { mkdirSync } from "node:fs";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const SHOTS = new URL("./shots/", import.meta.url);
mkdirSync(SHOTS, { recursive: true });
const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];

const results = [];
const check = (engine, name, ok, detail) => {
    results.push({ engine, name, ok });
    console.log(
        `${engine.padEnd(9)} ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`,
    );
};
const shot = (page, name) => page.screenshot({ path: new URL(`${name}.png`, SHOTS).pathname });

async function open(browser, w, h, dpr, hash = "#/workspace") {
    const page = await browser.newPage({
        locale: "zh-CN",
        viewport: { width: w, height: h },
        deviceScaleFactor: dpr,
    });
    page.errors = [];
    page.on("pageerror", (e) => page.errors.push(String(e)));
    await page.goto(base + hash);
    await page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 0);
    await page.waitForTimeout(500);
    return page;
}

const groupsInfo = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll(".dv-groupview")].map((g) => {
            const r = g.getBoundingClientRect();
            return {
                w: Math.round(r.width),
                h: Math.round(r.height),
                floating: !!g.closest(".dv-resize-container"),
                refract: g.hasAttribute("data-refract"),
                glassRefract: g.hasAttribute("data-glass-refract"),
                bg: getComputedStyle(g).backgroundColor,
            };
        }),
    );

for (const engine of [chromium, webkit]) {
    const name = engine.name();
    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});

    // 1. Window sizes and pixel densities.
    for (const [w, h, dpr] of [
        [520, 640, 2],
        [800, 600, 1],
        [1280, 800, 2],
        [1920, 1080, 1],
    ]) {
        const page = await open(browser, w, h, dpr);
        const label = `${w}×${h}@${dpr}x`;
        const g = await groupsInfo(page);
        check(
            name,
            `${label}：网格分组都走 WebGL`,
            g.every((x) => x.refract),
            g,
        );
        const segH = await page
            .locator(".dem-segment")
            .evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().height)));
        check(name, `${label}：分段选择不换行`, segH <= 34, segH);
        check(
            name,
            `${label}：每格至少 160 宽`,
            g.every((x) => x.w >= 159) || w < 560,
            g.map((x) => x.w),
        );
        await page.getByText("竖排", { exact: true }).click();
        await page.waitForTimeout(300);
        const dropdowns = await page.locator(".dv-tabs-overflow-dropdown-default:visible").count();
        check(name, `${label}：竖排时没有溢出菜单`, dropdowns === 0, dropdowns);
        await shot(page, `${name}-${w}x${h}-vertical`);
        check(name, `${label}：页面没有报错`, page.errors.length === 0, page.errors);
        await page.close();
    }

    // 2. Live resizing repaints the wallpaper at the new size.
    {
        const page = await open(browser, 1280, 800, 2);
        await page.setViewportSize({ width: 700, height: 760 });
        await page.waitForTimeout(700);
        const s = await page.evaluate(() => {
            const c = [...document.querySelectorAll("canvas.dem-backdrop")].find(
                (x) => x.dataset.source,
            );
            return { source: c?.dataset.source, canvas: `${c?.width}x${c?.height}` };
        });
        check(
            name,
            "拉窄窗口后壁纸按新尺寸重画",
            s.source === "1400x1520" && s.canvas === "1400x1520",
            s,
        );
        const g = await groupsInfo(page);
        check(
            name,
            "拉窄后网格分组仍走 WebGL",
            g.every((x) => x.refract),
            g,
        );
        await shot(page, `${name}-resized`);
        await page.close();
    }

    // 3. Many long tabs in one cell: tabs shrink, the rest go to the overflow menu.
    {
        const page = await open(browser, 1280, 800, 2);
        await page.evaluate(() => {
            for (let i = 1; i <= 14; i++)
                window.__ws.open(
                    {
                        contentId: `long${i}`,
                        title: `第 ${i} 篇：一个很长很长的标题用来试截断 Le passé composé`,
                        component: "note",
                    },
                    { kind: "temp" },
                );
        });
        await page.waitForTimeout(400);
        const strip = await page.evaluate(() => {
            // The group whose tab strip holds the new tabs (打开的内容 lists their titles too).
            const g = [...document.querySelectorAll(".dv-groupview")].find((x) =>
                [...x.querySelectorAll(".dv-tab")].some((t) => t.textContent.includes("第 14 篇")),
            );
            const tabs = g.querySelector(".dv-tabs-container");
            return {
                group: Math.round(g.getBoundingClientRect().width),
                tabsRight: Math.round(
                    tabs.getBoundingClientRect().right - g.getBoundingClientRect().left,
                ),
                dropdown: !!g.querySelector(".dv-tabs-overflow-dropdown-default"),
            };
        });
        check(
            name,
            "很多长标题：页签不超出这一格，多出来的进溢出菜单",
            strip.tabsRight <= strip.group + 1 && strip.dropdown,
            strip,
        );
        await shot(page, `${name}-many-tabs`);
        await page.close();
    }

    // 4. Floating groups sit over content: CSS blur, not WebGL.
    {
        const page = await open(browser, 1280, 800, 2);
        await page.evaluate(() =>
            window.__ws.float(window.__ws.tabs().find((t) => t.contentId === "outline").id),
        );
        await page.waitForTimeout(400);
        const f = (await groupsInfo(page)).filter((x) => x.floating);
        check(
            name,
            "悬浮分组用 CSS 模糊，不走 WebGL",
            f.length === 1 && !f[0].refract && !f[0].glassRefract && f[0].bg !== "rgba(0, 0, 0, 0)",
            f,
        );
        await shot(page, `${name}-floating`);
        await page.close();
    }

    // 5. Dark mode and reduced transparency inside the workspace.
    {
        const page = await open(browser, 1280, 800, 2);
        await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
        await page.waitForTimeout(500);
        await shot(page, `${name}-dark`);
        await page.evaluate(() =>
            document.documentElement.toggleAttribute("data-reduce-transparency", true),
        );
        await page.waitForTimeout(300);
        const g = await groupsInfo(page);
        check(
            name,
            "减少透明度：分组变成实底",
            g.every((x) => /^rgb\(/.test(x.bg)),
            g.map((x) => x.bg),
        );
        check(name, "深色和减少透明度：页面没有报错", page.errors.length === 0, page.errors);
        await page.close();
    }

    // 6. Text at 125 %: tab content fits in the tab strip.
    {
        const page = await open(browser, 1280, 800, 2);
        await page.evaluate(() =>
            document.documentElement.style.setProperty("--dem-font-scale", "1.25"),
        );
        await page.waitForTimeout(300);
        const fit = await page.evaluate(() =>
            [...document.querySelectorAll(".dv-tab")].every((t) => {
                const c = t.querySelector(".dem-ctab");
                return (
                    !c || c.getBoundingClientRect().height <= t.getBoundingClientRect().height + 0.5
                );
            }),
        );
        check(name, "字号 125%：页签内容不被裁掉", fit, fit);
        await shot(page, `${name}-125`);
        await page.close();
    }

    // 7. Leaks: open and close many tabs, reload the layout repeatedly.
    {
        const page = await open(browser, 1280, 800, 2);
        const saved = await page.evaluate(() => JSON.stringify(window.__ws.save()));
        await page.evaluate((j) => {
            for (let round = 0; round < 10; round++) {
                const ids = [];
                for (let i = 0; i < 8; i++)
                    ids.push(
                        window.__ws.open(
                            { contentId: `t${round}-${i}`, title: `临时 ${i}`, component: "note" },
                            { kind: "temp" },
                        ),
                    );
                ids.forEach((id) => window.__ws.close(id));
                window.__ws.load(JSON.parse(j));
            }
        }, saved);
        await page.waitForTimeout(400);
        const counts = await page.evaluate(() => ({
            registered: window.__glassPanels?.(),
            groupsInDom: document.querySelectorAll(".dv-groupview").length,
            glassInDom: document.querySelectorAll(".dem-glass").length,
        }));
        check(
            name,
            "反复开关、重载布局后玻璃登记表不增长",
            counts.registered === counts.glassInDom,
            counts,
        );
        await page.close();
    }

    // 8. Closing a group's last tab removes the cell; the shape stays valid.
    {
        const page = await open(browser, 1280, 800, 2);
        const before = await page.evaluate(() => window.__ws.shape());
        await page.evaluate(() =>
            window.__ws.close(window.__ws.tabs().find((t) => t.contentId === "links").id),
        );
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => window.__ws.shape());
        check(
            name,
            "关掉一格里最后一个页签，这一格消失",
            after.rows.join() === "2,1,1" && before.rows.join() === "2,1,2",
            { before, after },
        );
        await page.close();
    }

    // 9. Keyboard: tabs can be reached and show a focus ring.
    {
        const page = await open(browser, 1280, 800, 2);
        let reached = null;
        for (let i = 0; i < 25 && !reached; i++) {
            await page.keyboard.press("Tab");
            reached = await page.evaluate(() => {
                const t = document.activeElement?.closest(".dv-tab");
                if (!t) return null;
                const cs = getComputedStyle(t);
                return {
                    title: t.textContent.trim().slice(0, 12),
                    ring: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0,
                };
            });
        }
        check(name, "键盘能走到页签，焦点框看得见", !!reached && reached.ring, reached);
        await page.close();
    }

    // 10. Reordering animates: after a drop, moved tabs slide to their new places.
    {
        const page = await open(browser, 1280, 800, 2);
        const tab = page.locator(".dv-tab", { hasText: "第三章草稿" }).first();
        const home = await page.locator(".dv-tab", { hasText: "首页" }).first().boundingBox();
        const a = await tab.boundingBox();
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(a.x + a.width / 2 - 10, a.y + a.height / 2, { steps: 3 });
        await page.mouse.move(home.x + 6, home.y + home.height / 2, { steps: 12 });
        await page.waitForTimeout(80);
        await shot(page, `${name}-dragging`);
        await page.mouse.up();
        await page.waitForTimeout(60);
        const running = await page.evaluate(
            () =>
                document
                    .getAnimations()
                    .filter((x) => x.effect?.target?.classList?.contains("dv-tab")).length,
        );
        check(name, "放下后页签滑到新位置", running >= 2, running);
        await page.close();
    }

    // 11. Stacking onto another group's tab still works (dockview's smooth mode broke this).
    {
        const page = await open(browser, 1280, 800, 2);
        const t = await page.locator(".dv-tab", { hasText: "首页" }).first().boundingBox();
        const a = await page.locator(".dv-tab", { hasText: "反向链接" }).first().boundingBox();
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(a.x + 10, a.y + 14, { steps: 4 });
        await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 20 });
        // A hand never stops dead centre: with the line indicator, a pointer that has not moved
        // since landing exactly mid-tab has no side yet, so jiggle a little like a person does.
        for (let i = 1; i <= 3; i++)
            await page.mouse.move(t.x + t.width / 2 + i, t.y + t.height / 2, { steps: 2 });
        await page.waitForTimeout(150);
        await page.mouse.up();
        await page.waitForTimeout(300);
        const order = await page.evaluate(() => {
            const ws = window.__ws;
            const x = ws.tabs().find((q) => q.contentId === "links");
            return ws
                .tabs()
                .filter((q) => q.groupId === x.groupId)
                .map((q) => q.contentId);
        });
        check(name, "拖到另一组的某个页签上叠放", order.includes("home"), order);
        await page.close();
    }

    // 12. Losing the WebGL context (sleep, GPU switch) falls back to CSS blur, then recovers.
    {
        const page = await open(browser, 1280, 800, 2);
        const ext = await page.evaluateHandle(() => {
            const c = [...document.querySelectorAll("canvas.dem-backdrop")].find(
                (x) => x.dataset.source,
            );
            return c.getContext("webgl").getExtension("WEBGL_lose_context");
        });
        await ext.evaluate((x) => x.loseContext());
        await page.waitForTimeout(300);
        const lost = await groupsInfo(page);
        check(
            name,
            "WebGL 上下文丢失：分组改用 CSS 模糊，玻璃不透明",
            lost.every((x) => !x.refract && x.bg !== "rgba(0, 0, 0, 0)"),
            lost.map((x) => [x.refract, x.bg]),
        );
        await ext.evaluate((x) => x.restoreContext());
        await page.waitForTimeout(600);
        const back = await groupsInfo(page);
        check(
            name,
            "上下文恢复后重新走 WebGL",
            back.every((x) => x.refract),
            back.map((x) => x.refract),
        );
        await shot(page, `${name}-context-restored`);
        check(name, "上下文丢失和恢复：页面没有报错", page.errors.length === 0, page.errors);
        await page.close();
    }

    // 13. Clicking an item in 目录 opens it in the content cell, not in the directory's cell.
    {
        const page = await open(browser, 1280, 800, 2);
        await page.getByRole("row", { name: "第 11 课" }).click();
        await page.waitForTimeout(300);
        const where = await page.evaluate(() => {
            const ws = window.__ws;
            const t = ws.tabs().find((x) => x.contentId === "l11");
            return t
                ? ws
                      .tabs()
                      .filter((x) => x.groupId === t.groupId)
                      .map((x) => x.contentId)
                : null;
        });
        check(
            name,
            "从目录单击打开，开在中间的内容格",
            !!where && where.includes("home") && !where.includes("tree"),
            where,
        );
        await page.close();
    }

    // 14. Only the shown tab looks selected, also after switching tabs by clicking.
    {
        const page = await open(browser, 1280, 800, 2);
        await page.getByRole("row", { name: "第 11 课" }).click();
        await page.waitForTimeout(300);
        await page.locator(".dv-tab", { hasText: "第 12 课" }).click();
        await page.waitForTimeout(300);
        const lit = await page.evaluate(() => {
            const g = [...document.querySelectorAll(".dv-groupview")].find((x) =>
                [...x.querySelectorAll(".dv-tab")].some((t) => t.textContent.includes("第 12 课")),
            );
            return [...g.querySelectorAll(".dv-tab")]
                .filter(
                    (t) =>
                        getComputedStyle(t.querySelector(".dem-ctab")).backgroundColor !==
                        "rgba(0, 0, 0, 0)",
                )
                .map((t) => t.textContent.trim().slice(0, 8));
        });
        check(
            name,
            "切换页签后只有当前页签是选中的样子",
            lit.length === 1 && lit[0].startsWith("第 12 课"),
            lit,
        );
        await page.close();
    }

    await browser.close();
}

await server.close();
const failed = results.filter((r) => !r.ok);
console.log(
    `\n${results.length - failed.length}/${results.length} passed; screenshots in probe/shots/`,
);
process.exit(failed.length ? 1 : 0);
