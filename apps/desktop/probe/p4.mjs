// P4 end to end on the real core: templates, the calendar, the timeline, sums, habits and the views
// that look across the library. Run: pnpm run probe:p4
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withApp } from "./harness.mjs";

const failed = await withApp("生活", async ({ page, call, check, wait, shot }) => {
    const visible = (s, o) => page.locator(`${s}:visible`, o);
    const types = () => call("type_list");
    await page.locator(".dem-leftmost button, nav button").first().waitFor();

    // --- 模板：只添加类型 ---
    const before = (await types()).length;
    await page.keyboard.press("Meta+Shift+J");
    await wait(400);
    check("生活视图打开", await visible(".dem-life-nav").count());
    await page.keyboard.press("Meta+,");
    await wait(500);
    await page
        .getByRole("tab", { name: "模板" })
        .or(page.getByRole("button", { name: "模板", exact: true }))
        .first()
        .click();
    await wait(300);
    for (let i = 0; i < 4; i++) {
        await visible(".dem-templates")
            .getByRole("button", { name: "添加", exact: true })
            .first()
            .click();
        await wait(500);
    }
    const all = await types();
    check("四个模板加了七个类型", all.length === before + 7, all.length - before);
    check(
        "模板的类型是普通的自定义类型",
        all
            .filter((d) => ["habit", "media", "transaction", "trip_stop"].includes(d.id))
            .every((d) => !d.builtin),
    );
    check("财务默认敏感", all.find((d) => d.id === "transaction").default_privacy === "sensitive");
    check("类型名是当前语言", all.find((d) => d.id === "media").name === "书影音");
    await shot("templates");
    await page.keyboard.press("Escape");

    // --- 日程 ---
    const open = async (name) => {
        await page.keyboard.press("Meta+Shift+J");
        await wait(300);
        await visible(".dem-life-nav").getByRole("button", { name, exact: true }).click();
        await wait(600);
    };
    const todo = await call("item_create", {
        item: {
            typeId: "todo",
            title: "写报告 zzp4",
            state: null,
            container: null,
            privacy: null,
            fields: JSON.stringify({ status: "next" }),
            tags: null,
            due: null,
            markdown: null,
        },
    });
    await open("日程");
    await page.waitForSelector(".dem-cal-col:visible");
    await shot("calendar");
    // A to-do dragged onto the grid becomes a block and keeps its own due date.
    const col = visible(".dem-cal-col").nth(2);
    const box = await col.boundingBox();
    const area0 = await visible(".dem-cal-week").boundingBox();
    const row = visible(".dem-cal-todos li", { hasText: "写报告 zzp4" }).first();
    const from = await row.boundingBox();
    await page.mouse.move(from.x + 20, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 30, area0.y + 120, { steps: 6 });
    await wait(100);
    check("拖动时有占位", await visible(".dem-cal-ghost").count());
    await page.mouse.up();
    await wait(800);
    const blocks = visible(".dem-cal-block", { hasText: "写报告 zzp4" });
    check("待办拖进日程，成了时间块", (await blocks.count()) === 1);
    const list = await call("item_list", {
        query: {
            typeId: "schedule",
            states: null,
            container: null,
            tag: null,
            order: null,
            limit: null,
        },
    });
    check("时间块记着来自哪条待办", JSON.parse(list[0].fields).todo === todo.id);
    const start = list[0].span.start;
    // Move it.
    const b = await blocks.first().boundingBox();
    await page.mouse.move(b.x + 20, b.y + 14);
    await page.mouse.down();
    await page.mouse.move(b.x + 20, b.y + 14 + 88, { steps: 5 });
    await page.mouse.up();
    await wait(800);
    const moved = await call("item_get", { id: list[0].id });
    check(
        "拖动时间块改了时间",
        moved.span.start - start === 2 * 3_600_000,
        moved.span.start - start,
    );
    // Repeats, through its details.
    await call("item_update", {
        id: list[0].id,
        patch: { span: { ...moved.span, recurrence: "FREQ=DAILY;COUNT=3" } },
    });
    const seen = await call("agenda", {
        from: moved.span.start - 1,
        to: moved.span.start + 10 * 86_400_000,
    });
    check("重复规则展开成每一次", seen.length === 3, seen.length);
    await visible(".dem-life-head").getByRole("button", { name: "月", exact: true }).click();
    await wait(600);
    check("月视图能看到", (await visible(".dem-cal-day", { hasText: "写报告 zzp4" }).count()) >= 1);
    await shot("month");

    // --- 时间轴 ---
    const make = (typeId, title, fields) =>
        call("item_create", {
            item: {
                typeId,
                title,
                state: null,
                container: null,
                privacy: null,
                fields: fields ? JSON.stringify(fields) : null,
                tags: null,
                due: null,
                markdown: null,
            },
        });
    const qin = await make("event", "秦统一", null);
    await call("item_update", { id: qin.id, patch: { occurred: "公元前221年" } });
    await make("trip_stop", "外滩", { date: "2026-12-01", kind: "see", lat: 31.24, lng: 121.49 });
    await open("时间轴");
    const lines = await visible(".dem-timeline li").allTextContents();
    check("公元前排在最前", lines[0].includes("秦统一"), lines[0]);
    check(
        "类型的日期字段也进时间轴",
        lines.some((l) => l.includes("外滩")),
    );
    await shot("timeline");

    // --- 财务统计 ---
    await make("transaction", "午饭", {
        amount: 30,
        category: "food",
        direction: "expense",
        date: "2026-11-02",
    });
    await make("transaction", "工资", {
        amount: 900,
        category: "other",
        direction: "income",
        date: "2026-11-02",
    });
    await make("transaction", "晚饭", {
        amount: 50,
        category: "food",
        direction: "expense",
        date: "2026-10-02",
    });
    await make("budget", "吃饭预算", { amount: 20, category: "food" });
    await page.keyboard.press("Meta+Shift+J");
    await wait(300);
    await visible(".dem-life-nav").getByRole("button", { name: "看 收支 的按月统计" }).click();
    await wait(700);
    const stats = await visible(".dem-stats").textContent();
    check(
        "按月合计，收入不算进支出",
        stats.includes("2026-11") && !stats.includes("930"),
        stats.slice(0, 120),
    );
    check("超预算会说", stats.includes("超出 10"), stats);
    await shot("stats");

    // --- 习惯 ---
    const habit = await make("habit", "跑步", null);
    const today = new Date().toLocaleDateString("sv");
    await make("habit_log", "跑步", { habit: habit.id, date: today });
    const heat = await call("activity_since", { day: today });
    check(
        "打卡进热度图",
        heat.some((a) => a.typeId === "habit_log"),
    );

    // --- 关系图、地图、平衡轮、白板 ---
    const person = await make("person", "老王 zzperson", null);
    const org = await make("organization", "某公司", null);
    await call("item_update", { id: person.id, patch: { fields: JSON.stringify({}) } });
    await call("note_set_markdown", { id: person.id, markdown: `[[${org.id}]]` }).catch(() => {});
    await open("关系图");
    check("关系图画出人物", (await visible(".dem-graph text", { hasText: "老王" }).count()) === 1);
    await shot("graph");
    await open("地图");
    check("地图上有地点", (await visible(".dem-map text", { hasText: "外滩" }).count()) === 1);
    const net = [];
    page.on("request", (r) => {
        if (!/localhost|127\.0\.0\.1|tauri|ipc/.test(r.url())) net.push(r.url());
    });
    await page.mouse.wheel(0, -200);
    await wait(300);
    check("地图不联网", net.length === 0, net);
    await shot("map");
    await make("domain", "语言", null);
    await page.evaluate(() => window.__emit("items-changed", null));
    await wait(600);
    await open("平衡轮");
    check("平衡轮有领域", (await visible(".dem-wheel-petal").count()) === 1);
    await shot("wheel");

    await page.keyboard.press("Meta+Shift+J");
    await wait(300);
    await visible(".dem-life-nav").getByRole("button", { name: "新建白板" }).click();
    await page.waitForSelector(".dem-board-surface:visible");
    await visible(".dem-life-head").getByRole("button", { name: "文字", exact: true }).click();
    await wait(400);
    const area = visible(".dem-board-node textarea").first();
    await area.fill("板上的字 zzboard");
    await area.blur();
    await wait(600);
    await visible(".dem-life-head").getByRole("button", { name: "文字", exact: true }).click();
    await wait(400);
    await visible(".dem-life-head").getByRole("button", { name: "连线", exact: true }).click();
    await visible(".dem-board-node")
        .first()
        .click({ position: { x: 4, y: 4 } });
    await wait(600);
    check("连上了线", (await page.locator(".dem-board-lines line").count()) === 1);
    const boards = await call("item_list", {
        query: {
            typeId: "whiteboard",
            states: null,
            container: null,
            tag: null,
            order: null,
            limit: null,
        },
    });
    const raw = await call("canvas_get", { id: boards[0].id });
    check("节点和线都存下了", Object.keys(raw).length === 3, Object.keys(raw).length);
    const hits = await call("search", { query: "zzboard", limit: 5 });
    check("白板上的字能搜到", hits.length === 1);
    await shot("whiteboard");

    // --- 密码库 ---
    await page.keyboard.press("Meta+Shift+K");
    await wait(300);
    await visible(".dem-life-nav").getByRole("button", { name: "打开密码库" }).click();
    await page.waitForSelector(".dem-vault-door:visible");
    await visible(".dem-vault-door input").nth(0).fill("vault-password-1");
    await visible(".dem-vault-door input").nth(1).fill("vault-password-2");
    await page.keyboard.press("Enter");
    await wait(300);
    check(
        "两次不一样不让建",
        (await visible(".dem-vault-door [role=alert]").textContent()).includes("不一样"),
    );
    await visible(".dem-vault-door input").nth(1).fill("vault-password-1");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".dem-vault-list:visible", { timeout: 15000 });
    await visible(".dem-vault").getByRole("button", { name: "新建", exact: true }).click();
    await wait(200);
    const fields = visible(".dem-vault-edit input");
    await fields.nth(0).fill("网银 zzvaulttitle");
    await fields.nth(2).fill("zzvaultpassword");
    await visible(".dem-vault-edit").getByRole("button", { name: "保存", exact: true }).click();
    await wait(600);
    check("存进密码库", (await visible(".dem-vault-list").textContent()).includes("zzvaulttitle"));
    const rows = await call("vault_rows");
    check("列表里没有密码", !JSON.stringify(rows).includes("zzvaultpassword"));
    const found = await call("search", { query: "zzvaulttitle", limit: 5 });
    check("搜索碰不到密码库", found.length === 0);
    await shot("vault");
    await visible(".dem-vault").getByRole("button", { name: "锁定", exact: true }).click();
    await wait(400);
    check(
        "锁定后看不到内容",
        (await visible(".dem-vault-door").count()) === 1 &&
            (await page.locator(".dem-vault-list").count()) === 0,
    );
    const denied = await call("vault_rows").then(
        () => false,
        () => true,
    );
    check("锁定后命令也拿不到", denied);
    await visible(".dem-vault-door input").first().fill("wrong-password");
    await page.keyboard.press("Enter");
    await wait(800);
    check(
        "密码错了进不去",
        (await visible(".dem-vault-door [role=alert]").textContent()).includes("不对"),
    );
    await visible(".dem-vault-door input").first().fill("vault-password-1");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".dem-vault-list:visible", { timeout: 15000 });
    check(
        "解锁后回来了",
        (await visible(".dem-vault-list").textContent()).includes("zzvaulttitle"),
    );

    // --- 同步：连到一个文件夹，存放处只有密文 ---
    const storage = mkdtempSync(join(tmpdir(), "dem-sync-"));
    await call("sync_connect", { target: { kind: "folder", location: storage }, token: null });
    const round = await call("sync_run");
    check("同步传上去了", round.uploaded > 5, round);
    const secretHit = spawnSync("grep", ["-rl", "zzboard", storage], { encoding: "utf8" });
    check("存放处读不到内容", secretHit.stdout.trim() === "", secretHit.stdout);
    const vaultHit = spawnSync("grep", ["-rl", "zzvaulttitle", storage], { encoding: "utf8" });
    check("密码库在存放处也读不到", vaultHit.stdout.trim() === "", vaultHit.stdout);
    const noLocal = spawnSync("ls", [storage], { encoding: "utf8" }).stdout;
    check(
        "本机的目录和索引不传",
        !noLocal.includes("local") && !noLocal.includes("index.sqlite"),
        noLocal,
    );
    const quiet = await call("sync_run");
    check("再同步一次没有新东西", quiet.uploaded === 0 && quiet.downloaded === 0, quiet);
    rmSync(storage, { recursive: true, force: true });

    // --- 代码题的沙盒运行 ---
    const run = await call("code_run", {
        language: "rust",
        code: 'fn main() { println!("{}", 2 + 2); }',
        tests: [{ input: "", expected: "4" }],
    });
    check(
        "代码题在沙盒里跑",
        run.state === "no-toolchain" || run.results[0]?.verdict === "pass",
        run,
    );

    const python = await call("code_run", {
        language: "python",
        code: "print(sum(map(int, input().split())))",
        tests: [{ input: "1 2", expected: "3" }],
    });
    check(
        "Python 也在沙盒里跑，没装时给安装命令",
        python.results[0]?.verdict === "pass" ||
            (python.state === "no-toolchain" && python.install),
        python,
    );

    // --- 专用浏览器：设置和提交前的确认 ---
    await call("browser_settings_set", {
        settings: { enabled: false, sites: ["https://Jobs.Example.com/x", " "] },
    });
    check(
        "网站列表只留主机名",
        JSON.stringify((await call("browser_settings")).sites) === '["jobs.example.com"]',
        await call("browser_settings"),
    );
    await page.keyboard.press("Meta+,");
    await wait(500);
    await page
        .getByRole("tab", { name: "专用浏览器" })
        .or(page.getByRole("button", { name: "专用浏览器", exact: true }))
        .first()
        .click();
    await wait(400);
    check(
        "设置里有专用浏览器",
        await page.getByText("让 AI 用专用浏览器", { exact: true }).count(),
    );
    check(
        "设置里显示网站列表",
        (await visible(".dem-browser-sites").inputValue()).includes("jobs.example.com"),
    );
    await shot("browser-settings");
    await page.keyboard.press("Escape");
    await page.evaluate(() =>
        window.__emit("browser-confirm", {
            id: 7,
            method: "POST",
            url: "https://jobs.example.com/apply",
            host: "jobs.example.com",
        }),
    );
    await wait(300);
    check("AI 要提交时先问", await page.getByText("AI 要向 jobs.example.com 提交内容").count());
    await shot("browser-confirm");
    await page.getByRole("button", { name: "不允许", exact: true }).click();
    await wait(300);
    check("回答后对话框关掉", !(await page.getByText("AI 要向 jobs.example.com 提交内容").count()));

    // --- 推导重建 ---
    const derivation = await call("item_create", {
        item: {
            typeId: "note",
            title: "勾股定理",
            state: null,
            container: null,
            privacy: null,
            fields: null,
            tags: null,
            due: null,
            markdown: "第一步\n\n第二步\n\n第三步\n",
        },
    });
    await page.evaluate(() => window.__emit("items-changed", null));
    check(
        "推导的步骤按行取得",
        (await call("body_markdown", { id: derivation.id })).includes("第二步"),
    );
});
process.exit(failed ? 1 : 0);
