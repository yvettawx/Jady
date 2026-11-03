// Drives the home review page (#/screens/home, P0.5-07-3) in Chromium and WebKit: the star map
// draws only on the home page, hover and click work, ⌘⇧H and the space square bring it back,
// sidebar views float out and close, reduced motion holds the map still, and the scene can be
// left out. Starts its own Vite server.
// Run: pnpm run probe:home
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
let failed = 0;

const frames = (page) => page.evaluate(() => window.__starFrames ?? 0);
const onHome = (page) => page.locator(".dem-home").isVisible();
const activeTitle = (page) =>
    page.evaluate(() => window.__ws.tabs().find((t) => t.isActive)?.title);
/** A hub star that is on screen and not under a widget, in CSS px. */
const hubOnScreen = (page) =>
    page.evaluate(() => {
        const s = window.__starScene;
        const home = document.querySelector(".dem-home");
        for (const [i, b] of s.layout.bodies.entries()) {
            if (!b.node.hub || b.node.cluster === "diary") continue;
            const p = s.screenOf(i);
            if (p && document.elementFromPoint(p.x, p.y) === home)
                return { ...p, title: b.node.title };
        }
        return null;
    });
/** A hash of the star canvas, to tell whether it changed. */
const canvasHash = (page) =>
    page.evaluate(() => {
        const c = document.querySelector(".dem-starmap-canvas");
        const t = document.createElement("canvas");
        t.width = 64;
        t.height = 40;
        const g = t.getContext("2d");
        g.drawImage(c, 0, 0, 64, 40);
        let h = 0;
        for (const v of g.getImageData(0, 0, 64, 40).data) h = (h * 31 + v) | 0;
        return h;
    });

for (const engine of [chromium, webkit]) {
    const name = engine.name();
    const check = (label, ok, detail) => {
        if (!ok) failed++;
        console.log(
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} 首页：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
        );
    };
    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});
    const open = async (opts = {}, query = "") => {
        const page = await browser.newPage({
            locale: "zh-CN",
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            ...opts,
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(`${base}#/screens/home${query}`);
        await page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 0);
        return { page, errors };
    };

    for (const mode of ["light", "dark"]) {
        const { page, errors } = await open({ colorScheme: mode });
        // Let the layout settle so the cluster names show.
        await page.waitForTimeout(5000);
        check(`${mode}：打开先看到首页`, await onHome(page));
        const f0 = await frames(page);
        await page.waitForTimeout(500);
        check(`${mode}：星图在画`, (await frames(page)) > f0, { f0 });
        const labels = await page
            .locator(".dem-starmap-label")
            .evaluateAll((els) => els.filter((e) => getComputedStyle(e).opacity === "1").length);
        check(`${mode}：星团名字显示出来`, labels >= 4, labels);
        if (mode === "dark") {
            check("深色页面没有报错", errors.length === 0, errors);
            await page.close();
            continue;
        }

        // Hover a hub: its tooltip shows, then a click opens it and leaves the home page.
        const hub = await hubOnScreen(page);
        check("找到一颗不被挡住的星", !!hub, hub);
        if (hub) {
            await page.mouse.move(hub.x, hub.y);
            await page.waitForTimeout(200);
            const tip = await page
                .locator(".dem-starmap-tip")
                .textContent()
                .catch(() => null);
            check(
                "悬停显示标题和链接数",
                !!tip && tip.includes(hub.title) && /条链接/.test(tip),
                tip,
            );
            await page.mouse.click(hub.x, hub.y);
            await page.waitForTimeout(300);
            check(
                "点一下打开，离开首页",
                !(await onHome(page)) && (await activeTitle(page)) === hub.title,
                {
                    title: await activeTitle(page),
                },
            );
            const f1 = await frames(page);
            await page.waitForTimeout(500);
            check("离开首页后星图停下", (await frames(page)) === f1);
        }

        await page.keyboard.press("ControlOrMeta+Shift+H");
        await page.waitForTimeout(300);
        check("⌘⇧H 回到首页", await onHome(page));

        await page.keyboard.press("ControlOrMeta+2");
        await page.waitForTimeout(500);
        const inFr = await onHome(page);
        await page.getByRole("radio", { name: "法语" }).click();
        await page.waitForTimeout(300);
        check("再点一次当前空间回到首页", !inFr && (await onHome(page)), { inFr });
        await page.keyboard.press("ControlOrMeta+1");
        await page.waitForTimeout(500);
        await page.keyboard.press("ControlOrMeta+Shift+H");
        await page.waitForTimeout(300);

        // Sidebar views float out on the home page; Esc and a click on empty space close them.
        const float = page.locator(".dem-home-float");
        await page.getByRole("radio", { name: "目录" }).click();
        await page.waitForTimeout(300);
        check("点目录图标浮出面板", await float.isVisible());
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        check("Esc 收起", !(await float.isVisible()));
        await page.getByRole("radio", { name: "目录" }).click();
        await page.waitForTimeout(200);
        await page.mouse.click(700, 120);
        await page.waitForTimeout(200);
        check("点空白处收起，仍在首页", !(await float.isVisible()) && (await onHome(page)));
        await page.getByRole("radio", { name: "目录" }).click();
        await page.waitForTimeout(200);
        await page.getByRole("radio", { name: "目录" }).click();
        await page.waitForTimeout(200);
        check("再点一次图标收起", !(await float.isVisible()));
        await page.getByRole("radio", { name: "目录" }).click();
        await page.waitForTimeout(200);
        await float.getByText("第 11 课").click();
        await page.waitForTimeout(300);
        check(
            "在浮出的目录里打开内容，回到工作区",
            !(await onHome(page)) && (await activeTitle(page)) === "第 11 课",
            {
                title: await activeTitle(page),
            },
        );
        check("页面没有报错", errors.length === 0, errors);
        await page.close();
    }

    // Reduced motion: the map is drawn settled and does not turn.
    {
        const { page, errors } = await open({ colorScheme: "light", reducedMotion: "reduce" });
        await page.waitForTimeout(1500);
        const a = await canvasHash(page);
        await page.waitForTimeout(800);
        const b = await canvasHash(page);
        const labels = await page
            .locator(".dem-starmap-label")
            .evaluateAll((els) => els.filter((e) => getComputedStyle(e).opacity === "1").length);
        check("减少动效：星图不动，一开始就排好", a === b && labels >= 4, { a, b, labels });
        check("减少动效页面没有报错", errors.length === 0, errors);
        await page.close();
    }

    // 首页场景：不显示 — no star map, the wallpaper stays.
    {
        const { page, errors } = await open({ colorScheme: "light" }, "?scene=none");
        await page.waitForTimeout(800);
        check(
            "关掉星图：没有星图画布，首页照常",
            (await page.locator(".dem-starmap-canvas").count()) === 0 && (await onHome(page)),
        );
        check("关掉星图页面没有报错", errors.length === 0, errors);
        await page.close();
    }
    await browser.close();
}

await server.close();
console.log(failed ? `${failed} checks failed` : "all home checks passed");
process.exit(failed ? 1 : 0);
