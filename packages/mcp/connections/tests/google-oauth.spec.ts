import { describe, expect, it, vi } from 'vitest'
import {
  buildAuthorizeUrl, createPkcePair, exchangeAuthorizationCode, statesEqual,
} from '../src/google-oauth.ts'

describe('google-oauth helpers', () => {
  it('builds an authorize URL with PKCE parameters', () => {
    const { challenge } = createPkcePair()
    const url = new URL(buildAuthorizeUrl({
      clientId: 'client-id',
      redirectUri: 'http://127.0.0.1:3080/connections/oauth/callback',
      state: 'state-value',
      challenge,
      scopes: ['scope-a'],
    }))
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('scope-a')
  })

  it('compares oauth state safely', () => {
    expect(statesEqual('abc', 'abc')).toBe(true)
    expect(statesEqual('abc', 'abd')).toBe(false)
  })

  it('exchanges an authorization code through fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'token-1' }), { status: 200 }))
    const tokens = await exchangeAuthorizationCode({
      code: 'code-1',
      verifier: 'verifier',
      clientId: 'client-id',
      redirectUri: 'http://127.0.0.1:3080/connections/oauth/callback',
    }, fetchImpl as typeof fetch)
    expect(tokens.access_token).toBe('token-1')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
