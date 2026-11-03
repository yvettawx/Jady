// P2 end to end: the GTD loop without any AI (M5), on the real core.
// Run: pnpm run probe:p2
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withApp } from "./harness.mjs";

const failed = await withApp("组织", async ({ page, call, check, wait, shot }) => {
    const visible = (selector, opts) => page.locator(`${selector}:visible`, opts);
    const nav = async (key) => {
        await page.keyboard.press(key);
        await wait(400);
    };
    const open = (kind) => page.getByRole("button", { name: kind, exact: true });

    // Reminders from rules: a monthly or weekly review may be due depending on the date, so only the
    // decision is asserted; a review row must at least name itself.
    // --- 今天 ---
    await page.locator(".dem-leftmost button, nav button").first().waitFor();
    await nav("Meta+Shift+T");
    await visible(".dem-nav input").first().fill("中午想到一件事 zzloglinezz");
    await page.keyboard.press("Enter");
    await wait(900);
    await visible(".dem-nav").getByRole("button", { name: "打开今天" }).click();
    await page.waitForSelector(".dem-pm:visible");
    await wait(700);
    check(
        "间隙日志写进今天这一篇，带时间",
        /\d\d:\d\d 中午想到一件事/.test(await visible(".dem-pm").first().textContent()),
    );
    await shot("today");
    // A second line reaches the page that is open.
    await nav("Meta+Shift+T");
    const input = visible(".dem-nav input").first();
    await input.fill("第二句");
    await page.keyboard.press("Enter");
    await wait(1000);
    check(
        "开着的编辑器跟着变",
        (await visible(".dem-pm").first().textContent()).includes("第二句"),
    );

    // --- 待定事项 → 决策 ---
    const project = await call("item_create", {
        item: {
            typeId: "project",
            title: "申请学校",
            state: null,
            container: null,
            privacy: null,
            fields: null,
            tags: null,
            due: null,
            markdown: null,
        },
    });
    await page.evaluate(() => 0);
    await nav("Meta+Shift+E");
    await page.reload();
    await page.waitForSelector(".dem-shell");
    await wait(900);
    await nav("Meta+Shift+E");
    await visible(".dem-tree-row", { hasText: "申请学校" }).first().click();
    await page.waitForSelector(".dem-extras:visible");
    await wait(500);
    const extras = visible(".dem-extras");
    await extras.getByPlaceholder("加一个待定事项").fill("选哪个学校");
    await page.keyboard.press("Enter");
    await wait(800);
    await extras.getByPlaceholder("加一条待补").fill("问推荐信");
    await page.keyboard.press("Enter");
    await wait(800);
    await shot("project");
    check(
        "待定事项和待补清单和正文分开",
        (await extras.textContent()).includes("选哪个学校") &&
            (await extras.textContent()).includes("问推荐信"),
    );
    await extras.getByRole("button", { name: "记成决策" }).click();
    await wait(1000);
    check(
        "待定事项发展成决策记录",
        (await visible(".dem-sheet-title-input").first().inputValue()) === "选哪个学校",
    );
    const row = visible(".dem-fields-row", { hasText: "回看日期" });
    await row.locator("input").fill("2020-01-01");
    await wait(900);
    const reminders = await call("reminder_list");
    check(
        "回看日期到了会提醒",
        reminders.some((r) => r.kind === "decision" && r.title === "选哪个学校"),
        reminders,
    );

    // --- OKR ---
    const obj = await call("item_create", {
        item: {
            typeId: "objective",
            title: "拿到录取",
            state: null,
            container: null,
            privacy: null,
            fields: null,
            tags: null,
            due: null,
            markdown: null,
        },
    });
    await call("item_create", {
        item: {
            typeId: "key_result",
            title: "投递十家",
            state: null,
            container: null,
            privacy: null,
            tags: null,
            due: null,
            markdown: null,
            fields: JSON.stringify({
                objective: obj.id,
                measure: "count",
                target: 10,
                count_type: "todo",
                count_tag: "投递",
            }),
        },
    });
    await call("item_create", {
        item: {
            typeId: "todo",
            title: "投 A 校",
            state: null,
            container: null,
            privacy: null,
            tags: ["投递"],
            due: null,
            markdown: null,
            fields: JSON.stringify({ status: "done" }),
        },
    });
    await page.reload();
    await page.waitForSelector(".dem-shell");
    await wait(900);
    await page.locator('[aria-label="目标"]').first().click();
    await wait(500);
    await shot("okr");
    const okr = await visible(".dem-okr").first().textContent();
    check("完成数量自动算进度", okr.includes("拿到录取") && okr.includes("1/10"), okr);

    // --- 档案 ---
    await page.locator('[aria-label="档案"]').first().click();
    await wait(400);
    const exp = await call("item_create", {
        item: {
            typeId: "experience",
            title: "翻译",
            state: null,
            container: null,
            privacy: null,
            tags: null,
            due: null,
            markdown: "做了两年\n",
            fields: JSON.stringify({ org: "某社", from: "2020" }),
        },
    });
    await call("item_create", {
        item: {
            typeId: "skill",
            title: "法语",
            state: null,
            container: null,
            privacy: null,
            tags: null,
            due: null,
            markdown: null,
            fields: JSON.stringify({ level: "B2" }),
        },
    });
    await page.reload();
    await page.waitForSelector(".dem-shell");
    await wait(900);
    await page.locator('[aria-label="档案"]').first().click();
    await wait(400);
    await visible(".dem-nav,.dem-home-float").getByRole("button", { name: "生成简历" }).click();
    await page.waitForSelector(".dem-pm:visible");
    await wait(800);
    await shot("resume");
    let text = await visible(".dem-pm").first().textContent();
    check(
        "简历由档案生成",
        text.includes("翻译") && text.includes("某社") && text.includes("法语：B2"),
        text,
    );
    await call("item_update", { id: exp.id, patch: { fields: JSON.stringify({ org: "新社" }) } });
    await page.locator(".dem-sheet:visible").first().getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "按档案重新生成" }).click();
    await wait(1200);
    text = await visible(".dem-pm").first().textContent();
    check("事实只改一处，文档重新生成", text.includes("新社") && !text.includes("某社"), text);

    // --- 每周复盘 ---
    await call("item_create", {
        item: {
            typeId: "note",
            title: "收集箱里的一条",
            state: "inbox",
            container: null,
            privacy: null,
            fields: null,
            tags: null,
            due: null,
            markdown: null,
        },
    });
    await page.reload();
    await page.waitForSelector(".dem-shell");
    await wait(900);
    await page.locator('[aria-label="回顾"]').first().click();
    await wait(400);
    await visible(".dem-nav,.dem-home-float").getByRole("button", { name: "每周复盘" }).click();
    await page.waitForSelector(".dem-flow:visible");
    await wait(500);
    await shot("weekly");
    const flow = visible(".dem-flow");
    await flow
        .locator(".dem-flow-row", { hasText: "收集箱里的一条" })
        .getByRole("button", { name: "归档到目录" })
        .click();
    await wait(700);
    check(
        "复盘时整理收集箱",
        (await flow.locator(".dem-flow-row", { hasText: "收集箱里的一条" }).count()) === 0,
    );
    await flow.getByRole("button", { name: "下一步" }).click();
    await flow.getByRole("button", { name: "下一步" }).click();
    await flow.getByRole("button", { name: "下一步" }).click();
    await flow.getByRole("button", { name: "下一步" }).click();
    await wait(200);
    check("这一周的统计", /完成 1 条待办/.test(await flow.textContent()));
    await flow.getByRole("button", { name: "下一步" }).click();
    await flow.locator("textarea").fill("这周不错");
    await flow.getByLabel("下周重点").fill("写文书");
    await flow.getByRole("button", { name: "记下这次复盘" }).click();
    await page.waitForFunction(() =>
        [...document.querySelectorAll(".dem-sheet-title-input")].some((i) =>
            i.value.includes("这一周"),
        ),
    );
    await wait(800);
    text = await visible(".dem-pm").first().textContent();
    check("复盘存成回顾记录", text.includes("这周不错") && text.includes("写文书"), text);

    // --- Widgets ---
    await page.keyboard.press("Meta+Shift+H");
    await wait(700);
    await page.getByRole("button", { name: "调整小组件" }).click();
    await wait(200);
    const widget = page.locator('[data-widget="heat"]');
    const before = await widget.boundingBox();
    const title = widget.locator(".dem-home-widget-title");
    const tb = await title.boundingBox();
    await page.mouse.move(tb.x + 60, tb.y + 10);
    await page.mouse.down();
    await page.mouse.move(tb.x - 300, tb.y + 10, { steps: 6 });
    await page.mouse.up();
    await wait(300);
    const after = await widget.boundingBox();
    check("小组件能拖动", after.x < before.x - 100, { before, after });
    const handle = await widget.locator(".dem-home-widget-resize").boundingBox();
    await page.mouse.move(handle.x + 5, handle.y + 5);
    await page.mouse.down();
    await page.mouse.move(handle.x + 200, handle.y + 90, { steps: 6 });
    await page.mouse.up();
    await wait(300);
    const grown = await widget.boundingBox();
    check("小组件能改大小", grown.width > after.width, { grown, after });
    await page
        .locator('[data-widget="rem"]')
        .getByRole("button", { name: "去掉这个小组件" })
        .click();
    await wait(300);
    check("小组件能去掉", (await page.locator('[data-widget="rem"]').count()) === 0);
    await page.getByRole("button", { name: "添加小组件" }).click();
    await page.getByRole("menuitem", { name: "提醒" }).click();
    await wait(300);
    check("小组件能加回来", (await page.locator('[data-widget="rem"]').count()) === 1);
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await wait(1200);
    await shot("home-edit");
    await page.reload();
    await page.waitForSelector(".dem-shell");
    await wait(1200);
    const kept = await page.locator('[data-widget="heat"]').boundingBox();
    check("位置存下来了", Math.abs(kept.x - after.x) < 2 && kept.width > after.width, {
        kept,
        after,
    });

    // --- Custom CSS ---
    await page.keyboard.press("Meta+,");
    await wait(500);
    await page
        .locator(".dem-custom-css")
        .fill(".dem-settings { outline: 3px solid rgb(1, 2, 3); }");
    await wait(200);
    check(
        "自定义 CSS 立刻生效",
        (await page.locator(".dem-settings").evaluate((e) => getComputedStyle(e).outlineColor)) ===
            "rgb(1, 2, 3)",
    );
    await page.locator(".dem-custom-css").fill("");
    void open;
});
console.log(failed ? `${failed} checks failed` : "all p2 checks passed");
process.exit(failed ? 1 : 0);
