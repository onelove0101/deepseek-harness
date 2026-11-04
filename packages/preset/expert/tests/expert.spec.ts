/**
 * Experts library behavior: bounded CRUD over the `experts` storage domain on
 * the real json backend, restart durability, serialized writes, disposal, and
 * the `@name` pre-step injection with its replayable snapshot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import ExpertService, { renderedBytes } from '../src/index.ts'
import type { Config, ExpertLibraryValue, ExpertSaveRequest } from '../src/index.ts'

const limits: Config = {
  maxExperts: 3,
  maxSoulBytes: 64,
  maxSkillsPerExpert: 2,
  maxDocuments: 3,
  maxDocumentBytes: 40,
  maxKnowledgeBases: 2,
  maxDocumentsPerKnowledgeBase: 2,
  maxLibraryBytes: 90,
  maxInvocationLibraryBytes: 2000,
}

const signal = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

interface Harness {
  readonly ctx: Context
  readonly service: ExpertService
  readonly root: string
  readonly home: string
}

async function writeSkill(home: string, name: string, body: string, extra = ''): Promise<void> {
  const dir = join(home, '.dsh', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n\n${body}\n`)
}

async function harness(options: { root?: string; home?: string; config?: Partial<Config> } = {}): Promise<Harness> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-expert-'))
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'dsh-expert-home-'))
  if (options.root === undefined) {
    roots.push(root)
  }
  if (options.home === undefined) {
    roots.push(home)
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(ExpertService, { ...limits, ...options.config })
  return { ctx, service: ctx.experts, root, home }
}

function expert(overrides: Partial<ExpertSaveRequest> = {}): ExpertSaveRequest {
  return {
    name: 'reviewer',
    enabled: true,
    soul: 'Review carefully.',
    skills: [],
    documentIds: [],
    knowledgeBaseIds: [],
    ...overrides,
  }
}

async function rejection(promise: Promise<unknown>): Promise<RemoteError> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(RemoteError)
  return error as RemoteError
}

function onlyExpert(library: ExpertLibraryValue): ExpertLibraryValue['experts'][number] {
  expect(library.experts).toHaveLength(1)
  return library.experts[0]!
}

describe('Expert library storage', () => {
  it('creates, lists, edits, and deletes an Expert', async () => {
    const { service } = await harness()
    expect((await service.list({}, signal)).experts).toEqual([])
    const created = onlyExpert(await service.saveExpert(expert(), signal))
    expect(created).toMatchObject({ name: 'reviewer', enabled: true, soul: 'Review carefully.', skills: [] })
    expect(created.createdAt).toBe(created.updatedAt)

    const edited = onlyExpert(await service.saveExpert(expert({ id: created.id, enabled: false, soul: 'Be terse.' }), signal))
    expect(edited).toMatchObject({ id: created.id, enabled: false, soul: 'Be terse.', createdAt: created.createdAt })
    expect(edited.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

    const after = await service.deleteExpert({ id: created.id }, signal)
    expect(after.experts).toEqual([])
    const missing = await rejection(service.deleteExpert({ id: created.id }, signal))
    expect(missing.code).toBe('expert/not-found')
  })

  it('reports the configured limits with every list', async () => {
    const { service } = await harness()
    expect((await service.list({}, signal)).limits).toEqual(limits)
  })

  it('rejects invalid names, blank souls, and malformed text with expert/invalid', async () => {
    const { service } = await harness()
    const cases: ExpertSaveRequest[] = [
      expert({ name: '' }),
      expert({ name: 'Reviewer' }),
      expert({ name: '1abc' }),
      expert({ name: 'a_b' }),
      expert({ name: 'a'.repeat(41) }),
      expert({ soul: '   \n' }),
      expert({ soul: 'bad\u0000soul' }),
      expert({ soul: 'lone\uD800surrogate' }),
      expert({ skills: ['Not A Skill'] }),
      expert({ skills: ['one', 'one'] }),
      expert({ documentIds: ['d', 'd'] as never }),
    ]
    for (const request of cases) {
      const error = await rejection(service.saveExpert(request, signal))
      expect(error.code, JSON.stringify(request)).toBe('expert/invalid')
    }
    expect((await service.list({}, signal)).experts).toEqual([])
  })

  it('accepts a name of exactly 40 characters and a Soul of exactly maxSoulBytes', async () => {
    const { service } = await harness()
    const name = `a${'b'.repeat(39)}`
    const library = await service.saveExpert(expert({ name, soul: 'x'.repeat(limits.maxSoulBytes) }), signal)
    expect(onlyExpert(library).name).toBe(name)
  })

  it('counts Soul size in UTF-8 bytes rather than characters', async () => {
    const { service } = await harness()
    const fits = '你'.repeat(Math.floor(limits.maxSoulBytes / 3))
    await service.saveExpert(expert({ soul: fits }), signal)
    const over = `${fits}你`
    const error = await rejection(service.saveExpert(expert({ name: 'other', soul: over }), signal))
    expect(error).toMatchObject({ code: 'expert/limit-exceeded', details: { limit: 'maxSoulBytes', max: limits.maxSoulBytes } })
  })

  it('rejects a duplicate name but allows an Expert to keep its own name', async () => {
    const { service } = await harness()
    const first = onlyExpert(await service.saveExpert(expert(), signal))
    const taken = await rejection(service.saveExpert(expert({ soul: 'Other.' }), signal))
    expect(taken).toMatchObject({ code: 'expert/name-taken', details: { name: 'reviewer' } })
    await service.saveExpert(expert({ id: first.id, soul: 'Updated.' }), signal)
  })

  it('rejects editing an unknown Expert and referencing unknown library entries', async () => {
    const { service } = await harness()
    const unknown = await rejection(service.saveExpert(expert({ id: 'missing' as never }), signal))
    expect(unknown).toMatchObject({ code: 'expert/not-found', details: { kind: 'expert', id: 'missing' } })
    const document = await rejection(service.saveExpert(expert({ documentIds: ['nope' as never] }), signal))
    expect(document).toMatchObject({ code: 'expert/not-found', details: { kind: 'document' } })
    const base = await rejection(service.saveExpert(expert({ knowledgeBaseIds: ['nope' as never] }), signal))
    expect(base).toMatchObject({ code: 'expert/not-found', details: { kind: 'knowledge-base' } })
  })

  it('enforces maxExperts and maxSkillsPerExpert', async () => {
    const { service } = await harness()
    for (const name of ['one', 'two', 'three']) {
      await service.saveExpert(expert({ name }), signal)
    }
    const overCount = await rejection(service.saveExpert(expert({ name: 'four' }), signal))
    expect(overCount).toMatchObject({ code: 'expert/limit-exceeded', details: { limit: 'maxExperts', max: 3 } })
    const library = await service.list({}, signal)
    const overSkills = await rejection(service.saveExpert(
      expert({ id: library.experts[0]!.id, name: 'one', skills: ['a', 'b', 'c'] }),
      signal,
    ))
    expect(overSkills).toMatchObject({ code: 'expert/limit-exceeded', details: { limit: 'maxSkillsPerExpert' } })
  })

  it('serializes concurrent writes so limits hold under a race', async () => {
    const { service } = await harness()
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd', 'e'].map(name => service.saveExpert(expert({ name }), signal)),
    )
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
    expect((await service.list({}, signal)).experts).toHaveLength(3)
  })

  it('persists across a restart on the same storage root', async () => {
    const first = await harness()
    const created = onlyExpert(await first.service.saveExpert(expert(), signal))
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = await harness({ root: first.root, home: first.home })
    expect(onlyExpert(await second.service.list({}, signal))).toEqual(created)
  })

  it('rejects an aborted request before touching storage', async () => {
    const { service } = await harness()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(service.saveExpert(expert(), controller.signal)).rejects.toThrow('cancelled')
    await expect(service.list({}, controller.signal)).rejects.toThrow('cancelled')
    expect((await service.list({}, signal)).experts).toEqual([])
  })

  it('drops a queued write whose caller aborted while it waited', async () => {
    const { service } = await harness()
    const controller = new AbortController()
    const running = service.saveExpert(expert({ name: 'first' }), signal)
    const queued = service.saveExpert(expert({ name: 'second' }), controller.signal)
    controller.abort(new Error('gave up'))
    await running
    await expect(queued).rejects.toThrow('gave up')
    expect((await service.list({}, signal)).experts.map(entry => entry.name)).toEqual(['first'])
  })

  it('rejects writes after disposal begins', async () => {
    const { ctx, service } = await harness()
    const disposing = ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    await disposing
    await expect(service.saveExpert(expert(), signal)).rejects.toThrow('service is disposing')
  })

  it('rejects Config values the library cannot honor', async () => {
    await expect(harness({ config: { maxExperts: 0 } })).rejects.toThrow(/maxExperts/)
    expect(() => new ExpertService(new Context(), { ...limits, maxSoulBytes: 0 })).toThrow(/maxSoulBytes must be a positive safe integer/)
    expect(() => new ExpertService(new Context(), { ...limits, maxDocuments: 1.5 })).toThrow(/maxDocuments/)
    await expect(harness({ config: { maxDocumentBytes: 100, maxLibraryBytes: 90 } })).rejects.toThrow(/maxDocumentBytes/)
    expect(() => ExpertService.Config({ ...limits, maxExperts: undefined } as never)).toThrow()
  })

  it('rejects an invocation bound that cannot hold the longest soul and skill listing', () => {
    const construct = (maxInvocationLibraryBytes: number): void => {
      new ExpertService(new Context(), { ...limits, maxInvocationLibraryBytes })
    }
    let message = ''
    try {
      construct(1)
    } catch (error) {
      message = (error as Error).message
    }
    const needed = Number(/at least (\d+)/.exec(message)?.[1])
    expect(needed).toBeGreaterThan(limits.maxSoulBytes)
    expect(() => {
      construct(needed)
    }).not.toThrow()
    expect(() => {
      construct(needed - 1)
    }).toThrow(/maxInvocationLibraryBytes must be at least/)
  })

  it('rejects skill names longer than the listing bound', async () => {
    const { service } = await harness()
    expect((await service.saveExpert(expert({ skills: ['a'.repeat(64)] }), signal)).experts).toHaveLength(1)
    const error = await rejection(service.saveExpert(expert({ name: 'other', skills: ['a'.repeat(65)] }), signal))
    expect(error).toMatchObject({ code: 'expert/invalid', details: { field: 'skills' } })
  })
})

describe('Expert library documents and knowledge bases', () => {
  it('stores a text document without exposing its text in the list', async () => {
    const { service } = await harness()
    const library = await service.createDocument({ title: ' Notes ', text: 'alpha beta' }, signal)
    expect(library.documents).toHaveLength(1)
    expect(library.documents[0]).toMatchObject({ title: 'Notes', bytes: 10 })
    expect(JSON.stringify(library)).not.toContain('alpha beta')
  })

  it('rejects bad titles and texts with expert/invalid', async () => {
    const { service } = await harness()
    for (const request of [
      { title: '', text: 'x' },
      { title: 'x'.repeat(121), text: 'x' },
      { title: 'ok', text: '  ' },
      { title: 'ok', text: 'a\u0000b' },
      { title: 'ok', text: 'a\u001Bb' },
      { title: 'ok', text: 'a\uDC00' },
      { title: 'bad\u0000', text: 'x' },
    ]) {
      const error = await rejection(service.createDocument(request, signal))
      expect(error.code, JSON.stringify(request)).toBe('expert/invalid')
    }
  })

  it('accepts tab, newline, and carriage return in document text', async () => {
    const { service } = await harness()
    const library = await service.createDocument({ title: 'ws', text: 'a\tb\nc\r\nd' }, signal)
    expect(library.documents).toHaveLength(1)
  })

  it('enforces maxDocumentBytes exactly, in bytes', async () => {
    const { service } = await harness()
    await service.createDocument({ title: 'fits', text: 'x'.repeat(limits.maxDocumentBytes) }, signal)
    const chars = '你'.repeat(Math.floor(limits.maxDocumentBytes / 3) + 1)
    const error = await rejection(service.createDocument({ title: 'wide', text: chars }, signal))
    expect(error).toMatchObject({ code: 'expert/limit-exceeded', details: { limit: 'maxDocumentBytes' } })
  })

  it('enforces maxDocuments and maxLibraryBytes', async () => {
    const { service } = await harness()
    await service.createDocument({ title: 'a', text: 'x'.repeat(40) }, signal)
    await service.createDocument({ title: 'b', text: 'x'.repeat(40) }, signal)
    const total = await rejection(service.createDocument({ title: 'c', text: 'x'.repeat(11) }, signal))
    expect(total).toMatchObject({ code: 'expert/limit-exceeded', details: { limit: 'maxLibraryBytes' } })
    await service.createDocument({ title: 'c', text: 'x'.repeat(10) }, signal)
    const count = await rejection(service.createDocument({ title: 'd', text: 'x' }, signal))
    expect(count).toMatchObject({ code: 'expert/limit-exceeded', details: { limit: 'maxDocuments' } })
  })

  it('manages knowledge bases with member and count limits', async () => {
    const { service } = await harness()
    let library = await service.createDocument({ title: 'a', text: 'one' }, signal)
    library = await service.createDocument({ title: 'b', text: 'two' }, signal)
    library = await service.createDocument({ title: 'c', text: 'three' }, signal)
    const [a, b, c] = library.documents.map(document => document.id)

    library = await service.saveKnowledgeBase({ name: ' Base ', documentIds: [a!, b!] }, signal)
    const base = library.knowledgeBases[0]!
    expect(base).toMatchObject({ name: 'Base', documentIds: [a, b] })

    const tooMany = await rejection(service.saveKnowledgeBase({ id: base.id, name: 'Base', documentIds: [a!, b!, c!] }, signal))
    expect(tooMany).toMatchObject({ code: 'expert/limit-exceeded', details: { limit: 'maxDocumentsPerKnowledgeBase' } })
    const repeated = await rejection(service.saveKnowledgeBase({ name: 'Dup', documentIds: [a!, a!] }, signal))
    expect(repeated.code).toBe('expert/invalid')
    const unknown = await rejection(service.saveKnowledgeBase({ name: 'Ghost', documentIds: ['ghost' as never] }, signal))
    expect(unknown.code).toBe('expert/not-found')
    const blank = await rejection(service.saveKnowledgeBase({ name: ' ', documentIds: [] }, signal))
    expect(blank.code).toBe('expert/invalid')
    const missing = await rejection(service.saveKnowledgeBase({ id: 'missing' as never, name: 'x', documentIds: [] }, signal))
    expect(missing.code).toBe('expert/not-found')

    const renamed = await service.saveKnowledgeBase({ id: base.id, name: 'Renamed', documentIds: [b!] }, signal)
    expect(renamed.knowledgeBases[0]).toMatchObject({ id: base.id, name: 'Renamed', documentIds: [b], createdAt: base.createdAt })

    await service.saveKnowledgeBase({ name: 'Second', documentIds: [] }, signal)
    const overCount = await rejection(service.saveKnowledgeBase({ name: 'Third', documentIds: [] }, signal))
    expect(overCount).toMatchObject({ code: 'expert/limit-exceeded', details: { limit: 'maxKnowledgeBases' } })
  })

  it('removes a deleted document from knowledge bases and Experts', async () => {
    const { service } = await harness()
    let library = await service.createDocument({ title: 'a', text: 'one' }, signal)
    library = await service.createDocument({ title: 'b', text: 'two' }, signal)
    const [a, b] = library.documents.map(document => document.id)
    library = await service.saveKnowledgeBase({ name: 'Base', documentIds: [a!, b!] }, signal)
    await service.saveExpert(expert({ documentIds: [a!], knowledgeBaseIds: [library.knowledgeBases[0]!.id] }), signal)

    library = await service.deleteDocument({ id: a! }, signal)
    expect(library.documents.map(document => document.id)).toEqual([b])
    expect(library.knowledgeBases[0]!.documentIds).toEqual([b])
    expect(library.experts[0]!.documentIds).toEqual([])
    const missing = await rejection(service.deleteDocument({ id: a! }, signal))
    expect(missing).toMatchObject({ code: 'expert/not-found', details: { kind: 'document' } })
  })

  it('removes a deleted knowledge base from Experts but keeps its documents', async () => {
    const { service } = await harness()
    let library = await service.createDocument({ title: 'a', text: 'one' }, signal)
    library = await service.saveKnowledgeBase({ name: 'Base', documentIds: [library.documents[0]!.id] }, signal)
    const baseId = library.knowledgeBases[0]!.id
    await service.saveExpert(expert({ knowledgeBaseIds: [baseId] }), signal)

    library = await service.deleteKnowledgeBase({ id: baseId }, signal)
    expect(library.knowledgeBases).toEqual([])
    expect(library.documents).toHaveLength(1)
    expect(library.experts[0]!.knowledgeBaseIds).toEqual([])
    const missing = await rejection(service.deleteKnowledgeBase({ id: baseId }, signal))
    expect(missing).toMatchObject({ code: 'expert/not-found', details: { kind: 'knowledge-base' } })
  })

  it('leaves Experts that do not select a deleted knowledge base untouched', async () => {
    const { service } = await harness()
    const first = await service.saveKnowledgeBase({ name: 'First', documentIds: [] }, signal)
    await service.saveExpert(expert(), signal)
    const after = await service.deleteKnowledgeBase({ id: first.knowledgeBases[0]!.id }, signal)
    expect(after.experts).toHaveLength(1)
    expect(after.knowledgeBases).toEqual([])
  })

  it('keeps documents across a restart', async () => {
    const first = await harness()
    await first.service.createDocument({ title: 'kept', text: 'durable text' }, signal)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = await harness({ root: first.root, home: first.home })
    expect((await second.service.list({}, signal)).documents[0]).toMatchObject({ title: 'kept', bytes: 12 })
  })
})

function agentFor(cwd: string): Agent {
  const id = SessionId(`expert-${cwd}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    model: {} as Agent['model'],
    inbox: unsupportedInbox(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('expert invocation must use the pre-step decision') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** A browser-composer prompt carries the client-minted `rpcId`; `extra` replaces it for other origins. */
