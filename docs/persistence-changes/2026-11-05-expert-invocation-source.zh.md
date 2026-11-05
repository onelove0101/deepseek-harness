---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-expert-invocation-source

[English](2026-11-05-expert-invocation-source.md) | 中文

## 概述

在持久化的 user/message、developer/message、agent/inbox/spliced 与 session/title-llm-request 的来源联合中，新增由 expert 包声明的 expert-invocation 消息来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-expert-invocation-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "2e35ba1803d292d6623b68c24856a92836ec2bd6c9eed80bbd7327925c982832"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "20bcb7eadc2cf43e3bfba22bcd28b45c04935d90e66f9de4e82a97aceadff80b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "f8963a659de2371aca24e92bd0d4ed126e1bb10cf75b611654cbb2322eb2c6fb"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "ded3d624d77b8da507ac12f98201db2d41088c86a70613a3df0478fa6cdc53d8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

MessageSourceMap 可合并扩展：各生产者声明自己的 kind，消费者对未知 kind 走兜底分支。现有日志不含 expert-invocation 条目，仍然有效。使用新 kind 写入的日志被未安装 expert 包的构建读取时会进入兜底分支，该消息仍按普通用户消息回放。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/preset/expert packages/core/session：expert 与 session 套件通过，包括 expert-invocation 注入与 loader 组合测试。

<a id="dev-note"></a>
## 开发备注

无。
