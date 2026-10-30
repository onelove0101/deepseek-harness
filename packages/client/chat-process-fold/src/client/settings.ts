/**
 * chat-process-fold settings: the durable `chat-process-fold.enabled` toggle
 * and its reactive policy. Everything reads JSON-compatible values; the policy
 * keeps the exposed `enabled` store stable until the value actually moves.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Durable settings namespace owned by this plugin. */
export const NAMESPACE = 'chat-process-fold'

/** Field name of the enable switch. */
export const ENABLED_FIELD = 'enabled'

/** Default: the fold box is enabled. */
export const DEFAULT_ENABLED = true

/** Durable chat-process-fold settings section. */
export interface ChatProcessFoldSettings {
  readonly enabled: boolean
}

/**
 * Live, persisted enable preference. Defaults on and adopts the durable Host
 * section once it arrives.
 */
export class ProcessFoldPolicy {
  /** Reactive enable state; defaults to on before Host settings arrive. */
  readonly enabled: SnapshotStore<boolean> = createSnapshotStore(DEFAULT_ENABLED)

  /**
   * @param host - durable chat-process-fold settings scope.
   */
  constructor(private readonly host: SettingsScope<ChatProcessFoldSettings>) {
    host.subscribe(() => { this.adopt() })
    this.adopt()
  }

  /**
   * Publish and persist one explicit user choice.
   * @param value - whether the fold box is enabled.
   */
  setEnabled(value: boolean): void {
    if (this.enabled.getSnapshot() === value) return
    this.enabled.set(value)
    void this.host.set(ENABLED_FIELD, value)
  }

  /** Adopt the latest accepted Host section without writing it back. */
  private adopt(): void {
    const value = this.host.getSnapshot().value?.enabled
    if (value === undefined || this.enabled.getSnapshot() === value) return
    this.enabled.set(value)
  }
}
