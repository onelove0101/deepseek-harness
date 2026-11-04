/**
 * Experts library (`ctx.experts`): persistent per-user Experts, their private
 * document and knowledge-base library, and the one-shot `@name` invocation
 * that injects an Expert's Soul, selected skills, and library text into the
 * Session log.
 * @module @deepseek-ai/dsh-expert
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { isSkillName, isUserInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { composeInvocation, leadingExpertMention, renderedBytes, renderInvocation } from './invocation.ts'
import type { InvocationSkill, LibraryDocument } from './invocation.ts'
import { expertDomainSpec } from './spec.ts'
import type { DocumentRecord, ExpertRecord, KnowledgeBaseRecord } from './spec.ts'
import type {
  ExpertDeleteRequest,
  ExpertDocumentCreateRequest,
  ExpertDocumentDeleteRequest,
  ExpertDocumentId,
  ExpertId,
  ExpertKnowledgeBaseDeleteRequest,
  ExpertKnowledgeBaseId,
  ExpertKnowledgeBaseSaveRequest,
  ExpertLibraryValue,
  ExpertLimits,
  ExpertListRequest,
  ExpertRankedRequest,
  ExpertRankedValue,
  ExpertSaveRequest,
} from './types.ts'

export type * from './types.ts'
export { composeInvocation, leadingExpertMention, renderedBytes, renderInvocation, renderLibrary, selectLibrary } from './invocation.ts'
export { expertDomainSpec } from './spec.ts'

/**
 * Required storage and invocation bounds; every field is a deployment decision.
 * `maxInvocationLibraryBytes` bounds the complete rendered invocation message.
 */
export type Config = ExpertLimits

declare module '@deepseek-ai/cordis' {
  interface Context {
    experts: ExpertService
  }
}

/**
 * Durable source of the context message an invocation appends. The message
 * content is the complete snapshot the model saw (Soul, skill bodies, library
 * text), so replay never reads the live library.
 */
export interface ExpertInvocationSource {
  readonly kind: 'expert-invocation'
  /** Injected Expert context is instructions for the model to follow. */
  readonly form: 'instructions'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** An Expert @mention invocation injected before the model step. */
    'expert-invocation': ExpertInvocationSource
  }
}

/** Longest Expert mention handle. */
const NAME_MAX_LENGTH = 40
/** Longest selected skill name; bounds the unavailable-skill list of an invocation. */
const SKILL_NAME_MAX_LENGTH = 64
/** Longest document title in UTF-16 code units. */
const TITLE_MAX_LENGTH = 120
/** Longest knowledge-base name in UTF-16 code units. */
const KNOWLEDGE_BASE_NAME_MAX_LENGTH = 80
/** Valid Expert handle; the same token shape the invocation recognizer accepts. */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/
/** C0 control characters other than tab, line feed, and carriage return, plus DEL. */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

const limitFields = [
  'maxExperts', 'maxSoulBytes', 'maxSkillsPerExpert', 'maxDocuments', 'maxDocumentBytes',
  'maxKnowledgeBases', 'maxDocumentsPerKnowledgeBase', 'maxLibraryBytes', 'maxInvocationLibraryBytes',
] as const satisfies readonly (keyof ExpertLimits)[]

function invalid(field: string, reason: string): RemoteError<'expert/invalid'> {
  return new RemoteError('expert/invalid', `${field}: ${reason}`, { field, reason })
}

function overLimit(config: ExpertLimits, limit: keyof ExpertLimits): RemoteError<'expert/limit-exceeded'> {
  return new RemoteError('expert/limit-exceeded', `${limit} (${config[limit]}) exceeded`, { limit, max: config[limit] })
}

/** Reject text the library will not store: ill-formed UTF-16, NUL, and non-whitespace control characters. */
function assertStorableText(field: string, text: string): void {
  if (!text.isWellFormed()) {
    throw invalid(field, 'must be well-formed Unicode text')
  }
  if (FORBIDDEN_CONTROL.test(text)) {
    throw invalid(field, 'must not contain control characters')
  }
}

function assertDistinct(field: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw invalid(field, 'must not repeat an entry')
  }
}

/** Host owner of the `experts` Remote namespace and of Expert invocation. */
export class ExpertService extends TypertRemoteService {
  static inject = ['agents', 'skills', 'storageDomain']

