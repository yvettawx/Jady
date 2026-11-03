---
name: dem-template
description: 给 Jady 加一个模板：一组内容类型，用户在设置里一键添加。用于“加一个记录 XX 的功能”这类需求，比如健身、植物、藏书，能用类型和字段组合出来时不用写新界面。
---

# 加一个模板

先读 `docs/extending/templates.md`。能跑的例子在 `apps/desktop/src/plugins/_example/index.tsx`，搜 `registerTemplate`。

## 步骤

1. 问清楚要记什么，列出字段。先想能不能只靠字段得到想要的视图：
   - 有单选字段就有看板。
   - 有日期字段就进时间轴。
   - 有日期和数字字段就有按月统计。
   - 字段名叫 `lat` 和 `lng` 就进地图。
2. 判断隐私：涉及钱、健康、身份的，`privacy` 写 `sensitive`。这样 AI 只在授权会话里能看。
3. 按 `docs/extending/README.md` 建一个插件，在 `activate` 里调用 `ctx.registerTemplate`。
4. 所有名字都写成语言表的键，放进 `messages.json`，至少给 `zh-CN`，发布的给 `en`。选项的键是 `<字段名的键>.<选项 id>`。
5. 运行软件，到设置的“模板”里添加，新建几条，看时间轴和统计对不对。

## 不要做

- 不要为了模板改 `dem-core` 或存储格式。模板就是数据。
- 不要写死个人内容或默认数据。
- 类型 id 用小写和下划线，带上插件前缀，避免和别的模板冲突。
