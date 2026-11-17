/** Built-in connector registry metadata. */

import { credentialKey, credentialRef, type CredentialKey, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ConnectorId } from './types.ts'

export const GOOGLE_SHEETS_MCP_URL = 'https://sheetsmcp.googleapis.com/mcp/v1'
export const GOOGLE_SHEETS_MCP_SERVER = 'google-sheets'

/** Stored grant for Google Sheets OAuth. */
export const GOOGLE_SHEETS_KEY = credentialKey('connections', 'google-sheets')

/** Bearer header template target for the Sheets MCP HTTP transport. */
export const GOOGLE_SHEETS_ACCESS_REF = credentialRef('GOOGLE_SHEETS_MCP_ACCESS')

/** Static definition of one built-in connector. */
export interface ConnectorDefinition {
  id: ConnectorId
  label: string
  grantKey: CredentialKey
  accessRef: CredentialRef
  mcpServerName: string
  mcpUrl: string
  oauthScopes: readonly string[]
}

/** Registry of built-in connectors keyed by id. */
export const BUILTIN_CONNECTORS: Record<ConnectorId, ConnectorDefinition> = {
  'google-sheets': {
    id: 'google-sheets',
    label: 'Google Sheets',
    grantKey: GOOGLE_SHEETS_KEY,
    accessRef: GOOGLE_SHEETS_ACCESS_REF,
    mcpServerName: GOOGLE_SHEETS_MCP_SERVER,
    mcpUrl: GOOGLE_SHEETS_MCP_URL,
    oauthScopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  },
}

/** Ordered list of built-in connector ids. */
export const CONNECTOR_IDS = Object.keys(BUILTIN_CONNECTORS) as ConnectorId[]

/**
 * Resolve a connector definition.
 * @param id - connector id.
 * @returns definition when registered.
 */
export function connectorOf(id: string): ConnectorDefinition | undefined {
  if (!Object.hasOwn(BUILTIN_CONNECTORS, id)) return undefined
  return BUILTIN_CONNECTORS[id as ConnectorId]
}
