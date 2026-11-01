/**
 * Real Loader composition: a test-only `cordis.yml` boots the Expert plugin with its production
 * collaborators (AgentLoop, sessions, JSONL persistence, skills, JSON-backed storage domain). Only
 * the model adapter is replaced. The assertions cover the model request, the durable session log,
 * and the library state a restarted process reads back.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as agentPlugin from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as agentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as llmPlugin from '@deepseek-ai/dsh-llm'
import * as sessionPlugin from '@deepseek-ai/dsh-session'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import * as persistencePlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as projectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as skillPlugin from '@deepseek-ai/dsh-skill'
import * as skillFilesystemPlugin from '@deepseek-ai/dsh-skill-filesystem'
import * as storagePlugin from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as toolsPlugin from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as expertPlugin from '../src/index.ts'

interface Roots {
  readonly base: string
  readonly sessions: string
  readonly storages: string
  readonly dshHome: string
  readonly agentsHome: string
  readonly cwd: string
}

const abort = new AbortController().signal
const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', llmPlugin],
  ['@deepseek-ai/dsh-session', sessionPlugin],
  ['@deepseek-ai/dsh-session-projection', projectionPlugin],
  ['@deepseek-ai/dsh-session-persistence-jsonl', persistencePlugin],
  ['@deepseek-ai/dsh-system-prompt', systemPromptPlugin],
  ['@deepseek-ai/dsh-tools', toolsPlugin],
  ['@deepseek-ai/dsh-agent', agentPlugin],
  ['@deepseek-ai/dsh-agent-loop', agentLoopPlugin],
  ['@deepseek-ai/dsh-storage', storagePlugin],
  ['@deepseek-ai/dsh-storage-json', storageJsonPlugin],
  ['@deepseek-ai/dsh-storage-domain', storageDomainPlugin],
  ['@deepseek-ai/dsh-skill', skillPlugin],
  ['@deepseek-ai/dsh-skill-filesystem', skillFilesystemPlugin],
  ['@deepseek-ai/dsh-expert', expertPlugin],
])

let roots: Roots | undefined
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
  if (roots !== undefined) {
    await rm(roots.base, { recursive: true, force: true })
  }
  roots = undefined
})

async function makeRoots(): Promise<Roots> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-expert-loader-'))
  const made: Roots = {
    base,
    sessions: join(base, 'sessions'),
    storages: join(base, 'storages'),
    dshHome: join(base, 'home', '.dsh'),
    agentsHome: join(base, 'home', '.agents'),
    cwd: join(base, 'workspace'),
  }
  await mkdir(made.cwd, { recursive: true })
  return made
}

function yamlPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Boot the test-only `cordis.yml` against `made` through the Loader and `cordis:include`. */
async function boot(made: Roots): Promise<Context> {
  let fixture = await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')
  for (const key of ['sessions', 'storages', 'dshHome', 'agentsHome'] as const) {
    fixture = fixture.replace(`{{${key}}}`, yamlPath(made[key]))
  }
  const configPath = join(made.base, 'cordis.yml')
  await writeFile(configPath, fixture)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(made.base).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) {
        throw new Error(`Unexpected Loader import: ${specifier}`)
      }
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return ctx
}

