/** Browser tab helper for connector OAuth URLs. */

import type { ConnectorView } from '@deepseek-ai/dsh-connections/types'

/** Opens and follows one connector authorization attempt in a browser tab. */
export class ConnectorBrowserLogin {
  private popup: Window | null = null
  private navigated = false
  private connectorId: string | undefined

  /** Preopen a tab during the user's click. */
  begin(): void {
    this.dispose()
    this.popup = window.open('about:blank', '_blank')
    if (this.popup) this.popup.opener = null
  }

  /**
   * Navigate when an authorize URL appears on the matching connector row.
   * @param rows - latest connector list from watch/list.
   */
  update(rows: readonly ConnectorView[]): void {
    const row = rows.find(candidate => candidate.id === this.connectorId)
    if (row === undefined) return
    if (row.phase === 'connected' || row.phase === 'disconnected') {
      if (!this.navigated) this.popup?.close()
      this.popup = null
      this.connectorId = undefined
      this.navigated = false
      return
    }
    if (row.phase === 'failed') {
      this.dispose()
      return
    }
    if (row.authorizeUrl === undefined || this.navigated) return
    this.navigated = true
    if (this.popup && !this.popup.closed) this.popup.location.replace(row.authorizeUrl)
  }

  /**
   * Bind this helper to one connector id before calling connect.
   * @param id - connector id.
   */
  follow(id: string): void {
    this.connectorId = id
    this.navigated = false
  }

  /** Close any owned tab. */
  dispose(): void {
    this.popup?.close()
    this.popup = null
    this.connectorId = undefined
    this.navigated = false
  }
}
