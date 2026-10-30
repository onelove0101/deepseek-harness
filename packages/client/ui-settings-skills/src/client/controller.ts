/** Skills page state: the host inventory joined with the settings-backed disabled list. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SkillInventoryEntry, SkillInventoryValue } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Namespace of the skill preferences. Spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const SKILLS_NS = 'skills'

/** Skill preference fields this page edits. */
export interface SkillsSettings {
  /** Names of skills hidden from the model and the `/` menu. */
  disabled: string[]
}

/** Result envelope of one Remote call, as the generated client returns it. */
type RemoteResult<T> = Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>

/** Remote calls the page needs. */
export interface SkillsRemote {
  inventory(request: Record<string, never>, signal: AbortSignal): RemoteResult<SkillInventoryValue>
  add(request: { path: string }, signal: AbortSignal): RemoteResult<SkillInventoryValue>
}

/** One row the page renders. */
export interface SkillRow extends SkillInventoryEntry {
  /** Whether the skill is advertised; follows the live settings value, not the last inventory read. */
  enabled: boolean
}

/** What the page renders. */
export interface SkillsState {
  phase: 'loading' | 'ready' | 'error'
  rows: SkillRow[]
  /** Whether the settings document accepts writes (false for remote browsers in memory mode). */
  writable: boolean
  /** Inventory read failure message. */
  error: string | undefined
  /** Whether an Add skill request is in flight. */
  adding: boolean
  /** Last Add skill or toggle failure message. */
  actionError: string | undefined
}

/** The registration-side face the page's slot entry injects. */
export interface SkillsFace {
  hooks: {
    /** Page snapshot bound by the renderer as useSkills. */
    skills: SnapshotStore<SkillsState>
  }
  /**
   * Enable or disable one skill.
   * @param name - skill name.
   * @param enabled - requested state.
   */
  setEnabled(name: string, enabled: boolean): Promise<void>
  /** Read the inventory; the page calls it on mount so a session that never opens the page pays no request. */
  load(): Promise<void>
  /**
   * Add a directory that contains `SKILL.md`.
   * @param path - absolute directory path.
   * @returns whether the directory was added.
   */
  add(path: string): Promise<boolean>
}

/** Bridges the Host inventory Remote and the `skills` settings scope onto one page store. */
export class SkillsController {
  private readonly store = createSnapshotStore<SkillsState>({
    phase: 'loading', rows: [], writable: false, error: undefined, adding: false, actionError: undefined,
  })
  private inventory: readonly SkillInventoryEntry[] = []
  private pending: AbortController | undefined
  private loaded = false

  /**
   * @param remote - generated `skills` Remote namespace.
   * @param scope - bound settings scope for the `skills` namespace.
   */
  constructor(
    private readonly remote: SkillsRemote,
    private readonly scope: SettingsScope<SkillsSettings>,
  ) {}

  /**
   * Start observing the settings scope.
   * @returns a disposer that stops the observation and any pending read.
   */
  start(): () => void {
    const stop = this.scope.subscribe(() => { this.project() })
    this.project()
    return () => {
      stop()
      this.pending?.abort()
    }
  }

  /** Read the inventory again after a reconnect, only when the page has read it before. */
  async reload(): Promise<void> {
    if (this.loaded) await this.refresh()
  }

  /** Read the inventory, superseding any read in flight. */
  async refresh(): Promise<void> {
    this.loaded = true
    this.pending?.abort()
    const abort = new AbortController()
    this.pending = abort
    try {
      const result = await this.remote.inventory({}, abort.signal)
      if (abort.signal.aborted) return
      if (result.ok) {
        this.inventory = result.value.skills
        this.store.update((draft) => { draft.phase = 'ready'; draft.error = undefined })
      } else {
        this.store.update((draft) => { draft.phase = 'error'; draft.error = result.error.message })
      }
    } catch (error: unknown) {
      if (abort.signal.aborted) return
      this.store.update((draft) => { draft.phase = 'error'; draft.error = String(error) })
    }
    this.project()
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page snapshot and its actions.
   */
  inject(): SkillsFace {
    return {
      hooks: { skills: this.store },
      setEnabled: (name, enabled) => this.setEnabled(name, enabled),
      load: () => this.refresh(),
      add: path => this.add(path),
    }
  }

  private disabled(): string[] {
    return this.scope.getSnapshot().value?.disabled ?? []
  }

  private project(): void {
    const snapshot = this.scope.getSnapshot()
    const disabled = new Set(snapshot.value?.disabled ?? [])
    this.store.update((draft) => {
      draft.rows = this.inventory.map(entry => ({ ...entry, enabled: !disabled.has(entry.name) }))
      draft.writable = snapshot.writable && snapshot.status === 'ready'
    })
  }

  private async setEnabled(name: string, enabled: boolean): Promise<void> {
    const rest = this.disabled().filter(candidate => candidate !== name)
    try {
      await this.scope.set('disabled', enabled ? rest : [...rest, name])
      this.store.update((draft) => { draft.actionError = undefined })
    } catch (error: unknown) {
      this.store.update((draft) => { draft.actionError = error instanceof Error ? error.message : String(error) })
    }
  }

  private async add(path: string): Promise<boolean> {
    this.store.update((draft) => { draft.adding = true; draft.actionError = undefined })
    try {
      const result = await this.remote.add({ path }, new AbortController().signal)
      if (result.ok) {
        this.inventory = result.value.skills
        this.store.update((draft) => { draft.adding = false })
        this.project()
        return true
      }
      this.store.update((draft) => { draft.adding = false; draft.actionError = result.error.message })
    } catch (error: unknown) {
      this.store.update((draft) => { draft.adding = false; draft.actionError = String(error) })
    }
    return false
  }
}
