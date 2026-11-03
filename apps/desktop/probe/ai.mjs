// Drives the AI review page (#/screens/ai, P0.5-09) in Chromium and WebKit: the three things AI
// does, each taking effect the way it should; several windows at once; into the workspace and
// back; closed chats coming back; and what each kind of session may read. Answers are made up.
// Starts its own Vite server.
// Run: pnpm run probe:ai
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
let failed = 0;

for (const engine of [chromium, webkit]) {
    const name = engine.name();
    const check = (label, ok, detail) => {
        if (!ok) failed++;
        console.log(
            `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} AI：${label}${ok ? "" : "  " + JSON.stringify(detail)}`,
        );
    };
    const browser = await engine.launch(engine === chromium ? { args: ["--use-angle=metal"] } : {});
    const page = await browser.newPage({
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}#/screens/ai`);
    await page.waitForFunction(() => window.__ws && window.__ws.tabs().length > 0);
    await page.waitForSelector(".dem-chat-window");
    await page.waitForTimeout(500);

    const show = async (id) => {
        await page.evaluate((c) => {
            window.__ws.activate(window.__ws.tabs().find((x) => x.contentId === c).id);
        }, id);
        await page.waitForTimeout(250);
    };
    await show("lesson");
    const sheet = page.locator(".dv-groupview .dem-sheet:visible");
    const prose = () => sheet.locator(".dem-prose").textContent();
    const win = page.locator(".dem-chat-window").first();

    // Three things, three looks.
    const say = win.locator(".dem-chat-say").first();
    const gen = win.getByTestId("chat-generated");
    const prop = win.getByTestId("proposal");
    const framed = (l) => l.evaluate((el) => getComputedStyle(el).borderRadius !== "0px");
    check(
        "说话没有框，生成和提议有",
        !(await framed(say)) && (await framed(gen)) && (await framed(prop)),
    );
    const bg = (l) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
    check("生成和提议的底色不同", (await bg(gen)) !== (await bg(prop)));

    // A proposal changes nothing until confirmed, and shows in all three places.
    const before = await prose();
    check("提议没确认，原文不变", !before.includes("le passé composé）"), before);
    check("提议显示改动", (await prop.locator("ins").count()) > 0);
    const list = page.locator(".dem-prop-list");
    const inList = list.locator('[data-proposal="p-first"]');
    const dot = page.locator('[data-proposal-dot="p-first"]');
    const stateOf = (l) => l.getAttribute("data-state");
    check(
        "三处都有：左栏、段落旁、对话窗口",
        (await inList.count()) === 1 && (await dot.count()) === 1,
    );

    await prop.getByRole("button", { name: "只这一次" }).click();
    await page.waitForTimeout(150);
    check("在对话窗口确认：原文改了", (await prose()).includes("le passé composé）"));
    check("左栏同时更新", (await stateOf(inList)) === "confirmed");
    check("段落旁的小点消失", (await dot.count()) === 0);
    await inList.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(150);
    check("在左栏撤销：原文回去", (await prose()) === before);
    check("对话窗口同时更新", (await stateOf(prop)) === "pending");
    await page.waitForTimeout(100);
    // The chat window sits over the margin here, so by keyboard.
    await dot.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const pop = page.locator(".dem-prop-popover");
    await pop.getByRole("button", { name: "忽略" }).click();
    await page.waitForTimeout(150);
    check(
        "在小点上忽略：原文不变，三处一致",
        (await prose()) === before &&
            (await stateOf(prop)) === "ignored" &&
            (await stateOf(inList)) === "ignored",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await prop.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(150);

    // Deleting always asks: no 以后这类都允许, not in the batch.
    const del = list.locator('[data-proposal="p-delete"]');
    check(
        "删除没有以后都允许",
        (await del.getByRole("button", { name: "以后这类都允许" }).count()) === 0,
    );

    // Text that changed: the other proposal on it can only be ignored.
    const secondCard = list.locator('[data-proposal="p-second"]');
    const other = list.locator('[data-proposal="p-other"]');
    await secondCard.getByRole("button", { name: "只这一次" }).click();
    await page.waitForTimeout(150);
    check(
        "原文变了，同一段的另一条只能忽略",
        (await other.textContent())?.includes("原文已经变了") &&
            (await other.getByRole("button", { name: "只这一次" }).count()) === 0,
    );
    await secondCard.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(150);
    check(
        "撤销后那一条又能确认",
        (await other.getByRole("button", { name: "只这一次" }).count()) === 1,
    );

    // 以后这类都允许: only by pressing it; later ones go through; Settings lists it and takes it back.
    await inList.getByRole("button", { name: "以后这类都允许" }).click();
    await page.waitForTimeout(150);
    check(
        "提示规则的内容",
        (await inList.textContent())?.includes("整理，在法语里"),
        await inList.textContent(),
    );
    const box0 = win.locator("textarea");
    const send = async (text) => {
        await box0.fill(text);
        await box0.press("Enter");
        await page.waitForFunction(() => !document.querySelector(".dem-chat-thinking"), null, {
            timeout: 8000,
        });
        await page.waitForTimeout(200);
    };
    await send("整理第 11 课");
    let last = win.getByTestId("proposal").last();
    check(
        "同一类同一范围的新提议直接生效",
        (await last.textContent())?.includes("已按规则生效"),
        await last.textContent(),
    );
    await last.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(150);
    await page.keyboard.press("ControlOrMeta+,");
    await page.waitForTimeout(400);
    const settings = page.locator(".dem-settings");
    await settings.getByRole("button", { name: "AI" }).click();
    await page.waitForTimeout(150);
    check("设置里列出规则", (await settings.textContent())?.includes("整理，在法语里"));
    await settings.getByRole("button", { name: "撤回" }).click();
    await page.waitForTimeout(150);
    check("撤回规则", (await settings.getByRole("button", { name: "撤回" }).count()) === 0);
    await page.evaluate(() => {
        const t = window.__ws.tabs().find((x) => x.component === "settings");
        window.__ws.close(t.id);
    });
    await show("lesson");
    await send("再整理一次");
    last = win.getByTestId("proposal").last();
    check(
        "撤回后新提议又要问",
        (await last.getByRole("button", { name: "只这一次" }).count()) === 1,
    );
    await last.getByRole("button", { name: "忽略" }).click();
    await inList.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(150);
    check("撤销那次允许后原文回去", (await prose()) === before);

    // A batch skips the deletion.
    await list.getByRole("button", { name: /全部确认/ }).click();
    await page.waitForTimeout(200);
    check(
        "全部确认不带删除",
        (await stateOf(del)) === "pending" && (await prose()).includes("这一段以后再看"),
    );
    await list
        .locator('[data-state="confirmed"]')
        .first()
        .getByRole("button", { name: "撤销" })
        .click();
    for (const id of ["p-first", "p-second"]) {
        const card = list.locator(`[data-proposal="${id}"]`);
        if ((await stateOf(card)) === "confirmed")
            await card.getByRole("button", { name: "撤销" }).click();
    }
    await page.waitForTimeout(200);
    check("都撤销后原文回去", (await prose()) === before, await prose());

    // Something generated goes nowhere until you place it.
    await gen.getByRole("button", { name: "插入原文下方" }).click();
    await page.waitForTimeout(150);
    check("插入原文下方", (await prose()).includes("过去分词要和主语配合"));
    await gen.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(150);
    check("撤销插入", (await prose()) === before);
    await gen.getByRole("button", { name: "存为新笔记" }).click();
    await page.waitForTimeout(350);
    check(
        "存为新笔记打开新页签",
        (await page.evaluate(() => window.__ws.tabs().find((t) => t.isActive)?.title)) ===
            "第 12 课的总结",
    );
    await gen.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(250);
    await show("lesson");

    // Talking: Enter sends, Shift+Enter does not, an answer arrives, Stop stops it.
    const box = win.locator("textarea");
    await box.fill("être 和 avoir");
    await box.press("Shift+Enter");
    check("Shift+回车不发送", (await box.inputValue()).length > 0);
    await box.fill("être 和 avoir");
    const countMe = () => win.locator(".dem-chat-me").count();
    const me0 = await countMe();
    await box.press("Enter");
    await page.waitForTimeout(120);
    check("回车发送", (await countMe()) === me0 + 1);
    check(
        "运行中状态栏有显示",
        (await page.locator(".dem-statusbar").textContent())?.includes("AI 正在运行"),
    );
    await win.getByRole("button", { name: "停止" }).click();
    await page.waitForTimeout(120);
    check("停止后可以再发", (await win.getByRole("button", { name: "发送" }).count()) === 1);

    // A second window opens beside it and neither blocks the other.
    await show("resume");
    await sheet.getByRole("button", { name: "总结" }).click();
    await page.waitForTimeout(250);
    let dialog = page.locator(".dem-dialog");
    check(
        "敏感：没标联网，只给授权对话",
        (await dialog.getByRole("button", { name: "开联网授权对话" }).count()) === 0,
    );
    await dialog.getByRole("button", { name: "开授权对话" }).click();
    await page.waitForTimeout(300);
    check("同时开两个对话", (await page.locator(".dem-chat-window").count()) === 2);
    const second = page.locator(".dem-chat-window").nth(1);
    check(
        "授权对话有标注",
        (await second.getByTestId("chat-session").textContent())?.includes("授权对话"),
    );
    let text = (await second.locator(".dem-chat-say").first().textContent()) ?? "";
    check(
        "授权对话能读两篇敏感内容，读不到私密",
        text.includes("投递资料") && text.includes("期望薪资") && !text.includes("10月17日"),
        text,
    );
    await second.getByRole("button", { name: "关闭" }).click();
    await page.waitForTimeout(150);

    // The mark: only the user sets it, it asks first, and it opens the second kind of session.
    const picker = sheet.getByRole("button", { name: "隐私层级" });
    await picker.click();
    await page.getByRole("menuitem", { name: "可以联网给 AI 用" }).click();
    await page.waitForTimeout(200);
    dialog = page.locator(".dem-dialog");
    check("标联网先确认", (await dialog.textContent())?.includes("可能随搜索发出去"));
    await dialog.getByRole("button", { name: "可以联网" }).click();
    await page.waitForTimeout(200);
    check("标过的敏感内容有记号", (await sheet.locator(".dem-privacy-web").count()) === 1);
    await sheet.getByRole("button", { name: "总结" }).click();
    await page.waitForTimeout(200);
    dialog = page.locator(".dem-dialog");
    await dialog.getByRole("button", { name: "开联网授权对话" }).click();
    await page.waitForTimeout(300);
    const web = page.locator(".dem-chat-window").nth(1);
    check(
        "联网授权对话有自己的标注",
        (await web.getByTestId("chat-session").textContent())?.includes("联网授权对话"),
    );
    text = (await web.locator(".dem-chat-say").first().textContent()) ?? "";
    check(
        "联网授权对话只读标过的",
        text.includes("投递资料") &&
            !text.includes("期望薪资") &&
            !text.includes("10月17日") &&
            text.includes("受保护的内容"),
        text,
    );

    // Into the workspace and back.
    await web.getByRole("button", { name: "放进工作区" }).click();
    await page.waitForTimeout(350);
    let tab = await page.evaluate(() => window.__ws.tabs().find((t) => t.component === "ai-chat"));
    check(
        "放进工作区成了页签",
        !!tab && (await page.locator(".dem-chat-window").count()) === 1,
        tab,
    );
    check(
        "页签上有联网授权标记",
        (await page.locator('.dem-ctab-session[data-session="webAuth"]').count()) >= 1,
    );
    await page.getByRole("button", { name: "变回小窗口" }).click();
    await page.waitForTimeout(350);
    check("变回小窗口", (await page.locator(".dem-chat-window").count()) === 2);

    // Closed chats come back; taking the mark away closes that door.
    const count = await page.locator(".dem-chat-window").count();
    await page.locator(".dem-chat-window").nth(1).getByRole("button", { name: "关闭" }).click();
    await page.waitForTimeout(150);
    check("关掉窗口", (await page.locator(".dem-chat-window").count()) === count - 1);
    await show("records");
    await page.locator('[aria-label="AI 对话"] [role="row"]').last().click();
    await page.waitForTimeout(250);
    check("从 AI 对话找回来", (await page.locator(".dem-chat-window").count()) === count);
    await page.locator(".dem-chat-window").nth(1).getByRole("button", { name: "关闭" }).click();
    await picker.click();
    await page.getByRole("menuitem", { name: "可以联网给 AI 用" }).click();
    await page.waitForTimeout(200);
    check("撤回联网不用确认", (await sheet.locator(".dem-privacy-web").count()) === 0);

    // 本次收获: nothing saved until 存入; an existing card only gains the example.
    await show("harvest");
    const sheetH = page.locator(".dem-harvest:visible");
    const rowOf = (text) => sheetH.locator(".dem-harvest-row", { hasText: text });
    check("已有记忆卡的词标补例句", (await rowOf("le quai").textContent())?.includes("补例句"));
    check("新词不标补例句", !(await rowOf("le guichet").textContent())?.includes("补例句"));
    check("例句用对话原句", (await rowOf("le retard").textContent())?.includes("vingt minutes"));
    check(
        "错误写明属于哪个错误模式",
        (await rowOf("Je suis allé").textContent())?.includes("助动词选错，第 3 次"),
    );
    const countText = () => sheetH.locator(".dem-harvest-foot span").first().textContent();
    check("一开始全选", (await countText()) === "存入 8 项", await countText());
    await rowOf("le retard").locator(".dem-check").click();
    await page.waitForTimeout(100);
    check("取消一项少存一项", (await countText()) === "存入 7 项", await countText());
    await sheetH.getByRole("button", { name: "存入" }).click();
    await page.waitForTimeout(200);
    const saved = sheetH.getByTestId("harvest-saved");
    const savedText = (await saved.textContent()) ?? "";
    check(
        "存入后说明做了什么：新建 1 张，补 1 条例句",
        savedText.includes("新建 1 张记忆卡") && savedText.includes("给 1 张记忆卡补了例句"),
        savedText,
    );
    check(
        "写明进了错误模式和待补清单",
        savedText.includes("错误模式 2 条") && savedText.includes("待补清单 2 件"),
        savedText,
    );
    await saved.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(150);
    check("撤销后回到选择，选择还在", (await countText()) === "存入 7 项", await countText());
    await sheetH.getByRole("button", { name: "放弃" }).click();
    await page.waitForTimeout(250);
    check("放弃要确认", (await page.locator(".dem-dialog").textContent())?.includes("不会存入"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // 记忆卡复习, by keyboard alone: answer first, peek is recorded, sure-and-wrong comes first.
    await show("review");
    const review = page.locator(".dem-review");
    const frontText = () => review.getByTestId("review-front").textContent();
    const back = review.getByTestId("review-back");
    const rates = review.getByTestId("review-rates").locator("button");
    await review.focus();
    check("答之前看不到答案", (await back.count()) === 0);
    check("看答案要先答", await review.getByRole("button", { name: "看答案" }).isDisabled());
    await page.keyboard.press("Space");
    await page.waitForTimeout(80);
    check("没答按空格不翻", (await back.count()) === 0);
    // Card 1: very sure, then forgot.
    await page.keyboard.press("3");
    await page.keyboard.press("Space");
    await page.waitForTimeout(80);
    check("选了把握才能翻，四个评分", (await back.count()) === 1 && (await rates.count()) === 4);
    await page.keyboard.press("1");
    await page.waitForTimeout(80);
    check("按 1 评分进到下一张", (await frontText())?.includes("助动词"), await frontText());
    // Card 2: peek.
    await page.keyboard.press("p");
    await page.waitForTimeout(80);
    check(
        "偷看后只有两个评分并说明",
        (await rates.count()) === 2 && (await review.textContent())?.includes("偷看过"),
    );
    await page.keyboard.press("3");
    await page.waitForTimeout(80);
    check("偷看后按 3 不算数", (await back.count()) === 1);
    await page.keyboard.press("2");
    await page.waitForTimeout(80);
    // Card 3: typed answer; number keys go into the box, Enter shows.
    await review.locator("textarea").focus();
    await page.keyboard.type("窗口 1");
    check("打字时数字进答案", (await review.locator("textarea").inputValue()) === "窗口 1");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(80);
    check(
        "回车看答案，自己的答案还在",
        (await back.count()) === 1 && (await review.textContent())?.includes("窗口 1"),
    );
    await page.keyboard.press("3");
    await page.waitForTimeout(80);
    // Z takes it back.
    await page.keyboard.press("z");
    await page.waitForTimeout(80);
    check("Z 撤销上一张", (await back.count()) === 1);
    await page.keyboard.press("3");
    await page.waitForTimeout(80);
    // Cards 4 and 5.
    await page.keyboard.press("1");
    await page.keyboard.press("Space");
    await page.waitForTimeout(80);
    await page.keyboard.press("1");
    await page.waitForTimeout(80);
    await page.keyboard.press("2");
    await page.keyboard.press("Space");
    await page.waitForTimeout(80);
    await page.keyboard.press("4");
    await page.waitForTimeout(150);
    const done = review.getByTestId("review-done");
    const doneText = (await done.textContent()) ?? "";
    check(
        "结束时有汇总",
        doneText.includes("复习了 5 张") &&
            doneText.includes("忘了 2 张") &&
            doneText.includes("偷看 1 次"),
        doneText,
    );
    check(
        "列出自以为会但答错",
        doneText.includes("自以为会但答错") && doneText.includes("le quai"),
        doneText,
    );
    // The chat window sits over this corner of the page, so by keyboard too.
    await done.getByRole("button", { name: "再来 2 张" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    check(
        "下一轮自以为会但答错的在前",
        (await frontText())?.includes("le quai"),
        await frontText(),
    );

    // 法语实时对话: AI is the page; corrections stay out of the conversation.
    await show("talk");
    const talk = page.locator(".dem-talk");
    const say2 = async (text) => {
        await talk.locator("textarea").fill(text);
        await talk.locator("textarea").press("Enter");
        await page.waitForTimeout(650);
    };
    const fixes = talk.locator(".dem-talk-fixes");
    const doneWord = (w) => talk.locator(".dem-talk-due li[data-done]", { hasText: w }).count();
    check("开始前结束是灰的", await talk.getByRole("button", { name: "结束" }).isDisabled());
    await say2("J'ai allé à la gare.");
    const mine = talk.locator('.dem-talk-turn[data-who="me"]').last();
    check("纠错在自己的一栏", (await fixes.textContent())?.includes("Je suis allé"));
    check(
        "对话里你的句子原样，没有标红",
        (await mine.textContent()) === "J'ai allé à la gare." &&
            (await mine.locator("del, ins").count()) === 0,
        await mine.innerHTML(),
    );
    check(
        "对伙伴的回复没被打断",
        (await talk.locator('.dem-talk-turn[data-who="partner"]').count()) === 2,
    );
    await fixes.locator(".dem-talk-fix").first().hover();
    await page.waitForTimeout(120);
    check("指向纠错时亮起那一句", (await mine.getAttribute("data-lit")) !== null);
    await page.mouse.move(5, 5);
    await say2("Où est la guichet ?");
    check("用错的到期词不算复习", (await doneWord("le guichet")) === 0);
    await say2("Où est le guichet ?");
    check("用对了算复习", (await doneWord("le guichet")) === 1);
    check("没说到的词不算", (await doneWord("le retard")) === 0);
    await talk.getByRole("button", { name: "结束" }).click();
    await page.waitForTimeout(250);
    const after = page.locator(".dem-harvest:visible");
    const afterText = (await after.textContent()) ?? "";
    check(
        "结束后进本次收获，错误来自这次对话",
        afterText.includes("Je suis allé") &&
            afterText.includes("le guichet") &&
            !afterText.includes("la gare."),
        afterText,
    );

    // 来源和把握: what AI said carries it; 我写的 shows nothing; 待查 and a date can be dealt with.
    const lines = page.locator(".dem-chat-window").first().getByTestId("source-line");
    const lineText = (await lines.allTextContents()).join(" ");
    check(
        "AI 凭记忆、待查、搜来的、资料冲突都标出来",
        ["AI 凭记忆", "待查", "AI 搜来的", "资料冲突"].every((x) => lineText.includes(x)),
        lineText,
    );
    check("搜来的带出处", lineText.includes("SNCF 官网"), lineText);
    await show("lesson");
    check("我写的不显示标记", (await sheet.locator(".dem-source-button .dem-mark").count()) === 0);
    await show("lesson11");
    const srcBtn = sheet.locator(".dem-source-button");
    check(
        "AI 写的标来源和待查",
        (await srcBtn.textContent())?.includes("待查"),
        await srcBtn.textContent(),
    );
    await srcBtn.click();
    await page.waitForTimeout(250);
    const srcCard = page.locator(".dem-source-card");
    await srcCard.getByRole("button", { name: "查过了" }).click();
    await page.waitForTimeout(150);
    check("查过了去掉待查", !(await srcBtn.textContent())?.includes("待查"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await show("composter");
    check(
        "过了复查日期提醒",
        (await srcBtn.textContent())?.includes("该复查了"),
        await srcBtn.textContent(),
    );
    await srcBtn.click();
    await page.waitForTimeout(250);
    check("卡片说明出处不一", (await srcCard.textContent())?.includes("说法不一"));
    await srcCard.getByRole("button", { name: "复查过了" }).click();
    await page.waitForTimeout(150);
    check("复查过了去掉提醒", !(await srcBtn.textContent())?.includes("该复查了"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check("点完复查过了，Esc 还能关掉卡片", (await srcCard.count()) === 0);

    // 对照文本: each word's layers line up, also when a narrow cell wraps the line.
    await show("inter");
    const inter = page.locator(".dem-inter:visible").first();
    const aligned = () =>
        inter.locator(".dem-inter-word").evaluateAll((els) =>
            els.every((w) => {
                const lefts = [...w.children].map((c) =>
                    Math.round(c.getBoundingClientRect().left),
                );
                return lefts.every((x) => x === lefts[0]);
            }),
        );
    check("每个字的几层左边对齐", await aligned());
    await inter.getByRole("button", { name: "转写" }).click();
    await page.waitForTimeout(80);
    check("可以关掉一层", (await inter.locator(".dem-inter-translit").count()) === 0);
    await inter.getByRole("button", { name: "转写" }).click();
    await page.setViewportSize({ width: 760, height: 900 });
    await page.waitForTimeout(450);
    check("窄窗口换行后仍然对齐", await aligned());
    const over = await inter.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    check("窄窗口不溢出", !over);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);

    // 私密: greyed, nothing starts.
    await show("diary");
    check("私密：AI 按钮变灰", await sheet.getByRole("button", { name: "总结" }).isDisabled());
    check("页面没有报错", errors.length === 0, errors);
    await browser.close();
}
await server.close();
console.log(failed ? `${failed} checks failed` : "all AI checks passed");
process.exit(failed ? 1 : 0);
