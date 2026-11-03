// External plugins end to end on the real core: install from a folder, the permission question,
// the sandboxed frame, what a plugin can and cannot reach, commands, turning it off; and the two
// pages that came from Dify (what AI can find, scheduled tasks waiting for you). Run:
// pnpm run probe:plugins
import { resolve } from "node:path";
import { withApp } from "./harness.mjs";

const ESCAPE = resolve(import.meta.dirname, "fixtures/plugins/escape-check");
const EXAMPLE = resolve(import.meta.dirname, "../../../examples/plugins/word-count");

const failed = await withApp(
    "插件",
    async ({ page, call, check, wait, shot }) => {
        const note = (title, privacy, markdown) =>
            call("item_create", {
                item: {
                    typeId: "note",
                    title,
                    state: null,
                    container: null,
                    privacy,
                    fields: null,
                    tags: null,
                    due: null,
                    markdown,
                },
            });
        await note("canary-plugin 普通", null, "canary-plugin 正文");
        await note("canary-plugin 私密", "private", "canary-plugin 正文");
        await note("canary-plugin 敏感", "sensitive", "canary-plugin 正文");

        const command = async (text) => {
            const box = page.locator(".dem-launcher-box");
            if (await box.isVisible()) await page.keyboard.press("Escape");
            await page.keyboard.press("ControlOrMeta+K");
            await box.waitFor();
            await page.locator(".dem-launcher-input").fill(text);
            await wait(300);
            await page.keyboard.press("Enter");
            await wait(600);
        };
        const openSettings = async () => {
            await page.keyboard.press("ControlOrMeta+,");
            await wait(500);
            await page.getByRole("button", { name: "插件", exact: true }).first().click();
            await wait(300);
        };
        const install = async (dir) => {
            await page.evaluate((d) => window.__dialogs.push(d), dir);
            await page.getByRole("button", { name: "安装", exact: true }).first().click();
            await wait(600);
        };
        const enable = async (name) => {
            await page.locator(".dem-plugin-row", { hasText: name }).locator(".dem-switch").click();
            await wait(300);
        };
        // A panel's page, not the hidden background page of the same plugin.
        const frameOf = (id) =>
            page.frames().find((f) => f.url().includes(`/__plugin/${id}/index.html?panel=`));

        // --- 安装、问权限、启用 ---
        await openSettings();
        check("还没装插件时说一句", await page.getByText("还没装插件").first().isVisible());
        await install(ESCAPE);
        check("装上后列出来，默认关着", (await call("plugin_list"))[0]?.enabled === false);
        check(
            "没启用时协议不给文件",
            (await fetch(`http://127.0.0.1:1471/__plugin/escape-check/index.html`)).status === 404,
        );
        await enable("越狱检查");
        const dialog = page.getByRole("alertdialog");
        check("启用前列出它要的权限", await dialog.getByText("读你的普通内容").isVisible());
        check("也说清插件碰不到什么", await dialog.getByText(/不能上网/).isVisible());
        await shot("permission");
        await dialog.getByRole("button", { name: "启用" }).click();
        await wait(500);
        check("同意后启用", (await call("plugin_list"))[0]?.enabled === true);
        await page.keyboard.press("Escape");

        // --- 沙箱 ---
        await command("Escape check");
        const iframe = page.locator("iframe.dem-plugin-page").first();
        await iframe.waitFor({ timeout: 5000 });
        check("面板是不给同源的沙箱", (await iframe.getAttribute("sandbox")) === "allow-scripts");
        check(
            "面板上方写着插件名",
            await page.locator(".dem-plugin-name", { hasText: "越狱检查" }).first().isVisible(),
        );
        let out = null;
        for (let i = 0; i < 40 && !out; i++) {
            await wait(250);
            const f = frameOf("escape-check");
            const text = f
                ? await f
                      .locator("#out")
                      .textContent()
                      .catch(() => null)
                : null;
            if (text && text !== "running") out = JSON.parse(text);
        }
        check("检查跑完了", out !== null);
        if (out) {
            for (const way of [
                "parentDocument",
                "topLocation",
                "localStorage",
                "tauri",
                "parentTauri",
                "fetchWeb",
                "fetchHome",
                "ipc",
                "image",
                "popup",
                "create",
                "privacy",
            ])
                check(`出路关着：${way}`, out[way] === true, out[way]);
            check(
                "只搜得到普通内容",
                JSON.stringify(out.found) === '["canary-plugin 普通"]',
                out.found,
            );
            check("内容安全策略真的拦了", out.violations > 0, out.violations);
        }
        await shot("escape-check");

        // --- 能跑的例子 ---
        await openSettings();
        await install(EXAMPLE);
        await enable("字数统计");
        await page.getByRole("alertdialog").getByRole("button", { name: "启用" }).click();
        await wait(500);
        await page.keyboard.press("Escape");
        await command("字数统计");
        let total = null;
        for (let i = 0; i < 40 && !total; i++) {
            await wait(250);
            const f = frameOf("word-count");
            total = f
                ? await f
                      .locator("#total")
                      .textContent()
                      .catch(() => null)
                : null;
        }
        check("例子的面板算出了字数", /共 \d+ 字/.test(total ?? ""), total);
        await shot("word-count");
        await command("记下最近的总字数");
        await wait(800);
        const made = await call("item_list", {
            query: {
                typeId: null,
                states: null,
                container: null,
                tag: "word-count",
                order: null,
                limit: null,
            },
        });
        check("后台页面执行了命令，建了一条笔记", made.length === 1, made.length);
        check(
            "提示消息带着插件名",
            await page
                .getByText(/^字数统计：/)
                .first()
                .isVisible(),
        );

        // --- 关掉 ---
        await call("plugin_disable", { id: "escape-check" });
        check(
            "关掉后协议不再给文件",
            (await fetch(`http://127.0.0.1:1471/__plugin/escape-check/index.html`)).status === 404,
        );
        let refused = false;
        try {
            await call("plugin_call", { id: "escape-check", method: "search", args: "{}" });
        } catch {
            refused = true;
        }
        check("关掉后调用被拒绝", refused);

        // --- AI 能搜到什么 ---
        await page.keyboard.press("Meta+Shift+A");
        await wait(400);
        await page.getByRole("button", { name: "AI 能搜到什么" }).first().click();
        await wait(400);
        await page.getByPlaceholder("要搜的话").first().fill("canary-plugin");
        await wait(700);
        const panel = page.locator(".dem-aisee").first();
        const titles = (where) => where.locator(".dem-nav-title").allTextContents();
        check(
            "普通对话拿到普通的",
            (await titles(panel.locator(".dem-aisee-list").first())).includes("canary-plugin 普通"),
        );
        check(
            "列出拿不到的和原因",
            (await panel.locator(".dem-aisee-hidden li").count()) === 2 &&
                (await panel.locator(".dem-aisee-hidden").getByText("私密").count()) > 0,
        );
        await panel
            .getByRole("radio", { name: "授权对话" })
            .or(panel.getByRole("button", { name: "授权对话" }))
            .first()
            .click();
        await wait(600);
        check(
            "授权对话也拿到敏感的",
            (await titles(panel.locator(".dem-aisee-list").first())).includes("canary-plugin 敏感"),
        );
        await shot("ai-see");
    },
    { port: 1471 },
);
process.exit(failed ? 1 : 0);
