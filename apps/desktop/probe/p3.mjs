// P3 end to end, with a scripted AI behind the real gateway, so it uses no quota: chats, proposals
// and undo, what is offered and kept, review, conversation practice, problems, reciting, settings.
// Run: pnpm run probe:p3   (probe/real-ai.mjs checks the real Claude Code by hand)
import { withApp } from "./harness.mjs";

const failed = await withApp(
    "AI",
    async ({ page, call, check, wait, shot }) => {
        const visible = (selector, opts) => page.locator(`${selector}:visible`, opts);
        const item = (typeId, title, more = {}) => ({
            item: {
                typeId,
                title,
                state: null,
                container: null,
                privacy: null,
                fields: null,
                tags: null,
                due: null,
                markdown: null,
                ...more,
            },
        });
        const reload = async () => {
            await page.reload();
            await page.waitForSelector(".dem-shell");
            await wait(1000);
        };
        const bar = (label) => page.locator(`[aria-label="${label}"]`).first();

        await call("ai_settings_set", {
            settings: { provider: "fake", model: null, isolate: true },
        });
        const open = await call("item_create", item("note", "面包笔记", { markdown: "喂酵母\n" }));
        const secret = `ZZPRIVATE${Date.now()}`;
        const priv = await call(
            "item_create",
            item("note", "私密日记", { privacy: "private", markdown: `${secret}\n` }),
        );
        await reload();

        // --- A chat, docked, through the real tools ---
        await bar("AI").click();
        await wait(300);
        await page.getByRole("button", { name: "新对话" }).click();
        await page.waitForSelector(".dem-chat-panel:visible");
        const compose = visible(".dem-chat-compose textarea");
        await compose.fill(`@tool read_item {"id":"${priv.id}"}`);
        await compose.press("Enter");
        await wait(800);
        let chat = await visible(".dem-chat-list").textContent();
        check(
            "私密内容读不到，看起来和不存在一样",
            chat.includes("item not found or not accessible") && !chat.includes(secret),
            chat,
        );
        await compose.fill(`@tool read_item {"id":"${open.id}"}`);
        await compose.press("Enter");
        await wait(800);
        chat = await visible(".dem-chat-list").textContent();
        check("普通内容读得到", chat.includes("喂酵母"), chat);
        await shot("chat");

        // --- A proposal: only a card until confirmed; undo puts it back ---
        await compose.fill(
            `@tool propose_changes {"item_id":"${open.id}","changes":[{"field":"title","new_value":"酵母笔记"},{"field":"append_body","new_value":"AI 加的一句"}],"reason":"整理标题"}`,
        );
        await compose.press("Enter");
        await wait(1000);
        const card = visible("[data-testid=proposal]").first();
        check(
            "提议显示在对话里",
            (await card.textContent()).includes("整理标题"),
            await card.textContent(),
        );
        let now = await call("item_get", { id: open.id });
        check("确认前没有改", now.title === "面包笔记");
        await shot("proposal");
        await card.getByRole("button", { name: "只这一次" }).click();
        await wait(1000);
        now = await call("item_get", { id: open.id });
        check("确认后才改", now.title === "酵母笔记");
        const versions = await call("version_list", { id: open.id });
        check(
            "历史里记成 AI 改的",
            versions[0].origin === "ai",
            versions.map((v) => v.origin),
        );
        await card.getByRole("button", { name: /撤销/ }).click();
        await wait(1000);
        now = await call("item_get", { id: open.id });
        const md = await call("body_markdown", { id: open.id });
        check("撤销回到原来", now.title === "面包笔记" && !md.includes("AI 加的一句"), {
            title: now.title,
            md,
        });

        // Asking to change the level goes nowhere.
        await compose.fill(
            `@tool propose_changes {"item_id":"${open.id}","changes":[{"field":"privacy","new_value":"normal"}]}`,
        );
        await compose.press("Enter");
        await wait(700);
        check(
            "不能提议改隐私层级",
            (await visible(".dem-chat-list").textContent()).includes("cannot be changed"),
        );

        // --- Something offered: nothing is written until it is placed ---
        await compose.fill(
            `@tool create_items {"items":[{"type":"note","title":"小抄","markdown":"第一条\\n","origin":"ai_memory","needs_check":true}]}`,
        );
        await compose.press("Enter");
        await wait(900);
        const gen = visible("[data-testid=chat-generated]");
        check("AI 生成的内容摆在对话里", (await gen.textContent()).includes("小抄"));
        let found = await call("search", { query: "小抄", limit: 5 });
        check("放下之前没有写进库", found.length === 0, found);
        await gen.getByRole("button", { name: /存为新笔记/ }).click();
        await wait(1200);
        found = await call("item_list", {
            query: {
                typeId: "note",
                states: ["active"],
                container: null,
                tag: null,
                order: null,
                limit: null,
            },
        });
        const kept = found.find((i) => i.title === "小抄");
        check("存下来了", !!kept);
        const keptFull = await call("item_get", { id: kept.id });
        check(
            "标着 AI 凭记忆和待查",
            keptFull.source.origin === "aiMemory" && keptFull.source.needsCheck,
            keptFull.source,
        );

        // --- Ending keeps a record ---
        await visible(".dem-chat-panel-head").getByRole("button", { name: "结束" }).click();
        await wait(1200);
        const sessions = await call("item_list", {
            query: {
                typeId: "ai_session",
                states: ["active"],
                container: null,
                tag: null,
                order: null,
                limit: null,
            },
        });
        check("对话存成记录", sessions.length === 1, sessions.length);
        const fields = JSON.parse((await call("item_get", { id: sessions[0].id })).fields);
        check(
            "记录带摘要，别的不进普通搜索",
            fields.summary === "练习了问路。" &&
                (await call("search", { query: "练习了问路", limit: 5 })).length === 0,
            fields.summary,
        );

        // --- Card review: no AI, the real schedule ---
        await call(
            "item_create",
            item("card", "le quai", {
                fields: JSON.stringify({ front: "le quai", back: "站台", review: true }),
                tags: ["法语"],
            }),
        );
        await reload();
        await bar("学习").click();
        await wait(600);
        await shot("learn");
        await page.getByRole("button", { name: "复习 1" }).click();
        await page.waitForSelector(".dem-review:visible, [class*=review]:visible");
        await wait(400);
        await shot("review");
        const reviewText = await page.locator("body").innerText();
        check("到期的卡片出现", reviewText.includes("le quai"));
        const review = visible(".dem-review");
        await review.locator("textarea").fill("站台");
        await review.getByRole("button", { name: "看答案" }).click();
        await wait(200);
        await review.getByTestId("review-rates").getByRole("button", { name: /记得/ }).click();
        await wait(900);
        const queue = await call("review_queue", { limit: 10 });
        check(
            "答完就排到以后",
            queue.length === 0,
            queue.map((c) => c.front),
        );
        const mastery = await call("mastery_of", { tag: "法语" });
        check("掌握度有了", mastery > 0.5, mastery);

        // --- Conversation practice: corrections apart, due words count, harvest at the end ---
        await call(
            "item_create",
            item("card", "le train", {
                fields: JSON.stringify({ front: "le train", back: "火车", review: true }),
            }),
        );
        await reload();
        await bar("学习").click();
        await wait(400);
        const topic = visible("input[placeholder='开始对话练习，写个话题']").first();
        await topic.fill("问路");
        await page.keyboard.press("Enter");
        await page.waitForSelector(".dem-talk:visible");
        await wait(500);
        const box = visible(".dem-talk textarea");
        await box.fill("je prends le train, je suis allé à gare");
        await box.press("Enter");
        await wait(1200);
        await shot("talk");
        const talk = await visible(".dem-talk").textContent();
        check(
            "回复和纠错分开",
            talk.includes("Très bien") && talk.includes("je suis allé à la gare"),
            talk,
        );
        check("回复里没有留下标记", !talk.includes("```"));
        const dueNow = await call("review_queue", { limit: 10 });
        check(
            "用对到期的词算复习",
            !dueNow.some((c) => c.front === "le train"),
            dueNow.map((c) => c.front),
        );
        await visible(".dem-talk").getByRole("button", { name: "结束" }).click();
        await wait(1500);
        await shot("harvest");
        const sheet = await page.locator("body").innerText();
        check(
            "结束时先给本次收获",
            sheet.includes("本次收获") && sheet.includes("la voie"),
            sheet.slice(0, 200),
        );
        await page.getByRole("button", { name: /存入/ }).click();
        await wait(1500);
        const cards = await call("item_list", {
            query: {
                typeId: "card",
                states: ["active"],
                container: null,
                tag: null,
                order: null,
                limit: null,
            },
        });
        const titles = cards.map((c) => c.title);
        check(
            "新词变成记忆卡，已有的不重复",
            titles.includes("la voie") && titles.filter((c) => c === "le quai").length === 1,
            titles,
        );
        const quai = cards.find((c) => c.title === "le quai");
        check(
            "已有的卡只补例句",
            (await call("body_markdown", { id: quai.id })).includes("Le train part du quai 3"),
        );
        const voie = await call("item_get", { id: cards.find((c) => c.title === "la voie").id });
        check("学习里生成的卡默认参与复习", JSON.parse(voie.fields).review === true);
        const followups = await call("item_list", {
            query: {
                typeId: "followup",
                states: ["active"],
                container: null,
                tag: null,
                order: null,
                limit: null,
            },
        });
        check(
            "没做完的进待补清单",
            followups.some((f) => f.title === "还没练时间表达"),
        );
        const patterns = await call("item_list", {
            query: {
                typeId: "error_pattern",
                states: ["active"],
                container: null,
                tag: null,
                order: null,
                limit: null,
            },
        });
        check("错误记成错误模式", patterns.length === 1, patterns.length);

        // --- A problem, marked; a wrong answer is recorded ---
        const problem = await call(
            "item_create",
            item("problem", "两数之和", {
                fields: JSON.stringify({ kind: "code", language: "python", review: true }),
                markdown: "写一个函数\n",
            }),
        );
        await reload();
        await bar("学习").click();
        await wait(400);
        await page.getByRole("button", { name: /做题/ }).first().click();
        await wait(800);
        const answer = visible(".dem-flow textarea");
        await answer.fill("def f(:\n");
        await shot("practice");
        await page.getByRole("button", { name: "交卷" }).click();
        await wait(2000);
        const flow = await visible(".dem-flow").textContent();
        check(
            "编译检查的结果显示",
            /SyntaxError|invalid syntax|was never closed/.test(flow),
            flow.slice(0, 300),
        );
        check(
            "AI 判断对错",
            flow.includes("边界没处理") && !flow.includes("```"),
            flow.slice(0, 300),
        );
        const after = JSON.parse((await call("item_get", { id: problem.id })).fields);
        check("错题记下了，按排期重做", after.wrong === 1 && after.review === true, after);

        // --- Settings: AI access; a key never comes back ---
        await page.keyboard.press("Meta+,");
        await wait(500);
        await visible(".dem-settings").getByRole("button", { name: "AI", exact: true }).click();
        await wait(600);
        await shot("settings");
        const settings = await visible(".dem-settings-section").textContent();
        check(
            "设置里能选接入方式和模型",
            settings.includes("接入方式") && settings.includes("模型"),
            settings.slice(0, 200),
        );
        check("AI 不能改的只在这里", !(await call("ai_task_prompt", { task: "settings" })));

        // --- The four ways in; the address is checked; a key never comes back ---
        await visible(".dem-settings-section .dem-select-button").first().click();
        await wait(300);
        const ways = await page.getByRole("option").allTextContents();
        check(
            "接入方式有四种内置的",
            ["运行 Claude Code", "运行 Codex", "Anthropic API key", "OpenAI 兼容接口"].every((w) =>
                ways.includes(w),
            ),
            ways,
        );
        await page.keyboard.press("Escape");
        const compat = (endpoint) => ({
            settings: { provider: "openai-compatible", model: "qwen3", isolate: true, endpoint },
        });
        const refused = await call("ai_settings_set", compat("file:///etc/passwd")).then(
            () => false,
            () => true,
        );
        check("接口地址只收 http 和 https", refused);
        const canary = `sk-probe-${Date.now()}`;
        await call("ai_key_set", { provider: "openai-compatible", key: canary });
        const keyed = await call("ai_status");
        check(
            "兼容接口的 key 存了，读不回来",
            keyed.providers.find((p) => p.id === "openai-compatible")?.keySaved &&
                !JSON.stringify(keyed).includes(canary),
            keyed.providers,
        );
        await call("ai_settings_set", compat("http://localhost:11434/v1/"));
        await reload();
        await page.keyboard.press("Meta+,");
        await wait(500);
        await visible(".dem-settings").getByRole("button", { name: "AI", exact: true }).click();
        await wait(600);
        await shot("settings-compatible");
        const compatText = await visible(".dem-settings-section").textContent();
        check(
            "选了兼容接口，能填地址和 key",
            compatText.includes("接口地址") && compatText.includes("API key"),
            compatText.slice(0, 300),
        );
        const typed = await visible(".dem-settings-section input").first().inputValue();
        check("地址存的是整理过的", typed === "http://localhost:11434/v1", typed);
        await call("ai_key_set", { provider: "openai-compatible", key: null });
        await call("ai_settings_set", {
            settings: { provider: "fake", model: null, isolate: true },
        });
        await reload();

        // --- Reciting ---
        const poem = await call(
            "item_create",
            item("note", "静夜思", {
                markdown: "床前明月光\n\n疑是地上霜\n\n举头望明月\n\n低头思故乡\n",
            }),
        );
        await reload();
        await page.keyboard.press("Meta+Shift+E");
        await wait(300);
        await visible(".dem-tree-row", { hasText: "静夜思" }).first().click();
        await wait(800);
        await visible(".dem-sheet").first().getByRole("button", { name: "更多" }).click();
        await page.getByRole("menuitem", { name: "渐进背诵" }).click();
        await wait(800);
        await shot("recite");
        const covers = visible(".dem-recite-cover");
        check("有些句子藏起来", (await covers.count()) >= 2, await covers.count());
        await covers.first().click();
        await wait(100);
        await visible(".dem-recite").getByRole("button", { name: "记得" }).first().click();
        await wait(600);
        const lines = await call("recite_due", { item: poem.id, lines: 4 });
        check("每句单独计算", lines.filter((d) => !d).length === 1, lines);

        // --- 定期任务是系统条目：不进搜索，AI 看不到 ---
        await call("item_create", {
            item: {
                typeId: "scheduled_task",
                title: "每周搜职缺",
                state: null,
                container: null,
                privacy: null,
                fields: JSON.stringify({ frequency: "weekly", at: "00:00" }),
                tags: null,
                due: null,
                markdown: "搜一下新职缺 zztaskprompt",
            },
        });
        const hidden = await call("search", { query: "zztaskprompt", limit: 5 });
        check("定期任务不进搜索", hidden.length === 0);
        await page.evaluate(() => window.__emit("items-changed", null));
        await page.keyboard.press("Meta+Shift+J");
        await wait(400);
        await page
            .locator(".dem-life-nav:visible")
            .getByRole("button", { name: "定期任务", exact: true })
            .click();
        await wait(600);
        await page
            .locator(".dem-scheduled:visible")
            .getByRole("button", { name: "现在运行" })
            .click();
        await wait(2500);
        const inbox = await call("item_list", {
            query: {
                typeId: "note",
                states: ["inbox"],
                container: null,
                tag: null,
                order: "created",
                limit: 5,
            },
        });
        const result = inbox.find((i) => i.title?.startsWith("每周搜职缺"));
        check(
            "结果进收集箱",
            !!result,
            inbox.map((i) => i.title),
        );
        const full = result && (await call("item_get", { id: result.id }));
        check("结果标着来自 AI、要核对", full?.source?.needsCheck === true, full?.source);
        const task = await call("item_list", {
            query: {
                typeId: "scheduled_task",
                states: null,
                container: null,
                tag: null,
                order: null,
                limit: 1,
            },
        });
        check("记下了上次运行", !!JSON.parse(task[0].fields).last_run, task[0].fields);
    },
    { port: 1471 },
);
console.log(failed ? `${failed} checks failed` : "all p3 checks passed");
process.exit(failed ? 1 : 0);
