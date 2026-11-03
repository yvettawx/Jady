// P5: a computer set to English gets an English app. Goes through the main screens and fails on any
// Chinese left on them. Run: PROBE_LOCALE=en-US node probe/p5-en.mjs
import { withApp } from "./harness.mjs";

const HAN = /\p{Script=Han}/u;

const failed = await withApp(
    "英文",
    async ({ page, check, wait, shot }) => {
        const clean = async (name) => {
            await wait(500);
            const text = await page.locator("body").innerText();
            const line = text
                .split("\n")
                // The language picker names Chinese in Chinese.
                .find((l) => HAN.test(l) && l.trim() !== "中文");
            check(`${name} 没有中文`, !line, line);
            await shot(name);
        };
        await page.locator(".dem-leftmost button, nav button").first().waitFor();
        await wait(1500);
        await clean("home");
        for (const [key, name] of [
            ["Meta+Shift+J", "life"],
            ["Meta+Shift+T", "today"],
            ["Meta+Shift+R", "learn"],
            ["Meta+Shift+A", "ai"],
            ["Meta+Shift+K", "vault"],
        ]) {
            await page.keyboard.press(key);
            await clean(name);
        }
        await page.keyboard.press("Meta+Shift+J");
        await wait(300);
        for (const name of [
            "Calendar",
            "Timeline",
            "Connections",
            "Map",
            "Balance wheel",
            "Scheduled tasks",
        ]) {
            await page
                .locator(".dem-life-nav:visible")
                .getByRole("button", { name, exact: true })
                .click();
            await clean(name);
        }
        await page.keyboard.press("Meta+,");
        await wait(500);
        await clean("settings");
        const sections = page.locator(".dem-settings [role=tab], .dem-settings-nav button");
        const n = await sections.count();
        for (let i = 0; i < n; i++) {
            const label = await sections.nth(i).innerText();
            await sections.nth(i).click();
            await clean(`settings ${label}`);
        }
    },
    { port: 1481 },
);
console.log(failed ? `${failed} checks failed` : "all checks passed");
process.exit(failed ? 1 : 0);
