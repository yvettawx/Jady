# 主题和外观

## 用户能直接改的

设置的“外观”：深浅色、配色方案、空间颜色（也能自己挑）、玻璃透明度、字号、密度、四种字体、页签方向、首页场景、溢光。

## 加一套配色

写一个插件，调 `ctx.registerScheme`，见 [plugin-api.md](plugin-api.md)。每组三个颜色，从这三个颜色推出强调色和壁纸渐变。太浅的颜色用作文字时会被自动加深，保证看得清。

## 令牌

所有颜色、字号、间距都是 CSS 变量，名字以 `--dem-` 开头。写样式时只用它们，这样深色模式、字号和配色都能自动跟上。

| 用途   | 令牌                                                                  |
| ------ | --------------------------------------------------------------------- |
| 文字   | `--dem-text`、`--dem-muted`、`--dem-faint`、`--dem-danger-text`       |
| 纸面   | `--dem-paper`、`--dem-paper-line`                                     |
| 强调色 | `--dem-accent`、`--dem-accent-fill`                                   |
| 悬停   | `--dem-hover`                                                         |
| 字号   | `--dem-text-xs`、`-sm`、`-base`、`-md`、`-long`、`-lg`、`-xl`、`-2xl` |
| 间距   | `--dem-space-1` 到 `--dem-space-6`                                    |
| 圆角   | `--dem-radius-sm`、`-md`                                              |
| 字体   | `--dem-font-ui`、`-long`、`-display`、`-mono`                         |
| 动效   | `--dem-dur-*`、`--dem-ease-*`，系统设了减少动态效果时自动变成 0       |

完整列表在 `apps/desktop/src/styles/theme.css`，这个文件是生成的。要改默认值，改 `apps/desktop/src/theme/tokens.ts`，再运行 `pnpm run gen:theme`。

## 用插件改样式

插件里 `import "./my.css"` 就会生效，可以覆盖任何样式：

```css
:root {
  --dem-radius-md: 4px;
}
.dem-sheet-title {
  font-weight: 400;
}
```

类名是 `dem-` 开头的。覆盖类名的样式在软件升级时可能失效，能用令牌就用令牌。

## 图标

组件只按我们自己的名字要图标，名字在 `apps/desktop/src/ui/icons.ts`。这个文件是唯一直接用图标库的地方，要换一整套图标改这里。

## 设计规范

`docs/05-design.md`：交互、视觉、文案。第 14 节是文案规范，按钮只写动作，不写“XX · XX”这种标签，不用长破折号。
