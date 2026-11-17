/** Google OAuth 2.0 helpers (PKCE) for the Google Sheets connector. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** OAuth scopes required for the Sheets MCP endpoint. */
export const GOOGLE_SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
]

export interface PkcePair {
  verifier: string
  challenge: string
}

/** Create an S256 PKCE verifier/challenge pair. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Create a random OAuth state value. */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url')
}

/** Compare two OAuth state strings in constant time. */
export function statesEqual(expected: string, received: string): boolean {
  if (Buffer.byteLength(expected) !== Buffer.byteLength(received)) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received))
}

export interface TokenResponse {
  access_token: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  token_type?: string
}

/**
 * Exchange an authorization code for tokens.
 * @param input - token endpoint parameters.
 * @param fetchImpl - injectable fetch for tests.
 * @returns parsed token response.
 */
export async function exchangeAuthorizationCode(input: {
  code: string
  verifier: string
  clientId: string
  clientSecret?: string
  redirectUri: string
}, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.verifier,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
  })
  if (input.clientSecret !== undefined && input.clientSecret !== '') {
    body.set('client_secret', input.clientSecret)
  }
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) {
    throw new Error(`google-oauth: token exchange failed (${String(response.status)})`)
  }
  const json: unknown = await response.json()
  if (typeof json !== 'object' || json === null || typeof (json as { access_token?: unknown }).access_token !== 'string') {
    throw new Error('google-oauth: token response missing access_token')
  }
  return json as TokenResponse
}

/**
 * Build the Google authorization URL for a PKCE flow.
 * @param input - client, redirect, PKCE, and scope parameters.
 * @returns absolute authorize URL.
 */
export function buildAuthorizeUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  challenge: string
  scopes: readonly string[]
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', input.scopes.join(' '))
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.href
}
