// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { AddContribution, CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { ExpertsSection } from '../src/client/ExpertsSection.tsx'
import type { ExpertsFace } from '../src/client/controller.ts'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const limits = {
  maxExperts: 5, maxSoulBytes: 100, maxSkillsPerExpert: 3, maxDocuments: 5, maxDocumentBytes: 100,
  maxKnowledgeBases: 5, maxDocumentsPerKnowledgeBase: 5, maxLibraryBytes: 500, maxInvocationLibraryBytes: 200,
}

const expert = (name: string, enabled: boolean, soul: string) => ({
  id: `id-${name}`, name, enabled, soul, skills: [], documentIds: [], knowledgeBaseIds: [], createdAt: 1, updatedAt: 1,
})

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const list = vi.fn(async () => ({
    ok: true,
    value: {
      experts: [
        expert('reviewer', true, 'Review every change.\nSecond line.'),
        expert('retired', false, 'Old.'),
        expert('researcher', true, 'x'.repeat(200)),
      ],
      documents: [],
      knowledgeBases: [],
      limits,
    },
  }))
  const inventory = vi.fn(async () => ({ ok: true, value: { skills: [] } }))
  const ranked = vi.fn(async () => ({
    ok: true,
    value: {
      experts: [
        { id: 'id-researcher', name: 'researcher', soul: 'x'.repeat(200) },
        { id: 'id-reviewer', name: 'reviewer', soul: 'Review every change.\nSecond line.' },
      ],
    },
  }))
  const remote = new TestRemote(ctx, { experts: { list, ranked }, skills: { inventory } })
  const sources: InputTriggerSource[] = []
  const unregister = vi.fn()
  ctx.provide('inputTriggers', {
    registerSource: (source: InputTriggerSource) => { sources.push(source); return unregister },
  })
  const contributions: CommandContribution[] = []
  const adds: AddContribution[] = []
  const unregisterCommand = vi.fn()
  const unregisterAdd = vi.fn()
  ctx.provide('commandUi', {
    register: (contribution: CommandContribution) => { contributions.push(contribution); return unregisterCommand },
    registerAdd: (contribution: AddContribution) => { adds.push(contribution); return unregisterAdd },
  })
  const addressed = new Set<string>()
  ctx.provide('sessions', {
    scope: (id: string) => (id === 'gone' ? undefined : ctx),
    subagentAddress: (id: string) => (addressed.has(id) ? { subagent: true } : undefined),
  })
  const composer = { draft: '', draftRev: 4 }
  ctx.provide('conversation', { input: { for: () => ({ state: { getSnapshot: () => composer } }) } })
  const inserts: Array<{ text: string; span: { start: number; end: number; draftRev: number } }> = []
  let accept = true
  ctx.on('slash/input-insert-text', (request) => {
    inserts.push(request)
    return accept ? true : undefined
  })
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, ranked, inventory, remote, sources, unregister,
    contributions, adds, unregisterCommand, unregisterAdd, addressed, composer, inserts, refuseInserts: () => { accept = false },
  }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

const session = { sessionId: 's1' as never }