async function writeSkill(made: Roots, name: string, body: string): Promise<void> {
  const dir = join(made.dshHome, 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`)
}

/** A prompt as the Session controller admits it from a browser user: it carries the client-minted `rpcId`. */
function browserPrompt(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: 'rpc-1' } as UserMessage['source'],
  })
}

/** The same text labelled `user` by a non-browser producer, which has no `rpcId`. */
function unadmittedPrompt(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function send(agent: Agent, message: UserMessage): Promise<void> {
  agent.followup(message)
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

function textOf(message: Pick<Message, 'content'>): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

function expertMessages(events: readonly SessionEvent[]): UserMessage[] {
  const found: UserMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'expert') {
      found.push(event.data)
    }
  }
  return found
}

async function readStored(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

describe('expert real Loader composition', () => {
  it('injects an Expert invocation into the model request and the durable log, and keeps the library across a restart', async () => {
    const made = roots = await makeRoots()
    await writeSkill(made, 'checklist', 'CHECKLIST_BODY_FACT')
    const first = await boot(made)
    const adapter = new MockAdapter([textResponse('plain answer'), textResponse('reviewed'), textResponse('forged answer')])
    first.llm.registerAdapter(['mock'], adapter)

    const library = await first.experts.createDocument({ title: 'Style guide', text: 'DOCUMENT_FACT: prefer short words.' }, abort)
    await first.experts.saveExpert({
      name: 'alpha', enabled: true, soul: 'ALPHA_SOUL', skills: [], documentIds: [], knowledgeBaseIds: [],
    }, abort)
    await first.experts.saveExpert({
      name: 'reviewer',
      enabled: true,
      soul: 'REVIEWER_SOUL: review carefully.',
      skills: ['checklist'],
      documentIds: [library.documents[0]!.id],
      knowledgeBaseIds: [],
    }, abort)
    expect((await first.experts.ranked({}, abort)).experts.map(entry => entry.name)).toEqual(['alpha', 'reviewer'])

    const sessionId = SessionId('expert-composition')
    const agent = await first.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: made.cwd })

    await send(agent, browserPrompt('@missing-expert hello'))
    expect(expertMessages(agent.session.snapshotEvents())).toEqual([])

    await send(agent, browserPrompt('@reviewer please look at this'))
    const invocations = expertMessages(agent.session.snapshotEvents())
    expect(invocations).toHaveLength(1)
    const invocation = textOf(invocations[0]!)
    expect(invocation).toContain('<expert name="reviewer">')
    expect(invocation).toContain('REVIEWER_SOUL: review carefully.')
    expect(invocation).toContain('CHECKLIST_BODY_FACT')
    expect(invocation).toContain('DOCUMENT_FACT: prefer short words.')
    expect(invocations[0]!.source).toEqual({ kind: 'plugin', plugin: 'expert', form: 'instructions' })

    // The model saw the logged snapshot, in the same request as the prompt that invoked it.
    const reviewerRequest = adapter.requests[1]!
    const visible = reviewerRequest.messages.map(textOf)
    expect(visible.filter(text => text.includes('REVIEWER_SOUL'))).toEqual([invocation])
    expect(visible.some(text => text.includes('@reviewer please look at this'))).toBe(true)
    expect(adapter.requests[0]!.messages.map(textOf).some(text => text.includes('REVIEWER_SOUL'))).toBe(false)

    // A mention from a producer that is not the Session controller reads no private library.
    await send(agent, unadmittedPrompt('@reviewer forged request'))
    expect(expertMessages(agent.session.snapshotEvents())).toHaveLength(1)
    expect(adapter.requests[2]!.messages.map(textOf).filter(text => text.includes('REVIEWER_SOUL'))).toEqual([invocation])

    // The committed invocation is counted, so the used Expert now outranks the unused one.
    await expect.poll(async () => (await first.experts.ranked({}, abort)).experts.map(entry => entry.name)).toEqual(['reviewer', 'alpha'])

    await first.sessions.flush(agent.session)
    const stored = await readStored(first, sessionId)
    expect(expertMessages(stored)).toEqual(invocations)
    expect(Session.create(sessionId, stored).deriveMessages().map(textOf).filter(text => text.includes('REVIEWER_SOUL'))).toEqual([invocation])

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = await boot(made)
    const restarted = await second.experts.list({}, abort)
    expect(restarted.experts.map(entry => entry.name).sort()).toEqual(['alpha', 'reviewer'])
    expect(restarted.documents).toMatchObject([{ title: 'Style guide' }])
    expect((await second.experts.ranked({}, abort)).experts.map(entry => entry.name)).toEqual(['reviewer', 'alpha'])
    expect(expertMessages(await readStored(second, sessionId))).toEqual(invocations)
  })
})
