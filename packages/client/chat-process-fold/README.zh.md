---
description: "dsh Web 客户端的逐步对话折叠：把每次工具调用和已结束的推理步骤收成各自的一行，最终回答保持可见。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-chat-process-fold

[English](README.md) | 中文

## 概述

把每次工具调用和每段已结束的推理折叠成各自的对话行，并让最终回答保持可见。展开一行即可阅读该步骤的摘要；失败的工具结果会显示为错误。同一个开关还会在回合仍在进行时折叠对话自己的过程行，因此页面不会接连流出一张又一张工具卡片。折叠默认开启，可以在通用设置里关闭。从 Web 组合中移除本插件后，过程列表恢复为原来的样子。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在已经提供 chat、conversation、settings 和 locale 的 Web 组合中挂载 `@deepseek-ai/dsh-client-chat-process-fold`。折叠默认开启。可在通用设置中用该开关关闭它（它持久化为 `ui-chat-process-fold` 配置条目的 volatile 字段 `enabled`，由本包的 Host 半部声明），或把客户端插件的 `enabled` 字段设为 `false`，此时不折叠任何内容，也不发布偏好。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时无论设置开关如何，都不折叠任何内容，也不发布偏好。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

每次工具调用和每段已结束的推理都会在流程中该步骤的位置变成一个 `process-fold` Chat Node。工具步骤的键是 `tool:<callId>`，推理步骤的键是 `reason:<seq>`。该节点显示标题栏，展开后显示截断到 `SUMMARY_LIMIT` 个码点的摘要。原生的工具卡片和推理卡片仍留在已有的 turn-process 展开区中。

插件提供 `chatProcessFold`。它的实时值跟随已持久化的开关。开关打开时，对话目标在进行中的回合里也会折叠自己的过程行。开关关闭，或本插件未加入组合时，该展开区与没有本插件时相同。

该定义只读取持久化的 `tool/call`、`tool/result` 和已结束的 `assistant/message` 事件。它不读取瞬态流。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-chat](../ui-chat/README.zh.md) — 遵循已发布折叠偏好的对话目标。
- [ui-conversation](../ui-conversation/README.zh.md) — 本插件所扩展的 Conversation Node 注册表。
- [ui-settings-general](../ui-settings-general/README.zh.md) — 承载折叠开关的通用设置页。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只在浏览器端展示已记录的过程步骤，不注册任何面向模型的内容。

#### KV Cache effect

无；本包既不组装也不发送提供者请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是当前的折叠行为。

- **折叠框和原生过程列表都会显示该步骤** — 折叠框列出摘要，而 turn-process 展开区仍显示原始行。
- **进行中回合的折叠依赖对话目标** — 不读取 `chatProcessFold` 的对话构建会继续流式输出原生行，只额外显示逐步折叠框。
- **进行中的推理留在折叠框之外** — 只折叠已结束的 `assistant/message` 推理。
- **开关变化在下一次发布时生效** — 已经打开的会话要等设置再次发布后，才会装上或卸下折叠。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。折叠是对持久化会话事件的确定性派生，本包不拥有可能发生分歧的独立运行时观测。