  /** Loader validation for the required storage and invocation bounds. */
  static Config: s<Config> = s.object({
    maxExperts: s.number().step(1).min(1).required(),
    maxSoulBytes: s.number().step(1).min(1).required(),
    maxSkillsPerExpert: s.number().step(1).min(1).required(),
    maxDocuments: s.number().step(1).min(1).required(),
    maxDocumentBytes: s.number().step(1).min(1).required(),
    maxKnowledgeBases: s.number().step(1).min(1).required(),
    maxDocumentsPerKnowledgeBase: s.number().step(1).min(1).required(),
    maxLibraryBytes: s.number().step(1).min(1).required(),
    maxInvocationLibraryBytes: s.number().step(1).min(1).required(),
  })

  /** Opened in `[Service.init]`, which cordis completes before any dependent calls a method. */
  private domain!: Domain<typeof expertDomainSpec>
  private writeTail: Promise<unknown> = Promise.resolve()
  private admissionOpen = true
  /** The invocation message each Session awaits in its log; its commit records the use. */
  private readonly pendingUses = new WeakMap<Session, { readonly messageId: string; readonly expertId: ExpertId }>()

  /**
   * @param ctx - Host context carrying the agent, skill, and storage services.
   * @param config - Required storage and invocation bounds.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'experts')
    for (const field of limitFields) {
      if (!Number.isSafeInteger(config[field]) || config[field] < 1) {
        throw new TypeError(`experts: ${field} must be a positive safe integer`)
      }
    }
    if (config.maxDocumentBytes > config.maxLibraryBytes) {
      throw new TypeError('experts: maxDocumentBytes must not exceed maxLibraryBytes')
    }
    const longestRequired = renderedBytes(renderInvocation({
      name: 'a'.repeat(NAME_MAX_LENGTH),
      soul: 'a'.repeat(config.maxSoulBytes),
      skillBlocks: [],
      unavailableSkills: Array.from({ length: config.maxSkillsPerExpert }, () => 'a'.repeat(SKILL_NAME_MAX_LENGTH)),
      library: { direct: [], knowledgeBases: [], omitted: [] },
    }))
    if (longestRequired > config.maxInvocationLibraryBytes) {
      throw new TypeError(`experts: maxInvocationLibraryBytes must be at least ${longestRequired} to hold the longest soul`)
    }
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(expertDomainSpec)
    this.domain = domain
    this.ctx.effect(() => async () => {
      this.admissionOpen = false
      await this.writeTail
      await domain.close()
    }, 'experts.domain')
    this.ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') {
        return decision
      }
      const handle = leadingExpertMention(messages)
      if (handle === undefined) {
        return decision
      }
      const found = this.findByName(handle)
      // A handle naming no enabled Expert is ordinary prose, like an unknown `/skill`.
      if (found === undefined || !found[1].enabled) {
        return decision
      }
      signal.throwIfAborted()
      const injection = await this.buildInvocation(
        found[1],
        { cwd: agent.session.header.cwd, signal, scope: agent },
      )
      signal.throwIfAborted()
      // The step can still be cancelled or fail before the message is committed; the use is counted when the log records it.
      this.pendingUses.set(agent.session, { messageId: injection.id, expertId: found[0] })
      return { ...decision, messages: [...decision.messages, injection] }
    })
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') {
        return
      }
      const pending = this.pendingUses.get(session)
      if (pending === undefined || pending.messageId !== event.data.id) {
        return
      }
      this.pendingUses.delete(session)
      this.recordUse(pending.expertId, event.time).catch((error: unknown) => {
        this.ctx.logger.error(`experts: failed to record an invocation: ${String(error)}`)
      })
    })
  }

  /**
   * Read the whole library.
   * @param _request - no fields.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns Experts, documents without text, knowledge bases, and the bounds in force.
   */
  @Remote
  list(_request: ExpertListRequest, signal: AbortSignal): Promise<ExpertLibraryValue> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      return this.snapshot()
    })
  }

  /**
   * Read the enabled Experts in usage order for the composer menu.
   * @param _request - no fields.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns enabled Experts, most used first, then most recently used, then by name.
   */
  @Remote
  ranked(_request: ExpertRankedRequest, signal: AbortSignal): Promise<ExpertRankedValue> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      const entries = [...this.domain.table('experts').entries()].filter(([, record]) => record.enabled)
      entries.sort(([, a], [, b]) =>
        b.uses - a.uses || b.lastUsedAt - a.lastUsedAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return { experts: entries.map(([id, record]) => ({ id, name: record.name, soul: record.soul })) }
    })
  }

  /**
   * Create an Expert, or edit the Expert named by `request.id`.
   * @param request - desired Expert fields.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns the library after the write.
   * @throws RemoteError `expert/invalid`, `expert/not-found`, `expert/name-taken`, or `expert/limit-exceeded`.
   */
  @Remote
  saveExpert(request: ExpertSaveRequest, signal: AbortSignal): Promise<ExpertLibraryValue> {
    return this.mutate(signal, async (domain) => {
      const experts = domain.table('experts')
      this.validateExpert(request)
      const existing = request.id === undefined ? undefined : experts.get(request.id)
      if (request.id !== undefined && existing === undefined) {
        throw new RemoteError('expert/not-found', `no expert "${request.id}"`, { kind: 'expert', id: request.id })
      }
      if (request.id === undefined && experts.size >= this.config.maxExperts) {
        throw overLimit(this.config, 'maxExperts')
      }
      for (const [id, record] of experts.entries()) {
        if (record.name === request.name && id !== request.id) {
          throw new RemoteError('expert/name-taken', `expert "${request.name}" already exists`, { name: request.name })
        }
      }
      for (const documentId of request.documentIds) {
        this.requireDocument(domain, documentId)
      }
      for (const baseId of request.knowledgeBaseIds) {
        this.requireKnowledgeBase(domain, baseId)
      }
      const now = Date.now()
      const id = request.id ?? brandString<ExpertId>(randomUUID())
      await experts.put(id, {
        name: request.name,
        enabled: request.enabled,
        soul: request.soul,
        skills: [...request.skills],
        documentIds: [...request.documentIds],
        knowledgeBaseIds: [...request.knowledgeBaseIds],
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing === undefined ? now : Math.max(now, existing.updatedAt),
        uses: existing?.uses ?? 0,
        lastUsedAt: existing?.lastUsedAt ?? 0,
      })
    })
  }

  /**
   * Delete one Expert.
   * @param request - Expert to delete.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns the library after the write.
   * @throws RemoteError `expert/not-found` when the Expert does not exist.
   */
  @Remote
  deleteExpert(request: ExpertDeleteRequest, signal: AbortSignal): Promise<ExpertLibraryValue> {
    return this.mutate(signal, async (domain) => {
      if (!await domain.table('experts').delete(request.id)) {
        throw new RemoteError('expert/not-found', `no expert "${request.id}"`, { kind: 'expert', id: request.id })
      }
    })
  }

  /**
   * Store one text document in the private library.
   * @param request - title and text; the text arrives in the request, never as a path or URL.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns the library after the write.
   * @throws RemoteError `expert/invalid` or `expert/limit-exceeded`.
   */
  @Remote
  createDocument(request: ExpertDocumentCreateRequest, signal: AbortSignal): Promise<ExpertLibraryValue> {
    return this.mutate(signal, async (domain) => {
      const title = request.title.trim()
      if (title.length === 0 || title.length > TITLE_MAX_LENGTH) {
        throw invalid('title', `must be 1 to ${TITLE_MAX_LENGTH} characters`)
      }
      assertStorableText('title', title)
      assertStorableText('text', request.text)
      if (request.text.trim().length === 0) {
        throw invalid('text', 'must not be blank')
      }
      const bytes = Buffer.byteLength(request.text, 'utf8')
      if (bytes > this.config.maxDocumentBytes) {
        throw overLimit(this.config, 'maxDocumentBytes')
      }
      const documents = domain.table('documents')
      if (documents.size >= this.config.maxDocuments) {
        throw overLimit(this.config, 'maxDocuments')
      }
      let total = bytes
      for (const record of documents.entries()) {
        total += record[1].bytes
      }
      if (total > this.config.maxLibraryBytes) {
        throw overLimit(this.config, 'maxLibraryBytes')
      }
      await documents.put(brandString<ExpertDocumentId>(randomUUID()), {
        title,
        text: request.text,
        bytes,
        createdAt: Date.now(),
      })
    })
  }

  /**
   * Delete one document and drop it from every selection.
   * @param request - document to delete.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns the library after the write.
   * @throws RemoteError `expert/not-found` when the document does not exist.
   */
  @Remote
  deleteDocument(request: ExpertDocumentDeleteRequest, signal: AbortSignal): Promise<ExpertLibraryValue> {
    return this.mutate(signal, async (domain) => {
      this.requireDocument(domain, request.id)
      // Selections go first: a crash between writes leaves an unselected document, never a dangling selection.
      for (const [id, record] of [...domain.table('experts').entries()]) {
        if (record.documentIds.includes(request.id)) {
          await domain.table('experts').put(id, { ...record, documentIds: record.documentIds.filter(entry => entry !== request.id) })
        }
      }
      for (const [id, record] of [...domain.table('knowledge_bases').entries()]) {
        if (record.documentIds.includes(request.id)) {
          await domain.table('knowledge_bases').put(id, { ...record, documentIds: record.documentIds.filter(entry => entry !== request.id) })
        }
      }
      await domain.table('documents').delete(request.id)
    })
  }

  /**
   * Create a knowledge base, or edit the one named by `request.id`.
   * @param request - desired name and member documents.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns the library after the write.
   * @throws RemoteError `expert/invalid`, `expert/not-found`, or `expert/limit-exceeded`.
   */
  @Remote
  saveKnowledgeBase(request: ExpertKnowledgeBaseSaveRequest, signal: AbortSignal): Promise<ExpertLibraryValue> {
    return this.mutate(signal, async (domain) => {
      const name = request.name.trim()
      if (name.length === 0 || name.length > KNOWLEDGE_BASE_NAME_MAX_LENGTH) {
        throw invalid('name', `must be 1 to ${KNOWLEDGE_BASE_NAME_MAX_LENGTH} characters`)
      }
      assertStorableText('name', name)
      assertDistinct('documentIds', request.documentIds)
      if (request.documentIds.length > this.config.maxDocumentsPerKnowledgeBase) {
        throw overLimit(this.config, 'maxDocumentsPerKnowledgeBase')
      }
      const bases = domain.table('knowledge_bases')
      const existing = request.id === undefined ? undefined : bases.get(request.id)
      if (request.id !== undefined && existing === undefined) {
        throw new RemoteError('expert/not-found', `no knowledge base "${request.id}"`, { kind: 'knowledge-base', id: request.id })
      }
      if (request.id === undefined && bases.size >= this.config.maxKnowledgeBases) {
        throw overLimit(this.config, 'maxKnowledgeBases')
      }
      for (const documentId of request.documentIds) {
        this.requireDocument(domain, documentId)
      }
      const now = Date.now()
      await bases.put(request.id ?? brandString<ExpertKnowledgeBaseId>(randomUUID()), {
        name,
        documentIds: [...request.documentIds],
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing === undefined ? now : Math.max(now, existing.updatedAt),
      })
    })
  }

  /**
   * Delete one knowledge base and drop it from every Expert that selects it.
   * @param request - knowledge base to delete.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns the library after the write.
   * @throws RemoteError `expert/not-found` when the knowledge base does not exist.
   */
  @Remote
  deleteKnowledgeBase(request: ExpertKnowledgeBaseDeleteRequest, signal: AbortSignal): Promise<ExpertLibraryValue> {
    return this.mutate(signal, async (domain) => {
      this.requireKnowledgeBase(domain, request.id)
      for (const [id, record] of [...domain.table('experts').entries()]) {
        if (record.knowledgeBaseIds.includes(request.id)) {
          await domain.table('experts').put(id, { ...record, knowledgeBaseIds: record.knowledgeBaseIds.filter(entry => entry !== request.id) })
        }
      }
      await domain.table('knowledge_bases').delete(request.id)
    })
  }

  /** Serialize a read-validate-write job, then return the library as it stands after it. */
  private async mutate(
    signal: AbortSignal,
    job: (domain: Domain<typeof expertDomainSpec>) => Promise<void>,
  ): Promise<ExpertLibraryValue> {
    signal.throwIfAborted()
    if (!this.admissionOpen) {
      throw new Error('experts: service is disposing')
    }
    const run = this.writeTail.then(async () => {
      signal.throwIfAborted()
      await job(this.domain)
      return this.snapshot()
    })
    this.writeTail = run.catch(() => undefined)
    return await run
  }

  /** Count one committed invocation; an Expert deleted since the step began, or a disposing service, records nothing. */
  private async recordUse(id: ExpertId, at: number): Promise<void> {
    if (!this.admissionOpen) {
      return
    }
    const run = this.writeTail.then(async () => {
      const experts = this.domain.table('experts')
      const record = experts.get(id)
      if (record !== undefined) {
        await experts.put(id, { ...record, uses: record.uses + 1, lastUsedAt: Math.max(at, record.lastUsedAt) })
      }
    })
    this.writeTail = run.catch(() => undefined)
    await run
  }

  private snapshot(): ExpertLibraryValue {
    const domain = this.domain
    return {
      experts: [...domain.table('experts').entries()].map(([id, record]) => ({
        id,
        name: record.name,
        enabled: record.enabled,
        soul: record.soul,
        skills: record.skills,
        documentIds: record.documentIds.map(entry => brandString<ExpertDocumentId>(entry)),
        knowledgeBaseIds: record.knowledgeBaseIds.map(entry => brandString<ExpertKnowledgeBaseId>(entry)),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
      documents: [...domain.table('documents').entries()].map(([id, record]) => ({
        id, title: record.title, bytes: record.bytes, createdAt: record.createdAt,
      })),
      knowledgeBases: [...domain.table('knowledge_bases').entries()].map(([id, record]) => ({
        id,
        name: record.name,
        documentIds: record.documentIds.map(entry => brandString<ExpertDocumentId>(entry)),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
      limits: { ...this.config },
    }
  }

  private validateExpert(request: ExpertSaveRequest): void {
    if (request.name.length > NAME_MAX_LENGTH || !NAME_PATTERN.test(request.name)) {
      throw invalid('name', `must be lowercase letters, digits, and hyphens, start with a letter, and have at most ${NAME_MAX_LENGTH} characters`)
    }
    assertStorableText('soul', request.soul)
    if (request.soul.trim().length === 0) {
      throw invalid('soul', 'must not be blank')
    }
    if (Buffer.byteLength(request.soul, 'utf8') > this.config.maxSoulBytes) {
      throw overLimit(this.config, 'maxSoulBytes')
    }
    assertDistinct('skills', request.skills)
    assertDistinct('documentIds', request.documentIds)
    assertDistinct('knowledgeBaseIds', request.knowledgeBaseIds)
    if (request.skills.length > this.config.maxSkillsPerExpert) {
      throw overLimit(this.config, 'maxSkillsPerExpert')
    }
    for (const skill of request.skills) {
      if (skill.length > SKILL_NAME_MAX_LENGTH || !isSkillName(skill)) {
        throw invalid('skills', `every entry must be a valid skill name of at most ${SKILL_NAME_MAX_LENGTH} characters`)
      }
    }
  }

  private requireDocument(domain: Domain<typeof expertDomainSpec>, id: ExpertDocumentId): DocumentRecord {
    const record = domain.table('documents').get(id)
    if (record === undefined) {
      throw new RemoteError('expert/not-found', `no document "${id}"`, { kind: 'document', id })
    }
    return record
  }

  private requireKnowledgeBase(domain: Domain<typeof expertDomainSpec>, id: ExpertKnowledgeBaseId): KnowledgeBaseRecord {
    const record = domain.table('knowledge_bases').get(id)
    if (record === undefined) {
      throw new RemoteError('expert/not-found', `no knowledge base "${id}"`, { kind: 'knowledge-base', id })
    }
    return record
  }

  private findByName(name: string): readonly [ExpertId, ExpertRecord] | undefined {
    for (const entry of this.domain.table('experts').entries()) {
      if (entry[1].name === name) {
        return entry
      }
    }
    return undefined
  }

  /**
   * Snapshot one Expert's material into the message the pre-step appends.
   * Everything the model will see is resolved here, so the logged message is
   * the complete record of the invocation.
   */
  private async buildInvocation(
    expert: ExpertRecord,
    lookup: Parameters<Context['skills']['get']>[1],
  ): Promise<UserMessage> {
    const domain = this.domain
    const skills: InvocationSkill[] = []
    for (const name of expert.skills) {
      const skill = await this.ctx.skills.get(name, lookup)
      lookup?.signal?.throwIfAborted()
      // Same admission as a user-typed `/name`: unknown and user-disabled skills are not injected.
      skills.push({ name, block: skill === undefined || !isUserInvocable(skill) ? undefined : renderSkillContent(skill) })
    }
    const resolve = (documentId: string): LibraryDocument | undefined => {
      const record = domain.table('documents').get(brandString<ExpertDocumentId>(documentId))
      return record === undefined ? undefined : { id: documentId, title: record.title, text: record.text }
    }
    const present = (documents: readonly (LibraryDocument | undefined)[]): LibraryDocument[] =>
      documents.filter((document): document is LibraryDocument => document !== undefined)
    const bases = expert.knowledgeBaseIds.flatMap((baseId) => {
      const base = domain.table('knowledge_bases').get(brandString<ExpertKnowledgeBaseId>(baseId))
      return base === undefined ? [] : [{ name: base.name, documents: present(base.documentIds.map(resolve)) }]
    })
    const content = composeInvocation({
      name: expert.name,
      soul: expert.soul,
      skills,
      direct: present(expert.documentIds.map(resolve)),
      knowledgeBases: bases,
    }, this.config.maxInvocationLibraryBytes)
    return createUserMessage({
      content: content.map(text => ({ type: 'text' as const, text })),
      source: { kind: 'expert-invocation', form: 'instructions' },
    })
  }
}

export default ExpertService
