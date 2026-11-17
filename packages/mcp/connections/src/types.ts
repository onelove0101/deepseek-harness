/** Shared types for the connections registry and Remote views. */

/** Built-in connector id; the registry is open to more entries later. */
export type ConnectorId = 'google-sheets'

/** Connection phase exposed to Settings and Remote clients. */
export type ConnectorPhase = 'disconnected' | 'connecting' | 'connected' | 'failed'

/** One connector row for list, get, and watch snapshots. */
export interface ConnectorView {
  /** Registry id. */
  id: ConnectorId
  /** User-facing label from the built-in registry. */
  label: string
  /** Current connection phase. */
  phase: ConnectorPhase
  /** Google OAuth URL while `phase` is `connecting`; omitted once the browser navigates. */
  authorizeUrl?: string
  /** Last failure message when `phase` is `failed`. */
  error?: string
  /** False when the Host has no Google OAuth client id; Connect is rejected until configured. */
  oauthConfigured: boolean
}
