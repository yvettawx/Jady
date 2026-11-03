---
name: dem-theme
description: 改 Jady 的外观：加配色方案、调颜色字体间距圆角。当用户想换主题、改颜色或调整软件的样子时用。
---

# 改外观

先读 `docs/extending/theming.md`。

## 先看用户是不是只要改设置

配色、空间颜色、字体、字号、密度、玻璃效果、深浅色都能在软件的设置里直接改，不用写代码。如果用户要的是这些，告诉他们去哪里点。

## 加一套配色

写一个插件（见 `skills/dem-plugin/SKILL.md`），只调 `ctx.registerScheme`，并在语言表里给 `scheme.<id>` 起名。三组颜色，每组三个。

挑颜色时，每组要能拼成好看的渐变，浅色和深色模式下都看一下。

## 改令牌或样式

- 想让所有地方一起变：插件里 `import "./my.css"`，在 `:root` 上覆盖 `--dem-` 令牌。
- 想改默认值：改 `apps/desktop/src/theme/tokens.ts`，然后 `pnpm run gen:theme`。不要手改 `src/styles/theme.css`。
- 只用令牌，不写死颜色。深色模式要一起看。

## 验证

```bash
cd apps/desktop
pnpm run check
pnpm run dev
```

浏览器打开 `#/sample` 能看到所有组件，切一下深浅色。文字和背景的对比度至少要 4.5:1。