describe('ui-expert browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services used by the page and the source', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.experts', 'remote.skills', 'inputTriggers', 'sessions', 'commandUi',
    ])
  })

  it('registers the Experts page after Skills with localized copy and reloads only after a read', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ExpertsSection)
    expect(entry.options).toMatchObject({ id: 'experts', order: 23 })
    expect(entry.locale).toBe('settings.experts')
    expect(resolveSlotLabel(entry.options.label)).toBe('专家')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Experts')

    const face = (entry.inject as unknown as () => ExpertsFace)()
    b.ctx.emit('connection/reset')
    expect(b.list).not.toHaveBeenCalled()
    await face.load()
    expect(b.list).toHaveBeenCalledTimes(1)
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })
    await b.ctx.fiber.dispose()
  })

  it('registers a leading-only @ source that offers the Host-ranked enabled Experts, filtered by query', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const source = b.sources[0]!
    expect(source).toMatchObject({ trigger: '@', name: 'expert' })

    const signal = new AbortController().signal
    const empty = await source.candidates(session, { query: '', position: 'leading', drilled: false, signal })
    expect(empty.map(candidate => candidate.name)).toEqual(['researcher', 'reviewer'])
    const leading = await source.candidates(session, { query: 're', position: 'leading', drilled: false, signal })
    expect(leading.map(candidate => candidate.name)).toEqual(['researcher', 'reviewer'])
    expect(leading.find(candidate => candidate.name === 'reviewer')?.description).toBe('Review every change.')
    expect(leading.find(candidate => candidate.name === 'researcher')?.description).toHaveLength(80)
    expect((await source.candidates(session, { query: 'rev', position: 'leading', drilled: false, signal })).map(candidate => candidate.name))
      .toEqual(['reviewer'])
    expect(await source.candidates(session, { query: 'zzz', position: 'leading', drilled: false, signal })).toEqual([])
    expect(b.list).not.toHaveBeenCalled()
  })

  it('preserves the Host usage order while filtering a query', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.ranked.mockResolvedValueOnce({
      ok: true,
      value: {
        experts: [
          { id: 'id-zebra', name: 'zebra', soul: 'Most used.' },
          { id: 'id-alpha', name: 'alpha', soul: 'Less used.' },
        ],
      },
    })
    const rows = await b.sources[0]!.candidates(session, {
      query: 'a', position: 'leading', drilled: false, signal: new AbortController().signal,
    })
    expect(rows.map(row => row.name)).toEqual(['zebra', 'alpha'])
  })

  it('reads the Host ranking afresh on every @ open so a used Expert moves first', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const source = b.sources[0]!
    const signal = new AbortController().signal
    const open = async () => (await source.candidates(session, { query: '', position: 'leading', drilled: false, signal }))
      .map(candidate => candidate.name)
    expect(await open()).toEqual(['researcher', 'reviewer'])
    b.ranked.mockResolvedValueOnce({
      ok: true,
      value: {
        experts: [
          { id: 'id-reviewer', name: 'reviewer', soul: 'Review every change.' },
          { id: 'id-researcher', name: 'researcher', soul: 'Research.' },
        ],
      },
    })
    expect(await open()).toEqual(['reviewer', 'researcher'])
    expect(b.ranked).toHaveBeenCalledTimes(2)
  })

  it('offers nothing at an inline position, after abort, and does not read the Host for them', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const source = b.sources[0]!
    const signal = new AbortController().signal
    expect(await source.candidates(session, { query: '', position: 'inline', drilled: false, signal })).toEqual([])
    expect(b.ranked).not.toHaveBeenCalled()

    const aborted = new AbortController()
    aborted.abort()
    expect(await source.candidates(session, { query: '', position: 'leading', drilled: false, signal: aborted.signal })).toEqual([])
  })

  it('lands the literal @name text on pick and unregisters the source on dispose', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const outcome = b.sources[0]!.onPick({
      candidate: { name: 'reviewer' }, session, position: 'leading', via: 'menu', action: 'pick',
      span: {} as never,
    })
    expect(outcome).toEqual({ text: '@reviewer ' })
    await b.ctx.fiber.dispose()
    expect(b.unregister).toHaveBeenCalledTimes(1)
  })

  describe('Add menu Expert row', () => {
    const open = async () => {
      const b = await bench()
      declare(b.slots)
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      const contribution = b.adds[0]!
      return { b, contribution, flyout: contribution.flyout }
    }
    const signal = () => new AbortController().signal

    it('registers a localized row with a flyout, hidden in addressed subagent sessions, and unregisters on dispose', async () => {
      const { b, contribution } = await open()
      expect(contribution).toMatchObject({ name: 'expert' })
      expect(b.contributions).toEqual([])
      expect(contribution.label()).toBe('专家')
      expect(contribution.description()).toBe('选择一位专家来调用')
      b.locale.setLocale('en')
      expect(contribution.label()).toBe('Expert')
      expect(contribution.description()).toBe('Pick an Expert to invoke')
      expect(contribution.available(session)).toBe(true)
      b.addressed.add('s1')
      expect(contribution.available(session)).toBe(false)
      await b.ctx.fiber.dispose()
      expect(b.unregisterAdd).toHaveBeenCalledTimes(1)
    })

    it('lists the Host-ranked enabled Experts in rank order and reads them afresh on every open', async () => {
      const { b, flyout } = await open()
      const rows = await flyout.options(session, signal())
      expect(rows.map(row => row.id)).toEqual(['researcher', 'reviewer'])
      expect(rows[1]).toEqual({
        id: 'reviewer', label: 'reviewer', value: '["researcher","reviewer"]', detail: 'Review every change.',
      })
      expect(rows[0]!.detail).toHaveLength(80)
      expect(rows[0]!.value).toBe(rows[1]!.value)
      await flyout.options(session, signal())
      expect(b.ranked).toHaveBeenCalledTimes(2)
      expect(b.list).not.toHaveBeenCalled()
    })

    it('a Host refusal rejects the open', async () => {
      const { b, flyout } = await open()
      b.ranked.mockResolvedValueOnce({ ok: false, error: { message: 'host unavailable' } } as never)
      await expect(flyout.options(session, signal())).rejects.toThrow('host unavailable')
    })

    it('a pick inserts the same leading @name text as the @ menu, at the draft start, without sending', async () => {
      const { b, flyout } = await open()
      b.composer.draft = 'fix the bug'
      await flyout.options(session, signal())
      await flyout.onSelect({ id: 'reviewer', label: 'reviewer' }, session)
      expect(b.inserts).toEqual([{ text: '@reviewer ', span: { start: 0, end: 0, draftRev: 4 } }])
      const atMenu = b.sources[0]!.onPick({
        candidate: { name: 'reviewer' }, session, position: 'leading', via: 'menu', action: 'pick', span: {} as never,
      })
      expect(atMenu).toEqual({ text: b.inserts[0]!.text })
    })

    it('a pick replaces an existing leading mention of a listed Expert and keeps an unlisted one', async () => {
      const { b, flyout } = await open()
      const reviewer = (await flyout.options(session, signal())).find(row => row.id === 'reviewer')!
      b.composer.draft = '@researcher fix the bug'
      await flyout.onSelect(reviewer, session)
      b.composer.draft = '@stranger fix the bug'
      await flyout.onSelect(reviewer, session)
      expect(b.inserts.map(insert => insert.span.end)).toEqual(['@researcher '.length, 0])
    })

    it('does not replace a leading mention when the selected row lacks a valid catalog payload', async () => {
      const { b, flyout } = await open()
      b.composer.draft = '@researcher fix the bug'
      await flyout.onSelect({ id: 'reviewer', label: 'reviewer' }, session)
      await flyout.onSelect({ id: 'reviewer', label: 'reviewer', value: '{' }, session)
      await flyout.onSelect({ id: 'reviewer', label: 'reviewer', value: '["researcher"]' }, session)
      expect(b.inserts.map(insert => insert.span.end)).toEqual([0, 0, 0])
    })

    it('a pick fails loudly when the composer is gone or the draft moved on', async () => {
      const { b, flyout } = await open()
      await flyout.options(session, signal())
      await expect(Promise.resolve().then(() => flyout.onSelect({ id: 'reviewer', label: 'reviewer' }, { sessionId: 'gone' as never })))
        .rejects.toThrow('composer for this session is unavailable')
      b.refuseInserts()
      await expect(Promise.resolve().then(() => flyout.onSelect({ id: 'reviewer', label: 'reviewer' }, session)))
        .rejects.toThrow('draft changed')
    })

    it('keeps the response-local Expert catalog when another session opens a flyout', async () => {
      const { b, flyout } = await open()
      const reviewer = (await flyout.options(session, signal())).find(row => row.id === 'reviewer')!
      b.ranked.mockResolvedValueOnce({
        ok: true,
        value: { experts: [{ id: 'id-other', name: 'other', soul: 'Other.' }] },
      })
      await flyout.options({ sessionId: 's2' as never }, signal())
      b.composer.draft = '@researcher fix the bug'
      await flyout.onSelect(reviewer, session)
      expect(b.inserts).toEqual([{ text: '@reviewer ', span: { start: 0, end: '@researcher '.length, draftRev: 4 } }])
    })

    it('keeps the response-local Expert catalog when an earlier same-session read resolves last', async () => {
      const { b, flyout } = await open()
      type RankedResult = Awaited<ReturnType<typeof b.ranked>>
      let resolveFirst!: (value: RankedResult) => void
      let resolveSecond!: (value: RankedResult) => void
      b.ranked
        .mockImplementationOnce(() => new Promise<RankedResult>((resolve) => { resolveFirst = resolve }))
        .mockImplementationOnce(() => new Promise<RankedResult>((resolve) => { resolveSecond = resolve }))
      const first = flyout.options(session, signal())
      const second = flyout.options(session, signal())
      resolveSecond({
        ok: true,
        value: { experts: [{ id: 'id-researcher', name: 'researcher', soul: 'Research.' }, { id: 'id-reviewer', name: 'reviewer', soul: 'Review.' }] },
      })
      const reviewer = (await second).find(row => row.id === 'reviewer')!
      resolveFirst({ ok: true, value: { experts: [{ id: 'id-other', name: 'other', soul: 'Other.' }] } })
      await first
      b.composer.draft = '@researcher fix the bug'
      await flyout.onSelect(reviewer, session)
      expect(b.inserts).toEqual([{ text: '@reviewer ', span: { start: 0, end: '@researcher '.length, draftRev: 4 } }])
    })
  })
})
