# Dify 有什么值得借鉴

2026-11-03 读了 Dify 的 README 和官方文档（知识库、工作流节点、插件、日志）。Dify 是搭 AI 应用的服务端平台，给团队用，Jady 是本地的个人内容系统，两者定位不同。下面只挑对 Jady 有用的。

## 值得借鉴的

按我建议的优先级排：

1. **检索测试页**（2026-11-03 做了：AI 视图里的“AI 能搜到什么”）。Dify 的知识库有一页“检索测试”：输入一句话，看能检索到哪几段、各自多少分。Jady 可以做一个“AI 能搜到什么”：选会话类型（普通、授权、联网授权），输入问题，看 `search` 工具会返回哪些条目。这样既能调搜索效果，也能亲眼确认私密内容确实搜不到。
2. **定期任务里的“问我”**（2026-11-03 做了：没人回答的提交记在定期任务面板的“等你回答”里，你点“现在运行”就带着你重跑一遍，每个提交当场问你。不重放旧请求，因为离开了原来的页面就不可靠）。Dify 的 Human Input 节点会暂停流程，发一个带按钮的表单，有人回答后按所选按钮走不同分支，超时也有自己的分支。Jady 现在的定期任务没人在场时，浏览器里的提交两分钟后就作废了。可以改成先存进一个“等你回答”的列表，你回来后一条条点，点了才执行。这和提议队列是一个思路。
3. **外部插件的权限清单**（2026-11-03 照这个思路做了，见 `docs/spikes/plugin-sandbox.md`）。Dify 的插件在 `manifest.yaml` 里声明要哪些权限（调用模型、注册工具、存储多大等），上架前还要写隐私说明。Jady 决定外部插件怎么加载时（`docs/extensibility-review.md`），可以照这个思路：插件先声明要什么，安装时给你看，没声明的就不给。Dify 的文档里没写插件运行时怎么隔离，所以隔离这块还要按我们自己的沙盒方案来。
4. **搜索按字段过滤**。Dify 检索时可以按元数据过滤：字符串的等于、包含，数字比大小，日期在前或在后，再用“且”“或”组合。Jady 的 `search` 工具可以加上按类型、标签、日期过滤，AI 找东西会更准。
5. **长文分两层检索**。Dify 的“父子分段”用小段去匹配，返回它所在的大段。以后 Jady 做向量检索时可以用：按段落匹配，返回整个小节给 AI。
6. **每次 AI 会话的明细**。Dify 的日志能看到每一轮的 token、耗时、原始提示词和每一步的调用。Jady 可以在 AI 会话记录里加上调用了哪些工具、读了哪几条，方便你核对 AI 到底看了什么。

7. **可视化的工作流编辑器**（2026-11-03 你说想要，我原先列在“不借鉴”里）。在 Jady 里可以把定期任务升级：简单的仍然是一句话加频率，复杂的展开成节点图，节点分触发、找内容、AI 处理、判断、问我、输出几类，走登记机制，插件能加新节点。安全规则不变：只拿受限视图，修改进提议队列，碰不到设置。存工作流要新增条目类型，算格式改动。具体用来做什么还没想好，试用之后再定。

## 不借鉴的

- **多租户、对外 API、云端部署**。和本地优先的定位相反。
- **固定答案（Annotation）**。Dify 用它让客服类应用对常见问题给固定回复。Jady 的工作约定（D8）已经覆盖了“告诉 AI 怎么做”的需要。

## 注意

Dify 的许可证是在 Apache 2.0 上加了条件的自定义许可（多租户和前端标志有限制），界面设计还声明了外观专利。所以只借鉴思路，不抄代码，也不照搬界面。

## 来源

- https://github.com/langgenius/dify 和其中的 LICENSE
- https://docs.dify.ai/en/cloud/use-dify/knowledge/test-retrieval.md
- https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/chunking-and-cleaning-text.md
- https://docs.dify.ai/en/cloud/use-dify/knowledge/metadata.md
- https://docs.dify.ai/en/cloud/use-dify/nodes/human-input.md
- https://docs.dify.ai/en/develop-plugin/features-and-specs/plugin-types/plugin-info-by-manifest.md
- https://docs.dify.ai/en/cloud/use-dify/monitor/logs.md
