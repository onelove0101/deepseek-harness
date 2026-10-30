# @deepseek-ai/dsh-client-chat-process-fold

[English](README.md) | 中文

仅用于浏览器的插件，把每一个独立的执行步骤（一次工具调用及其结果，或一段已结束的推理片段）折叠成各自的小型可折叠 Chat 行，锚定在该步骤自己在流程中的位置。最终答案永远不会被折叠：此 Definition 从不折叠 assistant 的回复文本，因此结果仍然位于所有折叠框之外，与原生 chat 的渲染方式完全一致。

插件启用后，它还会发布一个 `chatProcessFold` 偏好设置，让原生 chat 目标在进行中（open）的 Turn 期间也折叠自己的过程行，避免页面接连不断地流式输出一张又一张工具卡片。

## Behavior

- 每个独立步骤对应一个 `process-fold` Chat Node，叠加在已有的 `turn-process` 展开区之上（不修改 `TurnProcessNodeView`，也不改变 chat 快照布局）。每个步骤由其工具调用 id（`tool:<callId>`）或推理事件 seq（`reason:<seq>`）标识。
- 每个步骤折叠为一个紧凑的框：标题栏（箭头 + 类型图标 + 标题），展开后显示该步骤的摘要。失败的工具结果以错误色高亮。每个步骤独立折叠和展开。
- 折叠摘要会被截断到 `SUMMARY_LIMIT` 个码点；完整内容从不复制到这里（原生行仍通过已有的展开区显示原始的工具／推理卡片）。
- 插件暴露一个 `chatProcessFold` 服务（`ctx.provide`），其 `live` store 反映已持久化的 `chat-process-fold.enabled` 开关。原生 chat 目标通过 `ctx.get` 读取它，因此开关打开时，原生过程行在进行中的 Turn 期间也会折叠；开关关闭（或本插件被移出组合）时，原生 turn-process 展开区的行为与之前完全相同。
- 通用设置（General Settings）中的开关 `chat-process-fold.enabled`（默认开启）用于安装或移除折叠界面。插件的 `Config.enabled`（默认 true）是总开关。

## Config

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 总开关；为 `false` 时无论设置如何，都不折叠任何内容，也不发布偏好设置。 |

持久化设置命名空间：`chat-process-fold.enabled`。

## Events

在 `ctx.uiConversation` 上注册 `process-fold` Conversation Node Definition，并在 chat 的 `conversation.chat.node` slot 上注册按 key 区分的渲染器。它只消费持久化事件（`tool/call`、`tool/result`、已结束的 `assistant/message`），从不使用瞬态流，因此折叠结果是确定且可重放的。这里写入的任何内容都不会进入模型请求。

## Extension points / composition

把本插件移出组合（删除其 web-app roster 行）会完全移除折叠界面，并保持 chat 原生 turn-process 展开区不变。

## Model Experience

无，因为本包只负责浏览器端展示。它不增加请求上下文，也不影响 KV Cache：折叠框由客户端上的持久化会话事件派生，从不改变模型可见的 prompt 或历史。
KV cache effect: does not invalidate — it adds no tokens and touches no request.

## Published invariants

无。折叠的正确性是对会话事件的确定性纯折叠，没有可能产生分歧的独立运行时观测，因此不发布 `./invariant`。

## Known Limitations and Deferred Work

- **Field-duplicate fold content** — 折叠框列出折叠后的摘要，而原生 `turn-process` 展开区仍显示原始行；在不修改 ui-chat 快照布局（本插件有意避免这样做）的前提下，两者尚未合并为单一的折叠区域。
- **Live folding needs the chat target** — 开关打开时，在进行中的 Turn 期间折叠原生过程行，依赖 ui-chat 遵循已发布的 `chatProcessFold` 偏好设置；版本过旧、无法读取它的 ui-chat 构建只有逐步骤的折叠框，原生行仍照常流式输出。
- **Live reasoning not streamed into the box** — 只折叠已结束的 `assistant/message` 推理；进行中的推理 delta 只在结束后才出现。
- **`chat-process-fold.enabled` toggle unregisters on change** — 该界面由策略发布来安装／卸载；已打开的会话在下一次发布时才生效，而不是立即生效。
