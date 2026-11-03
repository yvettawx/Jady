// Checks that every switch in the sample room (#/sample) takes effect, in Chromium and WebKit;
// then, in light and dark, that no text lost its colour (contrast under 3 against what is
// behind it), and saves full-page screenshots to docs/plans/p0.5-shots/.
// Starts its own Vite server. Run: pnpm run probe:sample
import { mkdirSync } from "node:fs";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
// One long page (no inner scroll area) so full-page screenshots show everything.
const url = `${server.resolvedUrls.local[0]}#/sample?flow=page`;

const results = [];
const check = (engine, name, ok, detail) => {
    results.push({ engine, name, ok });
    console.log(
        `${engine.padEnd(9)} ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`,
    );
};
const cssVar = (page, name) =>
    page.evaluate(
        (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
        name,
    );
const bar = (page) => page.getByTestId("sample-bar");
const SHOTS = new URL("../../../docs/plans/p0.5-shots/", import.meta.url);
mkdirSync(SHOTS, { recursive: true });

/** Text whose colour, composited over everything behind it, reads at under 3:1. */
const lowContrast = (page) =>
    page.evaluate(() => {
        const parse = (c) => {
            let m = c.match(/^rgba?\(([^)]+)\)/);
            if (m) {
                const [r, g, b, a = 1] = m[1]
                    .split(/[\s,/]+/)
                    .filter(Boolean)
                    .map(Number);
                return { r, g, b, a };
            }
            m = c.match(/^color\(srgb ([^)]+)\)/);
            if (m) {
                const [r, g, b, a = 1] = m[1]
                    .split(/[\s/]+/)
                    .filter(Boolean)
                    .map(Number);
                return { r: r * 255, g: g * 255, b: b * 255, a };
            }
            return null;
        };
        const over = (top, under) => ({
            r: top.r * top.a + under.r * (1 - top.a),
            g: top.g * top.a + under.g * (1 - top.a),
            b: top.b * top.a + under.b * (1 - top.a),
            a: 1,
        });
        const lum = ({ r, g, b }) =>
            [r, g, b]
                .map((v) => v / 255)
                .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
                .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
        const ratio = (x, y) => {
            const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p);
            return (a + 0.05) / (b + 0.05);
        };
        const rootStyle = getComputedStyle(document.documentElement);
        const canvas = parse(getComputedStyle(document.body).backgroundColor) ?? {
            r: 255,
            g: 255,
            b: 255,
            a: 1,
        };
        // Glass drawn by the WebGL layer has no CSS background; use its paint over the base.
        const glassPaint = (() => {
            const probe = document.createElement("div");
            probe.style.color = rootStyle.getPropertyValue("--dem-glass");
            document.body.append(probe);
            const c = parse(getComputedStyle(probe).color);
            probe.remove();
            return c;
        })();
        const behind = (el) => {
            const layers = [];
            for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
                const cs = getComputedStyle(e);
                let bg = parse(cs.backgroundColor);
                if ((!bg || bg.a === 0) && e.hasAttribute("data-refract")) bg = glassPaint;
                if (bg && bg.a > 0) layers.push(bg);
                if (bg && bg.a >= 1) break;
            }
            return layers.reverse().reduce((acc, l) => over(l, acc), canvas);
        };
        const faded = (el) => {
            for (let e = el; e; e = e.parentElement)
                if (parseFloat(getComputedStyle(e).opacity) < 0.9) return true;
            return false;
        };
        const bad = [];
        for (const el of document.querySelectorAll("main *")) {
            const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
            if (!own || faded(el) || el.closest("[hidden], [aria-hidden=true]")) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const fg = parse(getComputedStyle(el).color);
            if (!fg) continue;
            const bg = behind(el);
            const c = ratio(over(fg, bg), bg);
            if (c < 3) bad.push(`${el.textContent.trim().slice(0, 16)} ${c.toFixed(2)}`);
        }
        return bad;
    });

for (const engine of [chromium, webkit]) {
    const name = engine.name();
    const browser = await engine.launch();
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForSelector(".sample-section");
    await page.waitForTimeout(400);

    const status = () => page.getByTestId("glass-status").textContent();
    check(name, "玻璃默认走 WebGL 背景层", (await status()) === "WebGL", await status());

    const paper = await cssVar(page, "--dem-paper");
    await bar(page).getByText("深色", { exact: true }).click();
    check(name, "深色", (await cssVar(page, "--dem-paper")) !== paper, {
        paper,
        now: await cssVar(page, "--dem-paper"),
    });
    await bar(page).getByText("深色", { exact: true }).click();

    await bar(page).getByText("English", { exact: true }).click();
    const english = await page.locator(".dem-mark[data-privacy=private]").first().textContent();
    check(name, "English：组件自带文字跟着换", english === "Private", english);
    await bar(page).getByText("English", { exact: true }).click();

    await bar(page)
        .getByRole("button", { name: /配色方案/ })
        .click();
    await page.getByRole("option", { name: "日落" }).click();
    const sunset = await cssVar(page, "--dem-accent");
    check(name, "配色方案", sunset === "#ff5e62", sunset);
    await bar(page).getByText("空间 2", { exact: true }).click();
    const space2 = await cssVar(page, "--dem-accent");
    check(name, "空间", space2 === "#ff9f43", space2);

    const base = await cssVar(page, "--dem-text-base");
    await bar(page).getByText("125%", { exact: true }).click();
    const size = await page
        .locator(".sample-section .dem-button")
        .first()
        .evaluate((e) => getComputedStyle(e).fontSize);
    check(name, "字号", size === "16.25px", { base, size });
    await bar(page).getByText("100%", { exact: true }).click();

    await bar(page).getByText("紧凑", { exact: true }).click();
    check(
        name,
        "密度",
        (await cssVar(page, "--dem-row-h")) === "24px",
        await cssVar(page, "--dem-row-h"),
    );
    await bar(page).getByText("标准", { exact: true }).click();

    const clear = await cssVar(page, "--dem-glass");
    await bar(page).getByText("着色", { exact: true }).click();
    const tinted = await cssVar(page, "--dem-glass");
    await bar(page).getByRole("slider").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const moved = await cssVar(page, "--dem-glass");
    check(name, "玻璃：着色和透明度滑块", clear !== tinted && tinted !== moved, {
        clear,
        tinted,
        moved,
    });

    await bar(page).getByText("减少透明度", { exact: true }).click();
    const solid = await page
        .locator(".sample-glass-card")
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundColor);
    check(name, "减少透明度：玻璃变实底", (await status()) === "实底" && /^rgb\(/.test(solid), {
        status: await status(),
        solid,
    });

    // Light and dark: nothing lost its colour; screenshots for the record.
    await bar(page).getByText("减少透明度", { exact: true }).click();
    await bar(page).getByText("透明", { exact: true }).click();
    await bar(page)
        .getByRole("button", { name: /配色方案/ })
        .click();
    await page.getByRole("option", { name: "极光" }).click();
    for (const mode of ["light", "dark"]) {
        await page.evaluate((m) => (document.documentElement.dataset.theme = m), mode);
        await page.waitForTimeout(400);
        const bad = await lowContrast(page);
        check(
            name,
            `${mode === "light" ? "浅色" : "深色"}：没有文字丢了颜色`,
            bad.length === 0,
            bad,
        );
        await page.screenshot({
            path: new URL(`sample-${name}-${mode}.jpg`, SHOTS).pathname,
            fullPage: true,
            type: "jpeg",
            quality: 80,
        });
    }

    check(name, "页面没有报错", errors.length === 0, errors);
    await browser.close();
}

await server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
