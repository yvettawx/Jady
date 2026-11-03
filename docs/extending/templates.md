# 模板

模板是一组普通的类型：在设置的“模板”里添加，类型名按当时的语言写进库里，之后和自己建的类型完全一样，可以随便改。生活里的习惯、书影音、财务、旅行都是这样做的，核心里没有它们的代码。

## 写一个

在插件里调用 `ctx.registerTemplate`，能跑的例子见 `apps/desktop/src/plugins/_example/index.tsx`（植物模板）。

```ts
ctx.registerTemplate({
  id: "plants",
  icon: "life",
  name: "plants.name",            // 语言表里的键
  about: "plants.about",
  types: [
    {
      id: "plant",
      name: "plants.type",
      view: "table",              // table、board 或 note
      privacy: "normal",          // 财务这类内容写 sensitive
      fields: [
        { key: "watered", name: "plants.watered", kind: { type: "date" } },
      ],
    },
  ],
  // 可选：新建一个项目，并带上几条待办
  starter: { action: "plants.start", todos: ["plants.todo.pot"] },
});
```

## 字段决定能用哪些视图

这些视图只看类型自己的字段，不认识具体的类型，所以模板和手工建的类型都能用：

| 类型有 | 自动得到 |
| --- | --- |
| 单选字段 | 看板 |
| 日期字段 | 进时间轴 |
| 日期加数字字段 | 按月统计（左边“生活”里的统计按钮）；有单选字段就能分组 |
| 名为 `lat` 和 `lng` 的数字字段 | 进地图 |
| 有一个叫 `budget` 的类型，且分组字段同名 | 统计里显示预算还剩多少 |

统计里，名为 `direction` 的字段当筛选用，只算 `expense`，收入和支出不会加在一起。
