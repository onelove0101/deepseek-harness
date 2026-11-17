/**
 * Connections service: OAuth-backed connector registry with MCP fleet hooks.
 * @module @deepseek-ai/dsh-connections
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { promises as streamPromises } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import {
  BUILTIN_CONNECTORS, CONNECTOR_IDS, connectorOf, type ConnectorDefinition,
} from './connectors.ts'
import {
  buildAuthorizeUrl, createOAuthState, createPkcePair, exchangeAuthorizationCode, statesEqual,
} from './google-oauth.ts'
import type { ConnectorId, ConnectorPhase, ConnectorView } from './types.ts'
// Side-effect: `ctx.mcpManager` on host Context.
import type {} from '@deepseek-ai/dsh-mcp-manager'
import type {} from '@deepseek-ai/dsh-host-webserver'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** OAuth connector registry and MCP registration. */
    connections: ConnectionsService
  }
}

/** OAuth grant stored under `connections/google-sheets`. */
const googleGrant = zod.object({
  version: zod.literal(1),
  accessToken: zod.string().min(1),
  refreshToken: zod.string().optional(),
  expiresAt: zod.number().optional(),
  scope: zod.string().optional(),
})

/** Deployment-specific Google OAuth client configuration. */
export interface Config {
  /** Google OAuth client id (public PKCE client). */
  googleOAuthClientId?: string
  /** Optional client secret when using a confidential client. */
  googleOAuthClientSecret?: string
  /** Upper bound for one connect attempt in milliseconds. */
  attemptTimeoutMs?: number
}

const ConfigSchema = z.object({
  googleOAuthClientId: z.string().default(''),
  googleOAuthClientSecret: z.string().default(''),
  attemptTimeoutMs: z.number().min(1).max(3_600_000).default(600_000),
}) as z<Config, { googleOAuthClientId: string; googleOAuthClientSecret: string; attemptTimeoutMs: number }>

class ConnectionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionsError'
  }
}

interface ActiveAttempt {
  connector: ConnectorDefinition
  origin: string
  controller: AbortController
  done: Promise<void>
  phase: ConnectorPhase
  authorizeUrl?: string
  error?: string
  callback?: ServerResponse
  disposeRoute?: () => Promise<void>
}

/**
 * Host-side connector registry: lists built-ins, runs Google OAuth for Sheets,
 * stores grants and MCP bearer refs, and registers the Sheets MCP server.
 */
export default class ConnectionsService extends TypertRemoteService {
  static inject = ['credentials', 'authorization', 'mcpManager']
  static Config = ConfigSchema

  private readonly clientId: string
  private readonly clientSecret: string
  private readonly attemptTimeoutMs: number
  private readonly lifetime = new AbortController()
  private readonly mcpDisposers = new Map<ConnectorId, () => void>()
  private readonly attempts = new Map<ConnectorId, ActiveAttempt>()
  private readonly watchers = new Set<() => void>()
  private closed = false

  /**
   * @param ctx - Host with credentials, authorization, and MCP manager.
   * @param config - OAuth client configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'connections')
    const resolved = ConfigSchema(config)
    this.clientId = resolved.googleOAuthClientId
    this.clientSecret = resolved.googleOAuthClientSecret
    this.attemptTimeoutMs = resolved.attemptTimeoutMs

    for (const definition of Object.values(BUILTIN_CONNECTORS)) {
      ctx.authorization.registerFlow({
        key: definition.grantKey,
        label: definition.label,
        methods: [{ id: 'browser', label: definition.label }],
        run: (session) => {
          const attempt = [...this.attempts.values()].find(row => row.connector.grantKey === definition.grantKey)
          if (attempt === undefined) return Promise.reject(new ConnectionsError('connections: no active attempt'))
          return this.runOAuth(session, attempt)
        },
      })
    }

    ctx.on('credentials/record-updated', (key) => {
      const definition = Object.values(BUILTIN_CONNECTORS).find(row => row.grantKey === key)
      if (definition === undefined) return
      void this.syncConnector(definition)
    })

    ctx.effect(() => async () => {
      this.closed = true
      this.lifetime.abort()
      for (const attempt of [...this.attempts.values()]) {
        attempt.controller.abort()
        this.ctx.authorization.cancel(attempt.connector.grantKey)
        await attempt.done.catch(() => undefined)
      }
      this.attempts.clear()
      for (const dispose of this.mcpDisposers.values()) dispose()
      this.mcpDisposers.clear()
      this.changed()
    }, 'connections: service lifetime')
  }

  async [Service.init](): Promise<void> {
    for (const id of CONNECTOR_IDS) {
      const definition = BUILTIN_CONNECTORS[id]
      await this.syncConnector(definition)
    }
  }

  /**
   * List every built-in connector and its live phase.
   * @returns connector views in registry order.
   */
  @Remote
  list(): ConnectorView[] {
    return CONNECTOR_IDS.map(id => this.viewOf(id))
  }

