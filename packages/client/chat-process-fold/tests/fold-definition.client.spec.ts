/**
 * process-fold Definition: tracks each tool call and reasoning segment
 * (match/start/update) to supply counts to the Turn-level process button.
 * buildViewNode returns null — process steps are exposed via Turn-level
 * disclosure, not per-step boxes.
 */
import { describe, expect, it } from 'vitest'
import type {
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  processFoldDefinition, clipSummary, SUMMARY_LIMIT,
  type ProcessFoldState,
} from '../src/client/process-fold.ts'

type Def = ConversationNodeDefinition<ProcessFoldState>
type Event = Parameters<Def['match']>[0]
type Match = NonNullable<ReturnType<Def['match']>>

function event(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): Event {
  return { type, seq, time: 1000 + seq, data, ...extra } as unknown as Event
}

function toolCall(seq: number, call: { id: string; name: string; arguments: string }): Event {
  return event(seq, 'tool/call', { turn: 1, callId: call.id, name: call.name, arguments: call.arguments })
}

function toolResult(seq: number, callId: string, isError: boolean): Event {
  return event(seq, 'tool/result', {
    turn: 1,
    message: { source: { callId }, content: [{ type: 'text', text: isError ? 'boom' : 'ok', isError }] },
  })
}

function reasoningMessage(seq: number, reasoning: string, reply = ''): Event {
  return event(seq, 'assistant/message', {
    turn: 1,
    message: {
      content: [
        ...(reasoning === '' ? [] : [{ type: 'reasoning', text: reasoning }]),
        ...(reply === '' ? [] : [{ type: 'text', text: reply }]),
      ],
    },
  }, { surfaceOp: 'append' })
}

function matchOf(definition: Def, candidate: Event): Match {
  const match = definition.match(candidate)
  if (match === null) throw new Error(`event ${JSON.stringify(candidate.type)} did not match`)
  return { ...match, event: candidate } as Match
}

function start(definition: Def, candidate: Event): ProcessFoldState {
  return definition.start({} as never, matchOf(definition, candidate) as never, undefined as never)
}

function update(definition: Def, state: ProcessFoldState, candidate: Event): ProcessFoldState {
  const context = { state } as unknown as ConversationNodeContext<ProcessFoldState> & { readonly state: ProcessFoldState }
  return definition.update(context, matchOf(definition, candidate) as never)
}

describe('processFoldDefinition.match', () => {
  it('starts one fold per tool call keyed by call id', () => {
    expect(processFoldDefinition.match(toolCall(2, { id: 'c', name: 'bash', arguments: '' })))
      .toMatchObject({ id: 'tool:c', role: 'start' })
    expect(processFoldDefinition.match(toolResult(3, 'c', false)))
      .toMatchObject({ id: 'tool:c', role: 'update' })
  })

  it('starts one fold per distinct reasoning segment', () => {
    expect(processFoldDefinition.match(reasoningMessage(4, 'think')))
      .toMatchObject({ id: 'reason:4', role: 'start' })
    expect(processFoldDefinition.match(reasoningMessage(5, 'think again')))
      .toMatchObject({ id: 'reason:5', role: 'start' })
  })

  it('ignores answer-only messages so the result stays outside the box', () => {
    expect(processFoldDefinition.match(reasoningMessage(4, '', 'final answer'))).toBeNull()
  })

  it('ignores events without a numeric turn', () => {
    const out = event(5, 'tool/call', { callId: 'c' })
    expect(processFoldDefinition.match(out)).toBeNull()
  })
})

describe('processFoldDefinition folding', () => {
  it('builds a tool row with truncated args', () => {
    const state = start(processFoldDefinition, toolCall(2, { id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }))
    expect(state).toMatchObject({ kind: 'tool', error: false })
    expect(state.summary).toContain('bash(')
  })

  it('highlights a failed tool result', () => {
    let state = start(processFoldDefinition, toolCall(2, { id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }))
    state = update(processFoldDefinition, state, toolResult(3, 'c1', true))
    expect(state).toMatchObject({ error: true })
    expect(state.summary.startsWith('⚠')).toBe(true)
  })

  it('keeps a successful result non-error', () => {
    let state = start(processFoldDefinition, toolCall(2, { id: 'c1', name: 'bash', arguments: '{}' }))
    state = update(processFoldDefinition, state, toolResult(3, 'c1', false))
    expect(state).toMatchObject({ error: false })
    expect(state.summary.startsWith('⚠')).toBe(false)
  })

  it('folds reasoning blocks but never the reply text', () => {
    const state = start(processFoldDefinition, reasoningMessage(2, 'step through', 'looking'))
    expect(state).toMatchObject({ kind: 'reasoning', error: false })
  })
})

describe('processFoldDefinition.buildViewNode', () => {
  it('returns null — process steps are revealed by the Turn-level button, not per-step boxes', () => {
    const context = (state: ProcessFoldState) => ({
      state,
      key: 'k',
      id: '1',
      kind: 'process-fold',
      matches: [],
      start: { event: { seq: 2 } as never, location: { kind: 'turn', turn: 1, status: 'open' } as never },
    }) as unknown as ConversationNodeContext<ProcessFoldState>
    const state = start(processFoldDefinition, toolCall(2, { id: 'c1', name: 'write', arguments: '{"file_path":"a"}' }))
    const node = processFoldDefinition.buildViewNode?.(context(state))
    expect(node).toBeNull()
  })
})

describe('clipSummary', () => {
  it('collapses whitespace and clips long values with an ellipsis', () => {
    expect(clipSummary('a\n b')).toBe('a b')
    expect(clipSummary('x'.repeat(SUMMARY_LIMIT + 50))).toHaveLength(SUMMARY_LIMIT + 1)
  })
})
