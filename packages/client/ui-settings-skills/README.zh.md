---
description: "dsh Web 客户端的 Skills 设置页：列出所有已加载的 skill 并提供启用开关，另有“添加技能”入口用于登记本地 skill 目录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-skills

[English](README.md) | 中文

## 概述

**技能**设置页展示 Host 已加载的全部 skill（技能），并允许用户逐个关闭或开启。被禁用的 skill 仍保留在列表中，但会从所有会话的模型 skill 目录、`skill` 工具和 `/` 菜单中消失。**添加技能**用于登记一个包含 `SKILL.md` 的本地目录，用户无需编辑配置文件就能引入 skill。启用状态和已添加的目录都保存在 Host 用户设置中，因此重启后依然有效，并对连接同一 Host 的所有客户端生效。

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

打开设置并选择**技能**。请在已提供设置外壳、设置 scope 服务以及 `@deepseek-ai/dsh-api-session-controller` 提供的 `skills` Remote 的 Web 组合中挂载 `@deepseek-ai/dsh-client-ui-settings-skills`；该页面自行注册导航项，无需配置。

### 阅读列表

每行显示 skill 名称、描述和发现来源（`user-dsh`、`project-dsh`、`custom`、`bundled` 等）。页面在打开时才读取清单而非启动时读取，因此从不打开设置的会话不会发出 skills 请求。列表覆盖不依赖工作区即可看到的 skill：用户目录、已添加目录、自定义目录和内置目录；不包含依赖工作区目录的项目 skill。

### 启用与禁用

每行的开关会把 skill 名称写入 `skills` 设置命名空间的 `disabled` 列表，作为一次带修订号保护的写入。行状态跟随实时设置值，所以开关无需等待再次读取清单即可翻转。当连接无法写入设置（处于内存模式的远程浏览器）时，所有开关和“添加技能”都会被禁用，页面也会给出说明。

### 添加技能

“添加技能”会打开路径输入框。输入包含 `SKILL.md` 的目录的绝对路径并确认。Host 会检查路径是否为绝对路径、`SKILL.md` 是否存在、文件能否解析为带名称和描述的 skill，以及该目录是否已被添加。被拒绝时，原因显示在工具栏下方，表单保持打开。成功后表单关闭，新 skill 以启用状态出现。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

该页面是一个带本地化的 `settings.section` 贡献，id 为 `skills`，排序在“智能体预设”之后、“已归档会话”之前。设置外壳负责导航项、模态框和已挂载的分区。

### 状态与数据来源

`SkillsController` 拥有一个快照 store，并合并两个来源：`skills.inventory` Remote 的结果（包含已禁用 skill，按需读取）和已绑定的 `skills` 设置 scope（`disabled` 列表和可写性）。每行的 `enabled` 标志在 scope 每次变化时重新计算，因此切换开关不依赖第二次 Remote 读取。`reload()` 在 `connection/reset` 之后重新读取清单，且仅在页面此前读取过时才执行。被更新读取取代的读取会被中止，其结果被丢弃。

### Host 端对应实现

`skills` Remote 命名空间位于 `@deepseek-ai/dsh-api-session-controller`（`SessionSkillCatalog`）。它注册 `skills` 设置命名空间（`disabled`、`dirs`）、由 `dirs` 驱动的 `user-added` 文件系统提供方，以及把 `disabled` 应用到所有消费方的注册表隐藏名称来源。客户端在本地拼写该命名空间名称，因为客户端包不得依赖 Host 包。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 加载器入口：页面仅在浏览器运行，插件主体为空 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器插件：locale 命名空间、控制器、分区注册 |
| [`src/client/controller.ts`](src/client/controller.ts) | 清单与设置的合并、开关写入、添加技能请求 |
| [`src/client/SkillsSection.tsx`](src/client/SkillsSection.tsx) | 页面组件：列表、开关、添加技能表单 |
| [`src/client/locales.ts`](src/client/locales.ts) | 所有可见及无障碍字符串的中英文词典 |
| [`src/client/SkillsSection.module.css`](src/client/SkillsSection.module.css) | 页面样式 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-settings](../ui-settings/README.zh.md) — 声明 `settings.section` 和命名空间 scope 服务的领域基础包。
- [ui-settings-general](../ui-settings-general/README.zh.md) — 渲染导航并挂载分区的设置外壳。
- [ui-skill](../ui-skill/README.zh.md) — 遵循禁用列表的 `/` 菜单与 skill 调用卡片。
- [Session Controller](../../api/session-controller/README.zh.md) — 本页背后的 `skills` Remote 方法。
- [Skills 子系统](../../../docs/subsystems/skills.zh.md) — 注册表、提供方和隐藏名称过滤。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该包是浏览器端 UI 插件层，不注册任何面向模型的内容。它写入的设置会改变模型目录所列出的 skill；该效果由 [dsh-tool-skill](../../skill/tool-skill/README.zh.md) 负责并记录。

#### KV Cache 影响

无；此包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了本页能够管理的内容；它们是当前包的约束。

- **不列出项目 skill** — 读取清单时不带工作区目录，所以位于项目 `.dsh/skills` 或 `.agents/skills` 下的 skill 不会出现在这里；不过此处被列为禁用的名称同样会隐藏同名的项目 skill。
- **页面无法移除已添加的目录** — “添加技能”会向 `skills` 设置命名空间的 `dirs` 列表追加条目；移除条目需要编辑设置文档。
- **添加需要 Host 机器上的路径** — 路径由 Host 读取，而不是从浏览器上传。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。这是一个浏览器端设置页，只注册一个带本地化的 `settings.section` 贡献及其 locale 命名空间；它不发出 Cordis 事件，也不拥有跨插件的可变关系。
