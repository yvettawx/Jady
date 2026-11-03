# 从外面用这个软件

## 命令行

```bash
cargo install --path crates/dem-cli
dem add 想到的一件事
dem add --type todo 买票 --due 2026-12-01
dem today
dem list --type todo --tag 出行
dem search 法语
dem done <编号>
```

软件开着时，它通过一个只有你能访问的本机文件和软件说话。软件没开时，它问主密码，自己打开资料库。两者不能同时打开同一个库。

默认不输出私密和机密内容。加 `--all` 才有，机密内容也只有编号，没有标题。加 `--json` 输出 JSON，方便脚本处理。

写入直接生效，因为用的人是你。

## 链接

```
dem://capture?text=要记的话
dem://capture?text=标题&url=https://example.com
```

任何能打开链接的东西都能用，比如 macOS 的“快捷指令”，或者浏览器书签。内容进收集箱。这个链接只能往收集箱加东西，资料库锁着时什么也不做。

## 全局收集

在任何地方按 ⌥⌘N。写网址会抓网页的标题和文字，只抓公开网址，碰不到本机和局域网。
