---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-expert-invocation-source

English | [中文](2026-11-05-expert-invocation-source.zh.md)

## Summary

Adds the expert-invocation message source, declared by the expert package, to the persisted user/message, developer/message, agent/inbox/spliced and session/title-llm-request source unions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

MessageSourceMap is merge-extensible: each producer declares its own kind and consumers fall through unknown kinds. Existing logs contain no expert-invocation entries and remain valid. A log written with the new kind and read by a build without the expert package reaches the fall-through branch, so the message is still replayed as an ordinary user message.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/preset/expert packages/core/session: expert and session suites pass, including the expert-invocation injection and loader-composition tests.

<a id="dev-note"></a>
## Dev Note

None.