  /**
   * Read one connector.
   * @param id - connector id.
   * @returns the connector view.
   */
  @Remote
  get(id: ConnectorId): ConnectorView {
    if (connectorOf(id) === undefined) throw new ConnectionsError(`connections: unknown connector "${id}"`)
    return this.viewOf(id)
  }

  /**
   * Start OAuth for a connector and register its MCP server on success.
   * @param id - connector id.
   * @param callbackOrigin - browser loopback origin that receives `/connections/oauth/callback`.
   * @returns initial snapshot with `authorizeUrl` when the flow starts.
   */
  @Remote
  async connect(id: ConnectorId, callbackOrigin: string): Promise<ConnectorView> {
    const definition = connectorOf(id)
    if (definition === undefined) throw new ConnectionsError(`connections: unknown connector "${id}"`)
    if (this.clientId === '') throw new ConnectionsError('connections: configure googleOAuthClientId before connecting')
    const origin = this.parseCallbackOrigin(callbackOrigin)
    const existing = this.attempts.get(id)
    if (existing !== undefined && existing.phase === 'connecting') return this.viewOf(id)
    if (existing !== undefined) {
      existing.controller.abort()
      this.ctx.authorization.cancel(definition.grantKey)
      await existing.done.catch(() => undefined)
    }
    const attempt: ActiveAttempt = {
      connector: definition,
      origin,
      controller: new AbortController(),
      done: Promise.resolve(),
      phase: 'connecting',
    }
    this.attempts.set(id, attempt)
    attempt.done = this.ctx.authorization.begin({
      key: definition.grantKey,
      signal: attempt.controller.signal,
      interaction: {
        notify: (notice) => {
          if (notice.url !== undefined) {
            attempt.authorizeUrl = notice.url
            this.changed()
          }
        },
        prompt: () => Promise.reject(new ConnectionsError('connections: interactive prompts are unsupported')),
      },
    }).then((outcome) => {
      if (outcome.status === 'authorized') {
        attempt.phase = 'connected'
        delete attempt.authorizeUrl
        delete attempt.error
      } else {
        attempt.phase = 'disconnected'
        delete attempt.authorizeUrl
      }
      if (attempt.callback !== undefined) {
        attempt.callback.writeHead(204, { 'cache-control': 'no-store' }).end()
      }
    }).catch((error: unknown) => {
      attempt.phase = 'failed'
      attempt.error = error instanceof Error ? error.message : String(error)
      delete attempt.authorizeUrl
      if (attempt.callback !== undefined) {
        attempt.callback.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end('<!doctype html><html><body><p>Connection failed. You may close this tab.</p></body></html>')
      }
    }).finally(async () => {
      await attempt.disposeRoute?.()
      this.attempts.delete(id)
      await this.syncConnector(definition)
      this.changed()
    })
    this.changed()
    return this.viewOf(id)
  }

  /**
   * Remove stored credentials and unregister the connector MCP server.
   * @param id - connector id.
   * @returns view after teardown.
   */
  @Remote
  async disconnect(id: ConnectorId): Promise<ConnectorView> {
    const definition = connectorOf(id)
    if (definition === undefined) throw new ConnectionsError(`connections: unknown connector "${id}"`)
    const attempt = this.attempts.get(id)
    if (attempt !== undefined) {
      attempt.controller.abort()
      this.ctx.authorization.cancel(definition.grantKey)
      await attempt.done.catch(() => undefined)
    }
    this.unmountMcp(id)
    await this.ctx.credentials.deleteRecord(definition.grantKey)
    await this.ctx.credentials.unset(definition.accessRef)
    this.changed()
    return this.viewOf(id)
  }

  /**
   * Stream connector list updates for Settings.
   * @param signal - subscription lifetime.
   * @returns snapshots until abort or service disposal.
   */
  @Remote({ mode: 'stream' })
  async* watch(signal: AbortSignal): AsyncIterable<ConnectorView[]> {
    const ended = AbortSignal.any([signal, this.lifetime.signal])
    let wake = Promise.withResolvers<void>()
    let dirty = true
    const notify = (): void => { dirty = true; wake.resolve() }
    this.watchers.add(notify)
    ended.addEventListener('abort', notify, { once: true })
    try {
      while (!ended.aborted) {
        if (!dirty) await wake.promise
        if (ended.aborted) break
        dirty = false
        wake = Promise.withResolvers<void>()
        yield this.list()
      }
    } finally {
      this.watchers.delete(notify)
      ended.removeEventListener('abort', notify)
    }
  }

  private viewOf(id: ConnectorId): ConnectorView {
    const definition = BUILTIN_CONNECTORS[id]
    const attempt = this.attempts.get(id)
    const oauthConfigured = this.clientId !== ''
    if (attempt !== undefined) {
      return {
        id,
        label: definition.label,
        phase: attempt.phase,
        oauthConfigured,
        ...attempt.authorizeUrl === undefined ? {} : { authorizeUrl: attempt.authorizeUrl },
        ...attempt.error === undefined ? {} : { error: attempt.error },
      }
    }
    return {
      id,
      label: definition.label,
      phase: this.mcpDisposers.has(id) ? 'connected' : 'disconnected',
      oauthConfigured,
    }
  }

