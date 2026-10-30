# @deepseek-ai/dsh-client-chat-process-fold

English | [中文](README.zh.md)

Browser-only plugin that folds each individual execution step — a tool call plus
its result, or a settled reasoning segment — into its own small collapsible Chat
row, anchored at that step's own position in the flow. The final answer is never
folded: this Definition never folds assistant reply text, so the result stays
outside every box exactly as the native chat renders it.

When the plugin is enabled, it also publishes a `chatProcessFold` preference so
the native chat target folds its own process rows during open (in-flight) Turns
too, keeping the page from streaming one tool card after another.

## Behavior

- A `process-fold` Chat Node **per individual step**, layered on top of the
  existing `turn-process` disclosure (no change to `TurnProcessNodeView` or the
  chat snapshot layout). Each step is identified by its tool call id
  (`tool:<callId>`) or reasoning event seq (`reason:<seq>`).
- Each step folds into one compact box: a header (arrow + kind glyph + title)
  and, when expanded, that step's summary. Failed tool results are highlighted
  in the error color. Every step folds and expands independently.
- Folded summaries are truncated to `SUMMARY_LIMIT` code points; full content is
  never copied here (the native rows keep showing the original tool/reasoning
  cards through the existing disclosure).
- The plugin exposes a `chatProcessFold` service (`ctx.provide`) whose `live`
  store reflects the persisted `chat-process-fold.enabled` toggle. The native
  chat target reads it via `ctx.get`, so when the toggle is on, native process
  rows fold during open Turns too; when it is off (or this plugin is composed
  out), the native turn-process disclosure behaves exactly as before.
- A General Settings toggle `chat-process-fold.enabled` (default on) installs or
  removes the fold surface. Plugin `Config.enabled` (default true) is the master
  switch.

## Config

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Master switch; `false` folds nothing and publishes no preference regardless of settings. |

Durable settings namespace: `chat-process-fold.enabled`.

## Events

Registers the `process-fold` Conversation Node Definition on `ctx.uiConversation`
and a keyed renderer on the chat `conversation.chat.node` slot. It consumes only
durable events (`tool/call`, `tool/result`, settled `assistant/message`) and
never transient streams, so folding is deterministic and replayable. Nothing
written here reaches a model request.

## Extension points / composition

Composing this plugin out (removing its web-app roster row) removes the fold
surface entirely and leaves the chat's native turn-process disclosure unchanged.

## Model Experience

None, as this package is browser-only presentation. It adds no request context
and has no KV-cache effect: the fold box derives from durable session events on
the client and never changes the model-visible prompt or history.
KV cache effect: does not invalidate — it adds no tokens and touches no request.

## Published invariants

None. Folding correctness is a deterministic pure fold over session events with
no independent runtime observation that could diverge, so no `./invariant` is
published.

## Known Limitations and Deferred Work

- **Field-duplicate fold content** — the fold box lists folded summaries while
  the native `turn-process` disclosure still shows the original rows; the two are
  not yet reconciled into a single collapsed region without modifying ui-chat's
  snapshot layout, which this plugin deliberately avoids.
- **Live folding needs the chat target** — when the toggle is on, folding native
  process rows during open Turns depends on ui-chat honoring the published
  `chatProcessFold` preference; a ui-chat build too old to read it only has the
  per-step boxes, with native rows streaming as before.
- **Live reasoning not streamed into the box** — only settled `assistant/message`
  reasoning is folded; in-flight reasoning deltas appear only after settlement.
- **`chat-process-fold.enabled` toggle unregisters on change** — the surface is
  installed/uninstalled by policy publication; existing open sessions pick it up
  on the next publication rather than instantaneously.
