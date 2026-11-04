/**
 * Session Controller permanent deletion: the live-session refusal, the registry
 * delete plus projection-cache cleanup order, error mapping, and the
 * `api-session/removed` notification that tells clients the Session is gone.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionTestRemote } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

async function composed(options: {
  deleteSession?: (id: SessionId) => Promise<void>
  forget?: (id: SessionId) => Promise<void>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const deleteSession = vi.fn(options.deleteSession ?? (async () => {}))
  const forget = vi.fn(options.forget ?? (async () => {}))
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [], deleteSession } as never)
  ctx.provide('sessionProjectionCache', { forget } as never)
  const removed: SessionId[] = []
  ctx.on('api-session/removed', (id) => { removed.push(id) })
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
  return { ctx, remote, deleteSession, forget, removed }
}

describe('sessions.deleteSession', () => {
  it('erases through the registry, forgets the projection record, and announces the removal', async () => {
    const { remote, deleteSession, forget, removed } = await composed()

    const result = await remote.deleteSession({ sessionId: sid('cold') })

    expect(result).toEqual({ ok: true, value: { sessionId: 'cold' } })
    expect(deleteSession).toHaveBeenCalledWith('cold')
    expect(forget).toHaveBeenCalledWith('cold')
    expect(removed).toEqual(['cold'])
  })

  it('refuses a Session that is live in this Host without touching storage', async () => {
    const { ctx, remote, deleteSession, removed } = await composed()
    const session = ctx.sessions.create(sid('live'), { meta: { cwd: '/proj' } })
    await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)

    const result = await remote.deleteSession({ sessionId: sid('live') })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('session/active')
    expect(deleteSession).not.toHaveBeenCalled()
    expect(removed).toEqual([])
  })

  it('maps a persistence ownership conflict to session/active and announces nothing', async () => {
    const { remote, removed } = await composed({
      deleteSession: async (id) => { throw new SessionAlreadyOwnedError(id) },
    })

    const result = await remote.deleteSession({ sessionId: sid('owned-elsewhere') })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('session/active')
    expect(removed).toEqual([])
  })

  it('reports any other storage failure as an internal error', async () => {
    const { remote, forget } = await composed({
      deleteSession: async () => { throw new Error('disk on fire') },
    })

    const result = await remote.deleteSession({ sessionId: sid('broken') })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('gateway/internal')
    expect(result.error.message).toContain('disk on fire')
    expect(forget).not.toHaveBeenCalled()
  })

  it('still succeeds when the projection-cache cleanup fails', async () => {
    const { remote, removed } = await composed({
      forget: async () => { throw new Error('cache offline') },
    })

    const result = await remote.deleteSession({ sessionId: sid('cache-fails') })

    expect(result.ok).toBe(true)
    expect(removed).toEqual(['cache-fails'])
  })

  it('deletes without a projection cache mounted', async () => {
    const { ctx, remote, forget, removed } = await composed()
    ctx.sessionProjectionCache = undefined as never

    const result = await remote.deleteSession({ sessionId: sid('no-cache') })

    expect(result.ok).toBe(true)
    expect(forget).not.toHaveBeenCalled()
    expect(removed).toEqual(['no-cache'])
  })
})
