---
description: "Persistent per-user Experts with a private text-document library and one-shot @name invocation, for users and maintainers configuring or debugging them."
kind: "package-reference"
---

# @deepseek-ai/dsh-expert

English | [中文](README.zh.md)

## Summary

`dsh-expert` stores named Experts for the Host user and invokes one of them for a single prompt. An Expert has a mention handle, an enabled flag, a Soul (standing instructions), a list of selected skills, and selections from a private library of text documents and knowledge bases. A prompt that starts with `@name` makes the Expert's Soul, its skill bodies, and its library text part of that turn as one durable user message. The library holds text only: the Host never accepts a filesystem path or URL, and every size is bounded by Config.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row on the Host that serves the web client; it needs the `agents`, `skills`, and `storageDomain` services. Open Settings, select **Experts**, create an Expert, and type `@name` at the start of a prompt (the `@` menu offers enabled Experts).

### Configuration

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

Every field is required and must be a positive safe integer; `maxDocumentBytes` must not exceed `maxLibraryBytes`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-expert) is the exhaustive source for each field.

### Experts, documents, and knowledge bases

An Expert name is 1 to 40 characters of lowercase letters, digits, and hyphens, starting with a letter, and is unique. The Soul must not be blank. Selected skills are validated by count only: a skill that is later removed, disabled, or not user-invocable is skipped at invocation and listed to the model as unavailable. A document is a title plus UTF-8 text with no control characters other than tab and line breaks. A knowledge base is a named, ordered group of documents. Deleting a document or knowledge base removes it from every Expert and knowledge base that selects it.

### Invoking an Expert

Only a prompt the Host admitted from a browser user invokes an Expert: the message source must be `user` with an `rpcId`, which only the Session controller sets, so a model-written or subagent-written message labelled `user` does not. The first text block, even when attachment blocks precede it, must start with `@name` followed by whitespace or the end of the text. The mention text stays in the prompt. A disabled or unknown handle is ordinary text. If several messages in one step mention Experts, the first mention wins, so a step carries one Expert.

### Remote methods

The `experts` Remote namespace exposes `list`, `saveExpert`, `deleteExpert`, `createDocument`, `deleteDocument`, `saveKnowledgeBase`, and `deleteKnowledgeBase`. Each write returns the whole library plus the bounds in force. Failures carry `expert/invalid`, `expert/not-found`, `expert/name-taken`, or `expert/limit-exceeded`. Document text is never returned to the client.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Storage

Experts, documents, and knowledge bases are three tables of the `experts` storage domain, so they inherit the configured backend (the json backend writes `experts.json`). Writes run through one serialized queue that checks the request's abort signal before and inside the queue. A record that fails the table schema rejects the load instead of being repaired.

### Invocation

An `agent/pre-step` listener calls `next()` first, ignores rejected steps, reads the leading mention, and resolves the Expert, its skills, and its library text under `maxInvocationLibraryBytes`, which bounds the UTF-8 bytes of the whole rendered message. Skill bodies load in order while they fit; the first that does not fit and every later one are listed as unavailable. Library documents then take the remaining bytes whole, and titles of left-out documents are listed while they fit. A stored Soul that no longer fits fails the step with a `RangeError`. It appends one `user/message` to the step decision, so the Session log holds the exact injected text. The message source is `{ kind: 'expert-invocation', form: 'instructions' }`, a producer-owned member of the message-source union; the new kind is additive, so older Sessions need no migration. Library text is XML-escaped and framed as untrusted reference material.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, Config, Remote methods, storage queue, `agent/pre-step` listener |
| [`src/invocation.ts`](src/invocation.ts) | Pure mention recognition, library budgeting, and message rendering |
| [`src/spec.ts`](src/spec.ts) | Storage-domain table schemas |
| [`src/types.ts`](src/types.ts) | Wire types and Remote error codes |
| — | No runtime invariant companion is published; the service owns no relationship that independent observations can diverge on. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-expert](../../client/ui-expert/README.md) — the Settings page and the `@` menu source.
- [dsh-tool-skill](../../skill/tool-skill/README.md) — the `/name` pre-step injection this package mirrors.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-expert) — every accepted field.

-----

<a id="model-experience"></a>
## Model Experience

### The Expert invocation message

#### What the model sees

On a turn whose prompt starts with `@name` for an enabled Expert, one extra user message precedes the prompt. Its first block is `<expert name="...">` with a one-turn instruction and the Soul in `<expert_soul>`, plus `<expert_unavailable_skills>` when a selected skill cannot load. Each available skill follows as its own `<skill_content>` block. One `<expert_library>` block carries escaped documents as `<expert_document title="...">`, grouped under `<expert_knowledge_base>`, and `<expert_omitted_documents>` names documents the budget could not hold. Prompts without a mention are unchanged.

#### Token effect

Only the turn that mentions an Expert pays: the Soul, the selected skill bodies, and document text, together at most `maxInvocationLibraryBytes` rendered bytes. The message stays in the Session history afterward, so later requests of that Session keep paying until compaction removes it.

#### KV Cache effect

The message is appended after the existing history, so earlier prefix tokens stay cache-valid. Because the text is logged at injection, editing or deleting an Expert later does not change replayed history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package supports today; they are current package constraints.

- **Leading mention only** — an `@name` anywhere else in a prompt is ordinary text; one prompt carries at most one Expert.
- **Text documents only** — there is no upload of binary files, no filesystem path or URL import, and no retrieval or embedding: selected documents are injected whole, in order, until the invocation budget is spent.
- **One textual invocation form** — `@name` is the invocation syntax; the `@` menu and the plus menu's Expert flyout only insert that same leading text.
- **Skills are validated at invocation, not at save** — a selected skill that disappears is reported to the model as unavailable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
