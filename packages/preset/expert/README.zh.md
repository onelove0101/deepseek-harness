---
description: "持久化的按用户 Expert（专家），带私有文本文档库和一次性 @name 调用，供配置或排查它们的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-expert

[English](README.md) | 中文

## 概述

`dsh-expert` 为 Host 用户保存具名 Expert（专家），并在单次提示中调用其中一个。Expert 包含提及名称（handle）、启用标志、Soul（长期指令）、所选 skill（技能）列表，以及从私有文本文档和知识库中做出的选择。以 `@name` 开头的提示会让该 Expert 的 Soul、skill 正文与文档库文本作为一条持久的用户消息进入该轮。文档库只保存文本：Host 从不接受文件路径或 URL，所有大小都受 Config 限制。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在提供 Web 客户端的 Host 上挂载这一行；它需要 `agents`、`skills` 与 `storageDomain` 服务。打开设置，选择 **Experts**，创建 Expert，然后在提示开头输入 `@name`（`@` 菜单会列出已启用的 Expert）。

### 配置

```yaml
- name: '@deepseek-ai/dsh-expert'
  config:
    maxExperts: 50
    maxSoulBytes: 16384
    maxSkillsPerExpert: 20
    maxDocuments: 200
    maxDocumentBytes: 262144
    maxKnowledgeBases: 50
    maxDocumentsPerKnowledgeBase: 100
    maxLibraryBytes: 4194304
    maxInvocationLibraryBytes: 65536
```

每个字段都必填，且必须是正的安全整数；`maxDocumentBytes` 不得超过 `maxLibraryBytes`。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-expert)是各字段的完整来源。

### Expert、文档与知识库

Expert 名称为 1 到 40 个小写字母、数字和连字符，以字母开头，且唯一。Soul 不得为空白。所选 skill 只在数量上校验：之后被移除、停用或不可由用户调用的 skill 会在调用时被跳过，并向模型列为不可用。文档由标题和 UTF-8 文本组成，除制表符和换行外不得含控制字符。知识库是具名、有序的文档分组。删除文档或知识库时，会把它从所有选择它的 Expert 和知识库中移除。

### 调用 Expert

只有 Host 从浏览器用户处接纳的提示才能调用 Expert：消息来源必须是带 `rpcId` 的 `user`，而只有 Session 控制器会设置 `rpcId`，因此模型或子 agent 写出并标为 `user` 的消息不能调用。即使附件块在前，第一个文本块也必须以 `@name` 开头、其后是空白或文本结尾时才生效。提及文本仍保留在提示中。已停用或未知的 handle 只是普通文本。同一步中若有多条消息提及 Expert，以第一个为准，因此一步只带一个 Expert。

### Remote 方法

`experts` Remote 命名空间提供 `list`、`saveExpert`、`deleteExpert`、`createDocument`、`deleteDocument`、`saveKnowledgeBase` 与 `deleteKnowledgeBase`。每次写入都会返回整个文档库及当前生效的限制。失败带有 `expert/invalid`、`expert/not-found`、`expert/name-taken` 或 `expert/limit-exceeded`。文档文本从不返回给客户端。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 存储

Expert、文档与知识库是 `experts` storage domain 的三张表，因此沿用所配置的后端（json 后端写入 `experts.json`）。写入经过一个串行队列，并在队列前后检查请求的 abort signal。不符合表 schema 的记录会使加载失败，而不是被修复。

### 调用

`agent/pre-step` 监听器先调用 `next()`，忽略被拒绝的步骤，读取开头的提及，并在 `maxInvocationLibraryBytes` 限制内解析 Expert、其 skill 与文档库文本；该限制约束整条渲染后消息的 UTF-8 字节数。skill 正文按顺序在放得下时加载，第一个放不下的及其后所有 skill 被列为不可用；文档库文档随后按整篇占用剩余字节，被舍弃的文档标题在放得下时列出。已存储的 Soul 若不再放得下，该步以 `RangeError` 失败。它向该步的决策追加一条 `user/message`，因此 Session 日志保存了确切的注入文本。消息来源是 `{ kind: 'expert-invocation', form: 'instructions' }`，是消息来源联合中由该插件自有的成员；该新增 kind 只增不改，旧 Session 无需迁移。文档库文本经过 XML 转义，并被标注为不可信的参考材料。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、Config、Remote 方法、存储队列、`agent/pre-step` 监听器 |
| [`src/invocation.ts`](src/invocation.ts) | 纯函数：提及识别、文档库预算与消息渲染 |
| [`src/spec.ts`](src/spec.ts) | storage-domain 表 schema |
| [`src/types.ts`](src/types.ts) | 传输类型与 Remote 错误码 |
| — | 未发布 runtime invariant 配套包；该服务不拥有可被独立观察而产生分歧的关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-expert](../../client/ui-expert/README.zh.md)——设置页与 `@` 菜单来源。
- [dsh-tool-skill](../../skill/tool-skill/README.zh.md)——本包所对应的 `/name` pre-step 注入。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-expert)——所有可接受的字段。

-----

<a id="model-experience"></a>
## 模型体验

### Expert 调用消息

#### 模型看到什么

当提示以已启用 Expert 的 `@name` 开头时，提示之前会多出一条用户消息。其第一个块是 `<expert name="...">`，含单轮指令和 `<expert_soul>` 中的 Soul；若所选 skill 无法加载，还有 `<expert_unavailable_skills>`。每个可用 skill 随后各占一个 `<skill_content>` 块。一个 `<expert_library>` 块携带经过转义的文档（`<expert_document title="...">`），按 `<expert_knowledge_base>` 分组，并以 `<expert_omitted_documents>` 列出预算放不下的文档。不带提及的提示不变。

#### Token 影响

只有提及 Expert 的那一轮付出成本：Soul、所选 skill 正文，以及文档文本，合计至多 `maxInvocationLibraryBytes` 个渲染字节。该消息此后仍留在 Session 历史中，因此该 Session 之后的请求会持续付出，直到压缩将其移除。

#### KV Cache 影响

消息追加在既有历史之后，因此更早的前缀 token 仍然缓存有效。由于文本在注入时就已写入日志，之后编辑或删除 Expert 不会改变重放的历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包目前支持什么；它们是当前的包约束。

- **仅识别开头的提及**——提示中其他位置的 `@name` 只是普通文本；一条提示至多带一个 Expert。
- **仅文本文档**——不支持上传二进制文件，不支持文件路径或 URL 导入，也没有检索或嵌入：所选文档按顺序整篇注入，直到调用预算用尽。
- **只有一种文本调用形式**——`@name` 是调用语法；`@` 菜单和加号菜单的 Expert flyout 只会插入相同的开头文本。
- **skill 在调用时校验，而非保存时**——被选中但已消失的 skill 会向模型报告为不可用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景——点击展开</summary>

无。

</details>
