---
description: "Per-step chat folding for the dsh web client: each tool call and finished reasoning step collapses into its own row, and the final answer stays visible."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-chat-process-fold

English | [中文](README.zh.md)

## Summary

Fold each tool call and each finished reasoning step into its own chat row, and leave the final answer visible. Open a row to read that step's summary; a failed tool result is shown as an error. The same switch folds the chat's own process rows while a turn is still running, so the page does not stream one tool card after another. Folding is on by default and can be turned off in General Settings. Removing the plugin from the Web composition restores the original process list.

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

Mount `@deepseek-ai/dsh-client-chat-process-fold` in a Web composition that already provides chat, conversation, settings, and locale. Folding starts on. Turn it off in General Settings with the switch, which persists as the volatile `enabled` field of the `ui-chat-process-fold` profile entry (the package's Host half declares it), or set the client plugin `enabled` field to `false` to fold nothing and publish no preference.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` folds nothing and publishes no preference, regardless of the settings toggle. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each tool call and each settled reasoning segment becomes one `process-fold` Chat Node at that step's place in the flow. A tool step is keyed `tool:<callId>` and a reasoning step is keyed `reason:<seq>`. The node shows a header and, when open, a summary clipped to `SUMMARY_LIMIT` code points. The native tool and reasoning cards stay in the existing turn-process disclosure.

The plugin provides `chatProcessFold`. Its live value follows the persisted toggle. While the toggle is on, the chat target also folds its own process rows during an open turn. While the toggle is off, or when this plugin is not composed, that disclosure behaves as it does without the plugin.

The definition reads only durable `tool/call`, `tool/result`, and settled `assistant/message` events. It does not read transient streams.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-chat](../ui-chat/README.md) — the chat target that honors the published fold preference.
- [ui-conversation](../ui-conversation/README.md) — the Conversation Node registry this plugin extends.
- [ui-settings-general](../ui-settings-general/README.md) — the General Settings page that hosts the fold switch.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side presentation of logged process steps and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are the current folding behavior.

- **The fold and the native process list both show the step** — the fold box lists a summary while the turn-process disclosure still shows the original row.
- **Open-turn folding depends on the chat target** — a chat build that does not read `chatProcessFold` keeps streaming native rows and only shows the per-step boxes.
- **In-flight reasoning stays outside the box** — only settled `assistant/message` reasoning is folded.
- **A toggle change applies on the next publication** — an already open session picks up the installed or removed fold when the setting is published again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Folding is a deterministic derivation of durable session events, and this package owns no independent runtime observation that could diverge.
