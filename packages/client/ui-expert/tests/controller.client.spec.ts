import { describe, expect, it, vi } from 'vitest'
import type { ExpertLibraryValue, ExpertValue } from '@deepseek-ai/dsh-api-remotes/client'
import { ExpertsController, type ExpertSkillsRemote, type ExpertsRemote } from '../src/client/controller.ts'

const limits = {
  maxExperts: 5, maxSoulBytes: 100, maxSkillsPerExpert: 3, maxDocuments: 5, maxDocumentBytes: 100,
  maxKnowledgeBases: 5, maxDocumentsPerKnowledgeBase: 5, maxLibraryBytes: 500, maxInvocationLibraryBytes: 200,
}

const expert = (name: string, enabled = true): ExpertValue => ({
  id: `id-${name}` as ExpertValue['id'], name, enabled, soul: `${name} soul`, skills: [], documentIds: [],
  knowledgeBaseIds: [], createdAt: 1, updatedAt: 1,
})

const library = (...experts: ExpertValue[]): ExpertLibraryValue => ({
  experts, documents: [], knowledgeBases: [], limits,
})

function fakeRemote(overrides: Partial<ExpertsRemote> = {}): ExpertsRemote {
  const ok = async () => ({ ok: true as const, value: library(expert('alpha')) })
  return {
    list: vi.fn(async () => ({ ok: true as const, value: library(expert('alpha'), expert('beta', false)) })),
    ranked: vi.fn(async () => ({
      ok: true as const,
      value: { experts: [{ id: 'id-beta' as ExpertValue['id'], name: 'beta', soul: 'beta soul' }] },
    })),
    saveExpert: vi.fn(ok),
    deleteExpert: vi.fn(ok),
    createDocument: vi.fn(ok),
    deleteDocument: vi.fn(ok),
    saveKnowledgeBase: vi.fn(ok),
    deleteKnowledgeBase: vi.fn(ok),
    ...overrides,
  }
}

const skillEntry = (name: string) => ({ name, description: '', provider: 'filesystem', source: 'user-dsh', enabled: true })

function fakeSkills(overrides: Partial<ExpertSkillsRemote> = {}): ExpertSkillsRemote {
  return {
    inventory: async () => ({ ok: true, value: { skills: [skillEntry('review'), skillEntry('plan')] } }),
    ...overrides,
  }
}