function userMessage(text: string, kind = 'user', extra: object = kind === 'user' ? { rpcId: 'rpc-1' } : {}): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind, ...extra } as UserMessage['source'],
  })
}

/** Route the fixed step selection carries; invocation ignores it. */
const ROUTE = { provider: 'p', model: 'm' } as const

async function step(h: Harness, agent: Agent, messages: UserMessage[]): Promise<PreStepDecision> {
  return await agentEvents(h.ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal, modelSelection: ROUTE },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

function injected(decision: PreStepDecision, before: readonly UserMessage[]): UserMessage[] {
  if (decision.kind === 'reject') {
    throw new Error('unexpected reject')
  }
  return decision.messages.filter(message => !before.includes(message))
}

function textOf(message: UserMessage): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n---block---\n')
}

describe('Expert invocation', () => {
  async function seeded(): Promise<{ h: Harness; agent: Agent }> {
    const h = await harness({ config: { maxSkillsPerExpert: 3 } })
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-expert-cwd-'))
    roots.push(cwd)
    await writeSkill(h.home, 'checklist', 'Run the checklist.')
    await writeSkill(h.home, 'hidden', 'Hidden body.', 'disable-model-invocation: true\nuser-invocable: false\n')
    let library = await h.service.createDocument({ title: 'Style "guide"', text: 'Use <b>short</b> words.' }, signal)
    library = await h.service.createDocument({ title: 'Glossary', text: 'term: meaning' }, signal)
    const [guide, glossary] = library.documents.map(document => document.id)
    library = await h.service.saveKnowledgeBase({ name: 'Base', documentIds: [glossary!] }, signal)
    await h.service.saveExpert(expert({
      soul: 'Review carefully.',
      skills: ['checklist', 'hidden', 'ghost'],
      documentIds: [guide!],
      knowledgeBaseIds: [library.knowledgeBases[0]!.id],
    }), signal)
    return { h, agent: agentFor(cwd) }
  }

  it('injects the Soul, skills, and library as one expert-invocation message', async () => {
    const { h, agent } = await seeded()
    const prompt = userMessage('@reviewer please look at this')
    const decision = await step(h, agent, [prompt])
    const [message, ...rest] = injected(decision, [prompt])
    expect(rest).toEqual([])
    expect(message!.source).toEqual({ kind: 'expert-invocation', form: 'instructions' })
    const text = textOf(message!)
    expect(text).toContain('<expert name="reviewer">')
    expect(text).toContain('Review carefully.')
    expect(text).toContain('Run the checklist.')
    expect(text).toContain('<expert_unavailable_skills>hidden, ghost</expert_unavailable_skills>')
    expect(text).toContain('<expert_document title="Style &quot;guide&quot;">')
    expect(text).toContain('Use &lt;b&gt;short&lt;/b&gt; words.')
    expect(text).toContain('<expert_knowledge_base name="Base">')
    expect(text).toContain('term: meaning')
    expect(text).not.toContain('Hidden body.')
    expect(decision.kind === 'enter' && decision.messages[0]).toBe(prompt)
  })

  it('treats an unknown, disabled, or non-leading mention as plain prose', async () => {
    const { h, agent } = await seeded()
    const saved = (await h.service.list({}, signal)).experts[0]!
    for (const text of ['@nobody hello', 'ask @reviewer later', 'email a@reviewer.dev', '@reviewer,hello', '@@reviewer', '']) {
      const prompt = userMessage(text)
      expect(injected(await step(h, agent, [prompt]), [prompt]), text).toEqual([])
    }
    await h.service.saveExpert(expert({ id: saved.id, enabled: false, skills: [] }), signal)
    const prompt = userMessage('@reviewer hello')
    expect(injected(await step(h, agent, [prompt]), [prompt])).toEqual([])
  })

  it('ignores mentions in messages that are not direct user input', async () => {
    const { h, agent } = await seeded()
    const prompt = userMessage('@reviewer from a tool', 'skill-invocation')
    expect(injected(await step(h, agent, [prompt]), [prompt])).toEqual([])
  })

  it('ignores a mention in a user message written by a subagent or another non-browser driver', async () => {
    const { h, agent } = await seeded()
    const forged = userMessage('@reviewer do this', 'user', {})
    expect(injected(await step(h, agent, [forged]), [forged])).toEqual([])
  })

  it('invokes a single Expert per step when several prompts mention one', async () => {
    const { h, agent } = await seeded()
    await h.service.saveExpert(expert({ name: 'second', soul: 'Second soul.' }), signal)
    const first = userMessage('@second go')
    const later = userMessage('@reviewer go')
    const added = injected(await step(h, agent, [first, later]), [first, later])
    expect(added).toHaveLength(1)
    expect(textOf(added[0]!)).toContain('<expert name="second">')
    expect(textOf(added[0]!)).not.toContain('Review carefully.')
  })

  it('does not inject on a rejected step', async () => {
    const { h, agent } = await seeded()
    const prompt = userMessage('@reviewer go')
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [prompt], turn: 1, step: 1, signal, modelSelection: ROUTE },
      () => Promise.resolve({ kind: 'reject' as const, reason: 'blocked' }),
    )
    expect(decision.kind).toBe('reject')
  })

  it('snapshots the material so later edits and deletes do not alter the logged message', async () => {
    const { h, agent } = await seeded()
    const prompt = userMessage('@reviewer go')
    const decision = await step(h, agent, [prompt])
    const [message] = injected(decision, [prompt])
    agent.session.append('user/message', message!, { surfaceOp: 'append' })
    const logged = textOf(message!)

    const library = await h.service.list({}, signal)
    await h.service.saveExpert(expert({ id: library.experts[0]!.id, soul: 'Changed soul.' }), signal)
    await h.service.deleteDocument({ id: library.documents[0]!.id }, signal)

    const replayed = agent.session.snapshotEvents().find(event => event.type === 'user/message')
    expect(replayed && textOf(replayed.data)).toBe(logged)
    expect(logged).toContain('Review carefully.')
    expect(logged).toContain('Use &lt;b&gt;short&lt;/b&gt; words.')
  })

  it('reads a leading mention that follows an attachment block', async () => {
    const { h, agent } = await seeded()
    const prompt = createUserMessage({
      content: [
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA==' } } as never,
        { type: 'text', text: '@reviewer what is in this picture' },
      ],
      source: { kind: 'user', rpcId: 'rpc-1' } as UserMessage['source'],
    })
    const [message] = injected(await step(h, agent, [prompt]), [prompt])
    expect(textOf(message!)).toContain('<expert name="reviewer">')
  })

  describe('complete rendered size bound', () => {
    /** Two documents whose escaping expands them well past their stored byte counts. */
    async function bounded(
      maxInvocationLibraryBytes: number,
      extra: (h: Harness) => Promise<string[]> = () => Promise.resolve([]),
    ): Promise<{ text: string; bytes: number }> {
      const h = await harness({ config: { maxInvocationLibraryBytes, maxDocumentBytes: 40, maxLibraryBytes: 90 } })
      const cwd = await mkdtemp(join(tmpdir(), 'dsh-expert-cwd-'))
      roots.push(cwd)
      let library = await h.service.createDocument({ title: '<&>"'.repeat(20), text: '<&>"'.repeat(10) }, signal)
      library = await h.service.createDocument({ title: 'Small', text: 'tiny' }, signal)
      const skills = await extra(h)
      await h.service.saveExpert(expert({ skills, documentIds: library.documents.map(document => document.id) }), signal)
      const prompt = userMessage('@reviewer go')
      const [message] = injected(await step(h, agentFor(cwd), [prompt]), [prompt])
      const blocks = message!.content.map(block => (block.type === 'text' ? block.text : ''))
      return { text: blocks.join(''), bytes: renderedBytes(blocks) }
    }

    it('holds the whole message, wrappers and escaped text included, to the configured bytes', async () => {
      const roomy = await bounded(100_000)
      expect(roomy.bytes).toBeGreaterThan(40 + 4)
      expect(roomy.text).toContain('&lt;&amp;&gt;"')
      const exact = await bounded(roomy.bytes)
      expect(exact.text).toBe(roomy.text)
      for (const budget of [roomy.bytes - 1, roomy.bytes - 80, roomy.bytes - 160, 700]) {
        const result = await bounded(budget)
        expect(result.bytes, `budget ${budget}`).toBeLessThanOrEqual(budget)
      }
      const below = await bounded(roomy.bytes - 1)
      expect(below.text).not.toBe(roomy.text)
    })

    it('lists a skill that overflows the bound as unavailable instead of injecting it', async () => {
      const install = async (h: Harness): Promise<string[]> => {
        await writeSkill(h.home, 'small-skill', 'Short.')
        await writeSkill(h.home, 'huge-skill', 'H'.repeat(5000))
        return ['small-skill', 'huge-skill']
      }
      const roomy = await bounded(100_000, install)
      expect(roomy.text).toContain('H'.repeat(5000))
      const tight = await bounded(2400, install)
      expect(tight.bytes).toBeLessThanOrEqual(2400)
      expect(tight.text).toContain('Short.')
      expect(tight.text).not.toContain('HHHH')
      expect(tight.text).toContain('<expert_unavailable_skills>huge-skill</expert_unavailable_skills>')
    })

    it('fails loudly when a stored Soul no longer fits the configured bound', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-expert-'))
      roots.push(root)
      await writeFile(join(root, 'experts.json'), JSON.stringify({
        unit: { name: 'experts', version: 1 },
        global: null,
        tables: {
          experts: {
            e1: {
              name: 'wordy', enabled: true, soul: 'x'.repeat(limits.maxInvocationLibraryBytes + 1), skills: [],
              documentIds: [], knowledgeBaseIds: [], createdAt: 1, updatedAt: 1,
            },
          },
          documents: {},
          knowledge_bases: {},
        },
      }))
      const h = await harness({ root })
      const cwd = await mkdtemp(join(tmpdir(), 'dsh-expert-cwd-'))
      roots.push(cwd)
      await expect(step(h, agentFor(cwd), [userMessage('@wordy go')])).rejects.toThrow(RangeError)
    })
  })

  it('stops listening when the service is disposed', async () => {
    const { h, agent } = await seeded()
    await h.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(h.ctx), 1)
    const prompt = userMessage('@reviewer go')
    expect(injected(await step(h, agent, [prompt]), [prompt])).toEqual([])
  })
})

