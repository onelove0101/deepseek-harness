/** Keyless assembled-Web evidence for browser-authenticated Expert invocation. */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ExpertLibraryValue } from '@deepseek-ai/dsh-expert/types'
import {
  assertFixtureInventory,
  launchWebScaffold,
  recordFixture,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/expert-invocation', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const EXPERT_SOUL_FACT = 'EXPERT_SOUL_FACT'
const EXPERT_LIBRARY_FACT = 'EXPERT_LIBRARY_FACT'
const EXPERT_PROMPT = '@reviewer give a concise review.'
const EXPERT_REPLY = 'EXPERT_REPLY'
const PROVIDER = 'expert-invocation-snapshot'
const MODEL = 'same-route'
const REQUEST_ID = 'expert-invocation-prompt'

type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/** POST one generated Remote unary through the authenticated Web carrier. */
async function remote<T>(
  target: WebScaffold,
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const response = await target.hostFetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `expert-invocation-${endpoint}-${randomUUID()}`,
      method: endpoint,
      payload: { args },
    }),
  })
  if (!response.ok) {
    throw new Error(`${endpoint} failed over HTTP ${response.status}: ${await response.text()}`)
  }
  const result = (await response.json() as { result: RpcResult<T> }).result
  if (!result.ok) {
    throw new Error(`${endpoint} failed: ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}

/** Emit one complete assistant text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Deterministic model seam that preserves each assembled Expert request. */
class ExpertAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * textResponse(EXPERT_REPLY)
  }
}

/** Concatenate textual model content without making assumptions about message roles. */
function requestText(options: GenerateOptions): string {
  return options.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Extract all durable text from a Session event message. */
function eventText(event: Extract<SessionEvent, { type: 'user/message' | 'assistant/message' }>): string {
  const message = event.type === 'user/message' ? event.data : event.data.message
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('Expert invocation through the shipped Web Remote', () => {
  let scaffold: WebScaffold
  let adapter: ExpertAdapter | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold(
      MODE === 'record'
        ? {}
        : {
          replayFixture: FIXTURE,
          replayProviders: [{ id: PROVIDER, name: PROVIDER, models: [{ id: MODEL, name: MODEL }] }],
          compareReplaySession: true,
          paceMs: 15,
        },
    )
    if (MODE === 'record') {
      adapter = new ExpertAdapter()
      scaffold.ctx.effect(
        () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter!),
        'Expert invocation snapshot adapter',
      )
    }
  })

  afterAll(async () => {
    await scaffold?.close()
  })

  it('injects private Expert material only for the browser-authored leading mention', async () => {
    const library = await remote<ExpertLibraryValue>(scaffold, 'experts/createDocument', {
      request: { title: 'Snapshot reference', text: EXPERT_LIBRARY_FACT },
    })
    const documentId = library.documents[0]?.id
    if (documentId === undefined) {
      throw new Error('Remote did not return the created Expert document')
    }
    await remote<ExpertLibraryValue>(scaffold, 'experts/saveExpert', {
      request: {
        name: 'reviewer',
        enabled: true,
        soul: EXPERT_SOUL_FACT,
        skills: [],
        documentIds: [documentId],
        knowledgeBaseIds: [],
      },
    })

    const created = await remote<{ sessionId: string }>(scaffold, 'session/create', {
      request: { cwd: scaffold.workspaceCwd },
    })
    const sessionId = SessionId(created.sessionId)
    await remote(scaffold, 'session/selectModel', {
      request: { sessionId, provider: PROVIDER, model: MODEL },
    })

    const settled = scaffold.whenTurnSettled()
    await remote<{ accepted: true }>(scaffold, 'session/prompt', {
      request: {
        requestId: REQUEST_ID,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: EXPERT_PROMPT }],
      },
    })
    expect(await settled).toBe(sessionId)

    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) {
      throw new Error('Expert Session is not available after the settled turn')
    }
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const prompt = events.find((event): event is Extract<SessionEvent, { type: 'user/message' }> => (
      event.type === 'user/message'
        && event.data.source.kind === 'user'
        && 'rpcId' in event.data.source
        && event.data.source.rpcId === REQUEST_ID
    ))
    expect(prompt).toBeDefined()
    if (prompt === undefined || !('rpcId' in prompt.data.source)) {
      throw new Error('browser-authored Expert prompt was not recorded')
    }
    expect(prompt.data.source.kind).toBe('user')
    expect(prompt.data.source.rpcId).toBe(REQUEST_ID)

    const injections = events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => (
      event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === 'expert'
        && event.data.source.form === 'instructions'
    ))
    expect(injections).toHaveLength(1)
    expect(injections[0]?.data.source).toEqual({
      kind: 'plugin',
      plugin: 'expert',
      form: 'instructions',
    })
    const invocationText = eventText(injections[0]!)
    expect(invocationText).toContain('<expert name="reviewer">')
    expect(invocationText).toContain(EXPERT_SOUL_FACT)
    expect(invocationText).toContain(EXPERT_LIBRARY_FACT)

    const assistant = events.find((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => (
      event.type === 'assistant/message' && eventText(event).includes(EXPERT_REPLY)
    ))
    expect(assistant).toBeDefined()

    if (MODE === 'record') {
      if (adapter === undefined) {
        throw new Error('Expert adapter was not registered')
      }
      expect(adapter.requests).toHaveLength(1)
      expect(requestText(adapter.requests[0]!)).toContain(invocationText)
      await recordFixture(scaffold, sessionId, FIXTURE)
    }
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl'])
  }, 210_000)
})