describe('ExpertsController', () => {
  it('reads the library and the skill names together', async () => {
    const controller = new ExpertsController(fakeRemote(), fakeSkills())
    await controller.refresh()
    const state = controller.inject().hooks.experts.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.library?.experts.map(entry => entry.name)).toEqual(['alpha', 'beta'])
    expect(state.skills).toEqual(['review', 'plan'])
  })

  it('omits disabled skills and collapses duplicate names in the skill picker', async () => {
    const controller = new ExpertsController(fakeRemote(), fakeSkills({
      inventory: async () => ({
        ok: true,
        value: {
          skills: [
            skillEntry('review'),
            { ...skillEntry('off'), enabled: false },
            { ...skillEntry('review'), source: 'project-dsh' },
            skillEntry('plan'),
          ],
        },
      }),
    }))
    await controller.refresh()
    expect(controller.inject().hooks.experts.getSnapshot().skills).toEqual(['review', 'plan'])
  })

  it('reads the Host-ranked Experts on every call instead of the cached library', async () => {
    const ranked = vi.fn<ExpertsRemote['ranked']>()
      .mockResolvedValueOnce({ ok: true, value: { experts: [{ id: 'a' as ExpertValue['id'], name: 'alpha', soul: 's' }] } })
      .mockResolvedValueOnce({ ok: true, value: { experts: [{ id: 'b' as ExpertValue['id'], name: 'beta', soul: 's' }] } })
      .mockResolvedValueOnce({ ok: false, error: { message: 'offline' } })
    const controller = new ExpertsController(fakeRemote({ ranked }), fakeSkills())
    const signal = new AbortController().signal
    expect((await controller.rankedExperts(signal)).map(entry => entry.name)).toEqual(['alpha'])
    expect((await controller.rankedExperts(signal)).map(entry => entry.name)).toEqual(['beta'])
    await expect(controller.rankedExperts(signal)).rejects.toThrow('offline')
    expect(ranked).toHaveBeenCalledTimes(3)
    expect(ranked).toHaveBeenCalledWith({}, signal)
  })

  it('keeps the library readable when the skill inventory fails', async () => {
    const controller = new ExpertsController(fakeRemote(), fakeSkills({
      inventory: async () => ({ ok: false, error: { message: 'no registry' } }),
    }))
    await controller.refresh()
    const state = controller.inject().hooks.experts.getSnapshot()
    expect(state).toMatchObject({ phase: 'ready', skills: [] })
  })

  it('reports library failures and recovers on retry', async () => {
    const list = vi.fn<ExpertsRemote['list']>()
      .mockResolvedValueOnce({ ok: false, error: { message: 'storage offline' } })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: true, value: library(expert('alpha')) })
    const controller = new ExpertsController(fakeRemote({ list }), fakeSkills())
    const store = controller.inject().hooks.experts
    await controller.refresh()
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', error: 'storage offline' })
    await controller.refresh()
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', error: 'Error: network' })
    await controller.refresh()
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', error: undefined })
  })

  it('drops the result of a superseded read', async () => {
    const releases: Array<() => void> = []
    const list = vi.fn<ExpertsRemote['list']>((_request, signal) => new Promise((resolve) => {
      releases.push(() => { resolve({ ok: true, value: library(expert(signal.aborted ? 'stale' : 'fresh')) }) })
    }))
    const controller = new ExpertsController(fakeRemote({ list }), fakeSkills())
    const first = controller.refresh()
    const second = controller.refresh()
    releases[0]!()
    releases[1]!()
    await Promise.all([first, second])
    expect(controller.inject().hooks.experts.getSnapshot().library?.experts.map(entry => entry.name)).toEqual(['fresh'])
  })

  it('ignores a read that rejects after it was superseded', async () => {
    let rejectFirst: (reason: Error) => void = () => {}
    const list = vi.fn<ExpertsRemote['list']>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockResolvedValueOnce({ ok: true, value: library(expert('alpha')) })
    const controller = new ExpertsController(fakeRemote({ list }), fakeSkills())
    const first = controller.refresh()
    await controller.refresh()
    rejectFirst(new Error('late'))
    await first
    expect(controller.inject().hooks.experts.getSnapshot()).toMatchObject({ phase: 'ready', error: undefined })
  })

  it('does not let a pending read replace a mutation result', async () => {
    let resolveRead: ((value: Awaited<ReturnType<ExpertsRemote['list']>>) => void) | undefined
    const list = vi.fn<ExpertsRemote['list']>(() => new Promise((resolve) => { resolveRead = resolve }))
    const remote = fakeRemote({
      list,
      saveExpert: vi.fn(async () => ({ ok: true as const, value: library(expert('saved')) })),
    })
    const controller = new ExpertsController(remote, fakeSkills())
    const reading = controller.refresh()
    const saved = await controller.inject().saveExpert({
      name: 'saved', enabled: true, soul: 'soul', skills: [], documentIds: [], knowledgeBaseIds: [],
    })
    resolveRead?.({ ok: true, value: library(expert('stale')) })
    await reading
    expect(saved).toBe(true)
    expect(controller.inject().hooks.experts.getSnapshot().library?.experts.map(entry => entry.name)).toEqual(['saved'])
  })

  it('reloads after a reconnect only when the library was read before', async () => {
    const remote = fakeRemote()
    const controller = new ExpertsController(remote, fakeSkills())
    await controller.reload()
    expect(remote.list).not.toHaveBeenCalled()
    await controller.refresh()
    await controller.reload()
    expect(remote.list).toHaveBeenCalledTimes(2)
  })

  it('aborts the pending read when the controller stops', async () => {
    let signal: AbortSignal | undefined
    const list = vi.fn<ExpertsRemote['list']>((_request, received) => {
      signal = received
      return new Promise(() => {})
    })
    const controller = new ExpertsController(fakeRemote({ list }), fakeSkills())
    const stop = controller.start()
    void controller.refresh()
    stop()
    expect(signal?.aborted).toBe(true)
  })

  it('applies each mutation result to the library and forwards the request', async () => {
    const remote = fakeRemote()
    const controller = new ExpertsController(remote, fakeSkills())
    const face = controller.inject()
    const save = { name: 'alpha', enabled: true, soul: 'be brief', skills: [], documentIds: [], knowledgeBaseIds: [] }
    expect(await face.saveExpert(save)).toBe(true)
    expect(remote.saveExpert).toHaveBeenCalledWith(save, expect.any(AbortSignal))
    expect(await face.deleteExpert('id-alpha' as ExpertValue['id'])).toBe(true)
    expect(remote.deleteExpert).toHaveBeenCalledWith({ id: 'id-alpha' }, expect.any(AbortSignal))
    expect(await face.createDocument({ title: 'Guide', text: 'body' })).toBe(true)
    expect(remote.createDocument).toHaveBeenCalledWith({ title: 'Guide', text: 'body' }, expect.any(AbortSignal))
    expect(await face.deleteDocument('doc' as never)).toBe(true)
    expect(remote.deleteDocument).toHaveBeenCalledWith({ id: 'doc' }, expect.any(AbortSignal))
    expect(await face.saveKnowledgeBase({ name: 'kb', documentIds: [] })).toBe(true)
    expect(remote.saveKnowledgeBase).toHaveBeenCalledWith({ name: 'kb', documentIds: [] }, expect.any(AbortSignal))
    expect(await face.deleteKnowledgeBase('kb' as never)).toBe(true)
    expect(remote.deleteKnowledgeBase).toHaveBeenCalledWith({ id: 'kb' }, expect.any(AbortSignal))
    expect(face.hooks.experts.getSnapshot()).toMatchObject({ busy: false, actionError: undefined })
    expect(face.hooks.experts.getSnapshot().library?.experts.map(entry => entry.name)).toEqual(['alpha'])
  })

  it('reports a refused or thrown mutation without changing the library', async () => {
    const saveExpert = vi.fn<ExpertsRemote['saveExpert']>()
      .mockResolvedValueOnce({ ok: false, error: { message: 'name taken' } })
      .mockRejectedValueOnce(new Error('offline'))
    const controller = new ExpertsController(fakeRemote({ saveExpert }), fakeSkills())
    await controller.refresh()
    const face = controller.inject()
    const save = { name: 'alpha', enabled: true, soul: 'x', skills: [], documentIds: [], knowledgeBaseIds: [] }
    expect(await face.saveExpert(save)).toBe(false)
    expect(face.hooks.experts.getSnapshot()).toMatchObject({ busy: false, actionError: 'name taken' })
    expect(await face.saveExpert(save)).toBe(false)
    expect(face.hooks.experts.getSnapshot().actionError).toBe('Error: offline')
    expect(face.hooks.experts.getSnapshot().library?.experts).toHaveLength(2)
  })
})
