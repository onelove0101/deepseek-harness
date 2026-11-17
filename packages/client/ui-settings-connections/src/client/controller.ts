/** Connections settings page state backed by the connections Remote watch stream. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectorId, ConnectorView } from '@deepseek-ai/dsh-connections/types'

type ConnectionsRemote = ClientRemote['connections']

/** Frames decoded from the watch stream. */
export type ConnectionsWatch = (signal: AbortSignal) => AsyncIterable<ConnectorView[]>

export interface ConnectionsState {
  phase: 'loading' | 'ready' | 'error'
  rows: ConnectorView[]
  error: string | undefined
  busyId: ConnectorId | undefined
  actionError: string | undefined
}

export interface ConnectionsFace {
  hooks: {
    connections: SnapshotStore<ConnectionsState>
  }
  connect(id: ConnectorId): Promise<void>
  disconnect(id: ConnectorId): Promise<void>
  load(): Promise<void>
}

/** Subscribes to `connections.watch` and exposes connect/disconnect actions. */
export class ConnectionsController {
  private readonly store = createSnapshotStore<ConnectionsState>({
    phase: 'loading', rows: [], error: undefined, busyId: undefined, actionError: undefined,
  })

  /**
   * @param remote - generated `connections` namespace.
   * @param watch - stream opened by the apply closure through `remote.$stream`.
   */
  constructor(
    private readonly remote: ConnectionsRemote,
    private readonly watch: ConnectionsWatch,
  ) {}

  /** Start the watch stream; returns a disposer. */
  start(): () => void {
    const abort = new AbortController()
    void this.pump(abort.signal)
    return () => { abort.abort() }
  }

  async reload(): Promise<void> {
    const result = await this.remote.list()
    if (result.ok) {
      this.store.update((draft) => { draft.phase = 'ready'; draft.rows = result.value; draft.error = undefined })
    } else {
      this.store.update((draft) => { draft.phase = 'error'; draft.error = result.error.message })
    }
  }

  inject(): ConnectionsFace {
    return {
      hooks: { connections: this.store },
      connect: id => this.connect(id),
      disconnect: id => this.disconnect(id),
      load: () => this.reload(),
    }
  }

  private loopbackOrigin(): string {
    return `${window.location.protocol}//${window.location.host}`
  }

  private async connect(id: ConnectorId): Promise<void> {
    this.store.update((draft) => { draft.busyId = id; draft.actionError = undefined })
    try {
      const result = await this.remote.connect(id, this.loopbackOrigin())
      if (!result.ok) {
        this.store.update((draft) => { draft.actionError = result.error.message; draft.busyId = undefined })
        return
      }
      this.store.update((draft) => {
        draft.rows = draft.rows.map(row => row.id === id ? result.value : row)
        draft.busyId = undefined
      })
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.actionError = error instanceof Error ? error.message : String(error)
        draft.busyId = undefined
      })
    }
  }

  private async disconnect(id: ConnectorId): Promise<void> {
    this.store.update((draft) => { draft.busyId = id; draft.actionError = undefined })
    try {
      const result = await this.remote.disconnect(id)
      if (!result.ok) {
        this.store.update((draft) => { draft.actionError = result.error.message; draft.busyId = undefined })
        return
      }
      this.store.update((draft) => {
        draft.rows = draft.rows.map(row => row.id === id ? result.value : row)
        draft.busyId = undefined
      })
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.actionError = error instanceof Error ? error.message : String(error)
        draft.busyId = undefined
      })
    }
  }

  private async pump(signal: AbortSignal): Promise<void> {
    try {
      for await (const rows of this.watch(signal)) {
        if (signal.aborted) return
        this.store.update((draft) => { draft.phase = 'ready'; draft.rows = rows; draft.error = undefined })
      }
    } catch (error: unknown) {
      if (signal.aborted) return
      this.store.update((draft) => { draft.phase = 'error'; draft.error = String(error) })
    }
  }
}
