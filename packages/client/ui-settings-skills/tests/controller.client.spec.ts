import { describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SkillsController, type SkillsRemote, type SkillsSettings } from '../src/client/controller.ts'

const entry = (name: string) => ({ name, description: `${name} desc`, provider: 'filesystem', source: 'user-dsh', enabled: true })

function fakeScope(initial: string[], writable = true) {
  let snapshot: ConfigFormSnapshot<SkillsSettings> = {
    status: 'ready', value: { disabled: initial }, base: undefined, user: undefined, revision: 1, writable,
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (_field: string, value: unknown) => {
    snapshot = { ...snapshot, value: { disabled: value as string[] } }
    for (const listener of listeners) listener()
  })
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set,
  } as unknown as ConfigForm<SkillsSettings>
  return { scope, set }
}

function fakeRemote(overrides: Partial<SkillsRemote> = {}): SkillsRemote {
  return {
    inventory: async () => ({ ok: true, value: { skills: [entry('alpha'), entry('beta')] } }),
    add: async () => ({ ok: true, value: { skills: [entry('alpha'), entry('beta'), entry('gamma')] } }),
    ...overrides,
  }
}

describe('SkillsController', () => {
  it('joins the inventory with the live disabled list', async () => {
    const { scope } = fakeScope(['beta'])
    const controller = new SkillsController(fakeRemote(), scope)
    const stop = controller.start()
    await controller.refresh()
    const state = controller.inject().hooks.skills.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.rows.map(row => [row.name, row.enabled])).toEqual([['alpha', true], ['beta', false]])
    stop()
  })

  it('writes the whole disabled array and re-projects on the scope change', async () => {
    const { scope, set } = fakeScope(['beta'])
    const controller = new SkillsController(fakeRemote(), scope)
    const stop = controller.start()
    await controller.refresh()
    const face = controller.inject()
    await face.setEnabled('alpha', false)
    expect(set).toHaveBeenLastCalledWith('disabled', ['beta', 'alpha'])
    await face.setEnabled('beta', true)
    expect(set).toHaveBeenLastCalledWith('disabled', ['alpha'])
    expect(face.hooks.skills.getSnapshot().rows.map(row => row.enabled)).toEqual([false, true])
    stop()
  })

  it('reports a rejected toggle', async () => {
    const { scope, set } = fakeScope([])
    set.mockRejectedValueOnce(new Error('stale revision'))
    const controller = new SkillsController(fakeRemote(), scope)
    const face = controller.inject()
    await face.setEnabled('alpha', false)
    expect(face.hooks.skills.getSnapshot().actionError).toBe('stale revision')
    set.mockRejectedValueOnce('plain failure')
    await face.setEnabled('alpha', false)
    expect(face.hooks.skills.getSnapshot().actionError).toBe('plain failure')
  })

  it('reports inventory failures and recovers on retry', async () => {
    const { scope } = fakeScope([])
    const inventory = vi.fn<SkillsRemote['inventory']>()
      .mockResolvedValueOnce({ ok: false, error: { message: 'no registry' } })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, value: { skills: [entry('alpha')] } })
    const controller = new SkillsController(fakeRemote({ inventory }), scope)
    const store = controller.inject().hooks.skills
    await controller.refresh()
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', error: 'no registry' })
    await controller.refresh()
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', error: 'Error: offline' })
    await controller.refresh()
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', error: undefined })
  })

  it('drops a superseded read', async () => {
    const { scope } = fakeScope([])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const inventory = vi.fn<SkillsRemote['inventory']>()
      .mockImplementationOnce(async () => {
        await gate
        return { ok: true, value: { skills: [entry('stale')] } }
      })
      .mockResolvedValueOnce({ ok: true, value: { skills: [entry('fresh')] } })
    const controller = new SkillsController(fakeRemote({ inventory }), scope)
    const first = controller.refresh()
    await controller.refresh()
    release()
    await first
    expect(controller.inject().hooks.skills.getSnapshot().rows.map(row => row.name)).toEqual(['fresh'])
  })

  it('ignores a failed read after the controller stopped', async () => {
    const { scope } = fakeScope([])
    let fail!: (error: Error) => void
    const inventory = vi.fn<SkillsRemote['inventory']>(() => new Promise((_resolve, reject) => { fail = reject }))
    const controller = new SkillsController(fakeRemote({ inventory }), scope)
    const stop = controller.start()
    const pending = controller.refresh()
    stop()
    fail(new Error('late'))
    await pending
    expect(controller.inject().hooks.skills.getSnapshot().phase).toBe('loading')
  })

  it('adds a directory and surfaces the Host refusal', async () => {
    const { scope } = fakeScope([])
    const add = vi.fn<SkillsRemote['add']>()
      .mockResolvedValueOnce({ ok: false, error: { message: 'no SKILL.md found' } })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, value: { skills: [entry('gamma')] } })
    const controller = new SkillsController(fakeRemote({ add }), scope)
    const face = controller.inject()
    expect(await face.add('/x')).toBe(false)
    expect(face.hooks.skills.getSnapshot()).toMatchObject({ adding: false, actionError: 'no SKILL.md found' })
    expect(await face.add('/x')).toBe(false)
    expect(face.hooks.skills.getSnapshot().actionError).toBe('Error: offline')
    expect(await face.add('/x')).toBe(true)
    expect(face.hooks.skills.getSnapshot().rows.map(row => row.name)).toEqual(['gamma'])
  })

  it('treats a scope without a value as nothing disabled and not writable', async () => {
    const set = vi.fn(async () => {})
    const scope = {
      getSnapshot: () => ({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: true }),
      subscribe: () => () => {},
      set,
    } as unknown as ConfigForm<SkillsSettings>
    const controller = new SkillsController(fakeRemote(), scope)
    await controller.refresh()
    const state = controller.inject().hooks.skills.getSnapshot()
    expect(state.writable).toBe(false)
    expect(state.rows.every(row => row.enabled)).toBe(true)
    await controller.inject().setEnabled('alpha', false)
    expect(set).toHaveBeenCalledWith('disabled', ['alpha'])
  })

  it('is read-only until the scope is ready and writable', () => {
    const { scope } = fakeScope([], false)
    const controller = new SkillsController(fakeRemote(), scope)
    const stop = controller.start()
    expect(controller.inject().hooks.skills.getSnapshot().writable).toBe(false)
    stop()
  })
})
