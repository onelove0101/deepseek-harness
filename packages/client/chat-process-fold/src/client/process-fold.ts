/**
 * process-fold: folds one individual process step — a tool call plus its
 * result, or a settled reasoning segment — into its own small collapsible
 * Chat Node anchored at the step's own sequence. The final answer is never
 * folded: it is an assistant text block, which this Definition ignores, so the
 * result stays outside the box. The Definition folds only durable events
 * (`tool/call`, `tool/result`, settled `assistant/message`) — no transient
 * streams — so replay is deterministic and no window dependency remains.
 */

import type {
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'

/** Event stream member observed by this Definition. */
type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

/** Stable per-step fold identity (tool call id or reasoning event seq). */
export type ProcessFoldId = `tool:${string}` | `reason:${number}`

/** One folded process step. */
export type ProcessFoldKind = 'reasoning' | 'tool'

/** Chat render payload for one folded process step. */
export interface ProcessFoldChatData {
  readonly turn: number
  readonly kind: ProcessFoldKind
  readonly summary: string
  readonly error: boolean
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One collapsible, independently expandable process step. */
    'process-fold': ProcessFoldChatData
  }
}

/** Definition-internal folding state for one step. */
export interface ProcessFoldState {
  readonly turn: number
  readonly kind: ProcessFoldKind
  readonly summary: string
  readonly error: boolean
}

/** Maximum visible length of one folded step summary. */
export const SUMMARY_LIMIT = 160

/** Tool-call argument excerpt budget inside a summary. */
export const ARGS_LIMIT = 120

/** Append ellipsis when a value was truncated. */
function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** Extract the statement's concatenated non-empty reasoning text. */
function reasoningFrom(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const item of content) {
    const candidate = item as { readonly type?: unknown; readonly text?: unknown }
    if (candidate.type === 'reasoning' && typeof candidate.text === 'string' && candidate.text.trim() !== '') {
      parts.push(candidate.text)
    }
  }
  return parts.join('\n')
}

function eventTurn(event: ConversationEvent): number | undefined {
  const turn = (event.data as { readonly turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

/** Read the Tool-call identity and excerpt from its durable arguments JSON. */
function toolExcerpt(name: string, argsRaw: string): string {
  let args: unknown
  try {
    args = JSON.parse(argsRaw) as unknown
  } catch {
    return clip(`${name}(${argsRaw})`, SUMMARY_LIMIT)
  }
  const excerpt = typeof args === 'string' ? args : JSON.stringify(args)
  return clip(`${name}(${excerpt})`, SUMMARY_LIMIT)
}

/**
 * Clip a display summary to the shared budget.
 * @param value - summary text.
 * @returns the clipped single-line summary.
 */
export function clipSummary(value: string): string {
  return clip(value.replace(/\s+/g, ' '), SUMMARY_LIMIT)
}

/**
 * Fold one individual process step into a collapsible Chat Node.
 */
export const processFoldDefinition: ConversationNodeDefinition<ProcessFoldState> = {
  kind: 'process-fold',
  target: 'chat',
  match: (event) => {
    const turn = eventTurn(event)
    if (turn === undefined) return null
    if (event.type === 'tool/call') {
      const callId = (event.data as { readonly callId?: unknown }).callId
      const id = typeof callId === 'string' && callId !== '' ? callId : `${event.seq}`
      return { id: `tool:${id}`, role: 'start' }
    }
    if (event.type === 'tool/result') {
      const callId = (event.data as { readonly message?: { readonly source?: { readonly callId?: unknown } } })
        .message?.source?.callId
      const id = typeof callId === 'string' && callId !== '' ? callId : `${event.seq}`
      return { id: `tool:${id}`, role: 'update' }
    }
    if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
      // Reasoning blocks are process; the reply text is the result and is left out.
      const content = (event.data.message as unknown as { readonly content?: readonly unknown[] }).content
      if (content !== undefined && reasoningFrom(content) !== '') {
        return { id: `reason:${event.seq}`, role: 'start' }
      }
    }
    return null
  },
  start: (_context, match) => {
    const turn = eventTurn(match.event)
    if (turn === undefined) throw new Error('process-fold requires a numeric turn')
    if (match.event.type === 'tool/call') {
      const call = match.event.data as unknown as { readonly name?: unknown; readonly arguments?: unknown }
      const name = typeof call.name === 'string' ? call.name : 'tool'
      const args = typeof call.arguments === 'string' ? call.arguments : ''
      return { turn, kind: 'tool', summary: toolExcerpt(name, args), error: false }
    }
    if (match.event.type === 'assistant/message') {
      const content = (match.event.data.message as unknown as { readonly content?: readonly unknown[] }).content
      return { turn, kind: 'reasoning', summary: clipSummary(reasoningFrom(content ?? [])), error: false }
    }
    throw new Error('process-fold start requires tool/call or assistant/message')
  },
  update: (context, match) => {
    const state = context.state
    if (match.event.type !== 'tool/result') return state
    const message = (match.event.data as unknown as {
      readonly message?: { readonly content?: readonly { readonly isError?: unknown }[] }
    }).message
    const isError = message?.content?.[0]?.isError === true
    if (!isError || state.error) return state
    return { ...state, error: true, summary: `⚠ ${state.summary}` }
  },
  buildViewNode: _context => null,
}