  private changed(): void {
    if (this.closed) return
    for (const notify of this.watchers) notify()
  }

  private async syncConnector(definition: ConnectorDefinition): Promise<void> {
    const record = await this.ctx.credentials.readRecord(definition.grantKey)
    if (record === undefined) {
      this.unmountMcp(definition.id)
      return
    }
    if (record.kind !== 'grant') throw new ConnectionsError('connections: stored credential has unexpected kind')
    const parsed = googleGrant.safeParse(record.payload)
    if (!parsed.success) throw new ConnectionsError('connections: stored grant is invalid')
    await this.ctx.credentials.set(definition.accessRef, parsed.data.accessToken)
    this.mountMcp(definition)
    this.changed()
  }

  private mountMcp(definition: ConnectorDefinition): void {
    if (this.mcpDisposers.has(definition.id)) return
    const dispose = this.ctx.mcpManager.register(definition.mcpServerName, {
      transport: 'streamable-http',
      url: definition.mcpUrl,
      headers: {
        Authorization: 'Bearer ' + '${credential:' + String(definition.accessRef) + '}',
      },
    })
    this.mcpDisposers.set(definition.id, dispose)
  }

  private unmountMcp(id: ConnectorId): void {
    const dispose = this.mcpDisposers.get(id)
    if (dispose === undefined) return
    dispose()
    this.mcpDisposers.delete(id)
  }

  private parseCallbackOrigin(value: string): string {
    let url: URL
    try { url = new URL(value) } catch { throw new ConnectionsError('connections: callbackOrigin must be a valid URL') }
    const explicitPort = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/i.exec(value)?.[1]
    if (explicitPort === undefined || Number(explicitPort) === 0
      || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new ConnectionsError('connections: callbackOrigin must be loopback HTTP with an explicit port')
    }
    return `${url.protocol}//${url.hostname}:${Number(explicitPort)}`
  }

  private async runOAuth(session: AuthorizationSession, attempt: ActiveAttempt): Promise<void> {
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new ConnectionsError('connections: webserver is required for OAuth')
    const { verifier, challenge } = createPkcePair()
    const state = createOAuthState()
    const redirectUri = `${attempt.origin}/connections/oauth/callback`
    const code = Promise.withResolvers<string>()
    void code.promise.catch(() => undefined)
    const deadline = new AbortController()
    const signal = AbortSignal.any([session.signal, deadline.signal])
    const timer = setTimeout(() => { deadline.abort() }, this.attemptTimeoutMs)
    const abort = (): void => { code.reject(new ConnectionsError('connections: attempt expired')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      attempt.disposeRoute = this.ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/connections/oauth/callback',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          let url: URL
          try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch {
            res.writeHead(400, { 'cache-control': 'no-store' }).end()
            return
          }
          const receivedCode = url.searchParams.get('code')
          const receivedState = url.searchParams.get('state') ?? ''
          if (req.method !== 'GET' || url.pathname !== '/connections/oauth/callback' || receivedCode === null
            || !statesEqual(state, receivedState)
            || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) {
            res.writeHead(400, { 'cache-control': 'no-store' }).end()
            return
          }
          if (signal.aborted || attempt.callback !== undefined) {
            res.writeHead(410, { 'cache-control': 'no-store' }).end()
            return
          }
          attempt.callback = res
          code.resolve(receivedCode)
        },
      }), 'connections: oauth callback')
      const authorizeUrl = buildAuthorizeUrl({
        clientId: this.clientId,
        redirectUri,
        state,
        challenge,
        scopes: attempt.connector.oauthScopes,
      })
      session.notify({ message: 'Continue in your browser to authorize Google Sheets', url: authorizeUrl })
      const receivedCode = await code.promise
      signal.throwIfAborted()
      const tokens = await exchangeAuthorizationCode({
        code: receivedCode,
        verifier,
        clientId: this.clientId,
        ...this.clientSecret === '' ? {} : { clientSecret: this.clientSecret },
        redirectUri,
      })
      const expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000
      const record: CredentialRecord = {
        kind: 'grant',
        payload: {
          version: 1,
          accessToken: tokens.access_token,
          ...tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token },
          ...expiresAt === undefined ? {} : { expiresAt },
          ...tokens.scope === undefined ? {} : { scope: tokens.scope },
        },
      }
      await session.commit(record)
      await this.ctx.credentials.set(attempt.connector.accessRef, tokens.access_token)
      this.mountMcp(attempt.connector)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (attempt.callback !== undefined) {
        await streamPromises.finished(attempt.callback, { cleanup: true }).catch(() => undefined)
      }
    }
  }
}
