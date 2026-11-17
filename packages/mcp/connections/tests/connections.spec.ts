import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import ConnectionsService from '../src/index.ts'
import { GOOGLE_SHEETS_KEY, GOOGLE_SHEETS_ACCESS_REF } from '../src/connectors.ts'

class MockMcpManager extends Service {
  register = vi.fn(() => () => undefined)
  constructor(ctx: Context) {
    super(ctx, 'mcpManager')
  }
}

describe('ConnectionsService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  async function harness(withGrant = false): Promise<{
    connections: ConnectionsService
    credentials: MemoryCredentials
    mcpManager: MockMcpManager
  }> {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    const credentials = ctx.get('credentials') as MemoryCredentials
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(MockMcpManager).await()
    const mcpManager = ctx.get('mcpManager') as MockMcpManager
    if (withGrant) {
      await credentials.modifyRecord(GOOGLE_SHEETS_KEY, async () => ({
        kind: 'grant',
        payload: { version: 1, accessToken: 'access-1' },
      }))
    }
    const fiber = ctx.plugin(ConnectionsService, { googleOAuthClientId: 'client' })
    await fiber.await()
    const connections = ctx.get('connections') as ConnectionsService
    return { connections, credentials, mcpManager }
  }

  it('lists google-sheets as disconnected by default', async () => {
    const { connections } = await harness()
    expect(connections.list()).toMatchObject([{ id: 'google-sheets', phase: 'disconnected' }])
  })

  it('mounts MCP after a stored grant on init', async () => {
    const { credentials, mcpManager } = await harness(true)
    expect(mcpManager.register).toHaveBeenCalledWith('google-sheets', expect.objectContaining({ transport: 'streamable-http' }))
    expect((await credentials.resolve(GOOGLE_SHEETS_ACCESS_REF))?.value).toBe('access-1')
  })

  it('disconnect removes grant, ref, and MCP registration', async () => {
    let disposed = false
    class TrackingMcpManager extends Service {
      register = vi.fn(() => () => { disposed = true })
      constructor(ctx: Context) { super(ctx, 'mcpManager') }
    }
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    const credentials = ctx.get('credentials') as MemoryCredentials
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(TrackingMcpManager).await()
    await credentials.modifyRecord(GOOGLE_SHEETS_KEY, async () => ({
      kind: 'grant',
      payload: { version: 1, accessToken: 'access-1' },
    }))
    await ctx.plugin(ConnectionsService, { googleOAuthClientId: 'client' }).await()
    const connections = ctx.get('connections') as ConnectionsService
    await connections.disconnect('google-sheets')
    expect(disposed).toBe(true)
    expect(await credentials.readRecord(GOOGLE_SHEETS_KEY)).toBeUndefined()
    expect(await credentials.resolve(GOOGLE_SHEETS_ACCESS_REF)).toBeUndefined()
  })
})
