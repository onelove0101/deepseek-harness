---
description: "侧边栏笔记入口和保存在浏览器中的便签墙。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-notes

[English](README.md) | 中文

## 概述

本包在 Web 侧边栏添加“笔记”入口及其打开的主栏面板，用户可在其中添加、查看、编辑和删除笔记与便签。笔记保存在浏览器的 `localStorage` 中，不涉及 Host 服务。

## 目录

- [使用本包](#use-this-package)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

随附的 Web 组合已挂载此插件，无需配置。它注册一个 `sidebar.panellist` 入口和一个键为 `notes` 的 `main` 面板。打开入口会显示默认的便签墙。条目在同一浏览器配置文件中跨刷新保留。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-sidebar](../ui-sidebar/README.zh.md)——声明入口占用的 `sidebar.panellist` 插槽。
- [ui-layout](../ui-layout/README.zh.md)——声明面板占用的带键 `main` 插槽。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只提供浏览器端展示，不会进入任何模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延后事项

<a id="known-limitations-and-deferred-work"></a>

以下是本包当前的约束，而非任务待办。

- **浏览器本地存储**——笔记不会跨浏览器或设备共享，清除站点数据会删除它们。
- **不接入模型**——笔记从不进入 Session 或模型请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
