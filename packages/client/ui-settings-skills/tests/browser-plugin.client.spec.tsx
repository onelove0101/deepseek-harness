// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { SkillsSection } from '../src/client/SkillsSection.tsx'
import type { SkillsFace } from '../src/client/controller.ts'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const inventory = vi.fn(async () => ({ ok: true, value: { skills: [] } }))
  const remote = new TestRemote(ctx, { skills: { inventory, add: vi.fn() } })
  const get = vi.fn(() => ({
    getSnapshot: () => ({ status: 'ready', value: { disabled: [] }, writable: true }),
    subscribe: () => () => {},
    set: vi.fn(),
  }))
  ctx.provide('configForms', { get })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, inventory, get, remote }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-skills browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services used by the page', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.skills', 'configForms'])
  })

  it('registers the Skills page between Agent presets and Archived sessions with localized copy', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    expect(b.get).toHaveBeenCalledWith('skill')
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(SkillsSection)
    expect(entry.options).toMatchObject({ id: 'skills', order: 22 })
    expect(entry.locale).toBe('settings.skills')
    expect(resolveSlotLabel(entry.options.label)).toBe('技能')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Skills')

    const face = (entry.inject as unknown as () => SkillsFace)()
    expect(face.hooks.skills.getSnapshot().writable).toBe(true)
    // Nothing is read until the page asks, and a reconnect before that stays silent.
    b.ctx.emit('connection/reset')
    expect(b.inventory).not.toHaveBeenCalled()

    await face.load()
    expect(b.inventory).toHaveBeenCalledTimes(1)
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.inventory).toHaveBeenCalledTimes(2) })
    await b.ctx.fiber.dispose()
  })
})