describe('Expert usage ranking', () => {
  async function ranked(h: Harness): Promise<string[]> {
    return (await h.service.ranked({}, signal)).experts.map(entry => entry.name)
  }

  /** Run one browser-composer step for `@name` and commit its injection to the Session log, as the loop does. */
  async function invoke(h: Harness, agent: Agent, name: string, at: number): Promise<void> {
    const prompt = userMessage(`@${name} go`)
    const [message] = injected(await step(h, agent, [prompt]), [prompt])
    agent.session.append('user/message', message!, { surfaceOp: 'append' })
    const event = agent.session.snapshotEvents().filter(entry => entry.type === 'user/message').at(-1)!
    h.ctx.emit('session/event', agent.session, { ...event, time: at })
  }

  async function seededRanking(): Promise<{ h: Harness; agent: Agent }> {
    const h = await harness()
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-expert-cwd-'))
    roots.push(cwd)
    for (const name of ['alpha', 'beta', 'gamma']) {
      await h.service.saveExpert(expert({ name, soul: `${name} soul` }), signal)
    }
    return { h, agent: agentFor(cwd) }
  }

  it('orders unused Experts by name and omits disabled Experts', async () => {
    const { h } = await seededRanking()
    const library = await h.service.list({}, signal)
    const gamma = library.experts.find(entry => entry.name === 'gamma')!
    await h.service.saveExpert(expert({ id: gamma.id, name: 'gamma', enabled: false, soul: 'gamma soul' }), signal)
    expect(await ranked(h)).toEqual(['alpha', 'beta'])
    expect((await h.service.ranked({}, signal)).experts[0]).toMatchObject({ name: 'alpha', soul: 'alpha soul' })
  })

  it('ranks by committed use count, then recency, then name', async () => {
    const { h, agent } = await seededRanking()
    await invoke(h, agent, 'gamma', 100)
    await vi.waitFor(async () => { expect(await ranked(h)).toEqual(['gamma', 'alpha', 'beta']) })
    await invoke(h, agent, 'beta', 200)
    await vi.waitFor(async () => { expect(await ranked(h)).toEqual(['beta', 'gamma', 'alpha']) })
    await invoke(h, agent, 'gamma', 300)
    await vi.waitFor(async () => { expect(await ranked(h)).toEqual(['gamma', 'beta', 'alpha']) })
  })

  it('does not count a step that was admitted by the pre-step but never committed', async () => {
    const { h, agent } = await seededRanking()
    const prompt = userMessage('@gamma go')
    injected(await step(h, agent, [prompt]), [prompt])
    const unrelated = userMessage('plain text')
    agent.session.append('user/message', unrelated, { surfaceOp: 'append' })
    h.ctx.emit('session/event', agent.session, agent.session.snapshotEvents().filter(entry => entry.type === 'user/message').at(-1)!)
    await h.service.list({}, signal)
    expect(await ranked(h)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('does not count a forged mention, a disabled Expert, or an unknown handle', async () => {
    const { h, agent } = await seededRanking()
    const forged = userMessage('@gamma go', 'user', {})
    expect(injected(await step(h, agent, [forged]), [forged])).toEqual([])
    expect(await ranked(h)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('counts each committed invocation once and keeps the count across edits and a restart', async () => {
    const { h, agent } = await seededRanking()
    await invoke(h, agent, 'gamma', 100)
    await vi.waitFor(async () => { expect(await ranked(h)).toEqual(['gamma', 'alpha', 'beta']) })
    const gamma = (await h.service.list({}, signal)).experts.find(entry => entry.name === 'gamma')!
    await h.service.saveExpert(expert({ id: gamma.id, name: 'gamma', soul: 'edited soul' }), signal)
    await h.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(h.ctx), 1)
    const second = await harness({ root: h.root, home: h.home })
    expect(await ranked(second)).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('skips the count when the Expert was deleted before the log recorded the invocation', async () => {
    const { h, agent } = await seededRanking()
    const prompt = userMessage('@gamma go')
    const [message] = injected(await step(h, agent, [prompt]), [prompt])
    const gamma = (await h.service.list({}, signal)).experts.find(entry => entry.name === 'gamma')!
    await h.service.deleteExpert({ id: gamma.id }, signal)
    agent.session.append('user/message', message!, { surfaceOp: 'append' })
    h.ctx.emit('session/event', agent.session, agent.session.snapshotEvents().filter(entry => entry.type === 'user/message').at(-1)!)
    await h.service.list({}, signal)
    expect(await ranked(h)).toEqual(['alpha', 'beta'])
  })

  it('rejects an aborted ranked request', async () => {
    const { h } = await seededRanking()
    const controller = new AbortController()
    controller.abort()
    await expect(h.service.ranked({}, controller.signal)).rejects.toThrow()
  })
})

describe('Expert library durable records', () => {
  const stored = (tables: Record<string, unknown>): string => JSON.stringify({
    unit: { name: 'experts', version: 1 },
    global: null,
    tables: { experts: {}, documents: {}, knowledge_bases: {}, ...tables },
  })

  it('skips selected documents and knowledge bases that no longer exist when invoking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-expert-'))
    roots.push(root)
    await writeFile(join(root, 'experts.json'), stored({
      experts: {
        e1: {
          name: 'dangling', enabled: true, soul: 'Still here.', skills: [],
          documentIds: ['gone-doc'], knowledgeBaseIds: ['gone-base'], createdAt: 1, updatedAt: 1,
        },
      },
    }))
    const h = await harness({ root })
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-expert-cwd-'))
    roots.push(cwd)
    const prompt = userMessage('@dangling go')
    const [message] = injected(await step(h, agentFor(cwd), [prompt]), [prompt])
    const text = textOf(message!)
    expect(text).toContain('Still here.')
    expect(text).not.toContain('expert_library')
  })

  it('fails loudly at load when a stored record does not match the schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-expert-'))
    roots.push(root)
    await writeFile(join(root, 'experts.json'), stored({ experts: { e1: { name: 7 } } }))
    await expect(harness({ root })).rejects.toThrow()
    const document = JSON.parse(await readFile(join(root, 'experts.json'), 'utf8')) as { tables: { experts: Record<string, unknown> } }
    expect(document.tables.experts.e1).toEqual({ name: 7 })
  })
})
