---
description: "dsh Web 客户端的 Experts 设置页与开头 @ 提及来源：名单、编辑表单与私有文档库。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-expert

[English](README.md) | 中文

## 概述

**Experts** 设置页列出 Host 用户的 Expert（专家）并提供编辑：名称、启用开关、Soul、所选 skill（技能）、文档与知识库。名单下方的文档库面板保存粘贴的文本文档，并把它们分组为知识库。本包还注册开头的 `@` 菜单来源：在提示开头输入 `@` 会列出已启用的 Expert，选择后落入字面文本 `@name `。提示发送时由 Host 注入该 Expert。所有内容都通过 [`dsh-expert`](../../preset/expert/README.zh.md) 的 `experts` Remote 持久化在 Host 上。

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

在提供设置外壳、input-trigger 服务以及 `experts` 与 `skills` Remote 的 Web 组装中挂载 `@deepseek-ai/dsh-client-ui-expert`；页面会注册自己的导航入口，无需配置。

### 管理 Expert

打开设置并选择 **Experts**。**新建专家** 打开表单；**编辑** 为已有 Expert 重新打开表单。名称字段接受小写字母、数字和连字符。每行的开关可在不打开表单的情况下启用或停用 Expert。已停用的 Expert 仍在列表中，但不会出现在 `@` 菜单里。Host 的拒绝（例如名称已被占用或超出限制）显示在名单上方，并保持表单打开。

### 文档库

名单下方的 **添加文档** 保存标题和粘贴的文本；Host 只保存文本，不接受文件路径或 URL。每个文档行显示其大小，面板显示文档库用量与 Host 限制的对比。知识库由名称加勾选的文档组成。删除文档或知识库时，会把它从所有选择它的 Expert 中移除。

### `@` 菜单

该来源只在开头生效：`@` 标记位于提示开头时列出 Expert，在行内位置则不提供任何内容。候选项是 Host 按成功使用次数排序的已启用 Expert（`experts.ranked`，每次打开都重新读取），再按所输入查询过滤而不改变该使用排序，描述为 Soul 的第一行。

输入框的 `+` 菜单在“添加”分组中也有一个 **Expert** 行。悬停它，或对它按 Enter、Tab 或点击，会打开一个 flyout，列出 Host 按成功使用次数排序的已启用 Expert（`experts.ranked`，每次打开都重新读取）。选择后在草稿开头插入 `@name `，并替换开头已有的、在列表中的 Expert 提及，不会发送。输入 `/expert` 会插入 `@` 来打开 `@` 菜单。该行在被寻址的子代理会话中隐藏。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

该页面是一个本地化的 `settings.section` 贡献，id 为 `experts`，顺序为 23，位于 Skills 与已归档会话之间。

### 状态与数据来源

`ExpertsController` 拥有一个快照 store，保存最新的文档库和 skill 名称。页面打开时一并读取文档库和 skill 清单；清单读取失败只会让 skill 列表为空，不会使文档库读取失败。每次变更都返回整个文档库并替换 store 中的值。`reload()` 在 `connection/reset` 之后重新读取，且仅在之前读取过时才执行。被更新读取取代的读取会被中止并丢弃。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 加载入口：本包仅用于浏览器，插件主体为空 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器插件：locale 命名空间、控制器、section 注册、`@` 来源 |
| [`src/client/controller.ts`](src/client/controller.ts) | 文档库与清单读取、变更、已启用 Expert 查询 |
| [`src/client/ExpertsSection.tsx`](src/client/ExpertsSection.tsx) | 页面：名单、开关、编辑与删除操作 |
| [`src/client/ExpertForm.tsx`](src/client/ExpertForm.tsx) | 创建与编辑表单 |
| [`src/client/LibraryPanel.tsx`](src/client/LibraryPanel.tsx) | 文档与知识库 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文字典 |
| [`src/client/ExpertsSection.module.css`](src/client/ExpertsSection.module.css) | 页面样式 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-expert](../../preset/expert/README.zh.md)——Host 服务、存储、限制与调用消息。
- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.section` 的领域基础包。
- [ui-settings-skills](../ui-settings-skills/README.zh.md)——本包参照的相邻 Skills 页面。
- [ui-skill](../ui-skill/README.zh.md)——`@` 来源所参照的 `/` 菜单来源。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器端 UI 插件层，不注册任何面向模型的内容。选择候选项时插入的 `@name ` 文本是普通提示文本；Host 端的 Expert 注入由 [dsh-expert](../../preset/expert/README.zh.md) 负责并记录。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明页面能做什么；它们是当前的包约束。

- **Host 排序的菜单**——加号菜单的 Expert flyout 与 `@` 菜单每次打开都会读取 Host 的使用排序；在 `@` 后输入时按查询过滤而不改变该顺序。
- **文档是粘贴的文本**——页面没有文件选择器、路径或 URL 导入。
- **skill 选项来自清单**——依赖工作区目录的项目 skill 不会出现在选择器中。
- **设置数据可能过期**——其他客户端的文档库元数据在重连或本页重新加载后才会出现；选择菜单始终读取新的排序。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**Runtime invariant:** 未发布配套包。这是一个浏览器端设置页与 input-trigger 来源，注册一个本地化的 `settings.section` 贡献、一个 locale 命名空间和一个 `@` 来源；它们不发出 Cordis 事件，也不拥有跨插件的可变关系。
