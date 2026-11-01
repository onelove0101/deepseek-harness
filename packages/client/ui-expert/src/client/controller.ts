/** Experts page state: the Host library joined with the skill inventory used by the skill picker. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ExpertDeleteRequest, ExpertDocumentCreateRequest, ExpertDocumentDeleteRequest, ExpertKnowledgeBaseDeleteRequest,
  ExpertKnowledgeBaseSaveRequest, ExpertLibraryValue, ExpertListRequest, ExpertRankedEntry, ExpertRankedRequest,
  ExpertRankedValue, ExpertSaveRequest, SkillInventoryValue,
} from '@deepseek-ai/dsh-api-remotes/client'

/** Result envelope of one Remote call, as the generated client returns it. */
type RemoteResult<T> = Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>

/** Remote calls the page needs from the `experts` namespace. */
export interface ExpertsRemote {
  list: (request: ExpertListRequest, signal: AbortSignal) => RemoteResult<ExpertLibraryValue>
  ranked: (request: ExpertRankedRequest, signal: AbortSignal) => RemoteResult<ExpertRankedValue>
  saveExpert: (request: ExpertSaveRequest, signal: AbortSignal) => RemoteResult<ExpertLibraryValue>
  deleteExpert: (request: ExpertDeleteRequest, signal: AbortSignal) => RemoteResult<ExpertLibraryValue>
  createDocument: (request: ExpertDocumentCreateRequest, signal: AbortSignal) => RemoteResult<ExpertLibraryValue>
  deleteDocument: (request: ExpertDocumentDeleteRequest, signal: AbortSignal) => RemoteResult<ExpertLibraryValue>
  saveKnowledgeBase: (request: ExpertKnowledgeBaseSaveRequest, signal: AbortSignal) => RemoteResult<ExpertLibraryValue>
  deleteKnowledgeBase: (request: ExpertKnowledgeBaseDeleteRequest, signal: AbortSignal) => RemoteResult<ExpertLibraryValue>
}

/** The `skills` Remote call that lists selectable skills. */
export interface ExpertSkillsRemote {
  inventory: (request: Record<string, never>, signal: AbortSignal) => RemoteResult<SkillInventoryValue>
}

/** What the page renders. */
export interface ExpertsState {
  phase: 'loading' | 'ready' | 'error'
  /** Latest library read or mutation result. */
  library: ExpertLibraryValue | undefined
  /** Names of the skills an Expert can select. */
  skills: readonly string[]
  /** Library read failure message. */
  error: string | undefined
  /** Whether a mutation is in flight. */
  busy: boolean
  /** Last mutation failure message. */
  actionError: string | undefined
}

/** The registration-side face the page's slot entry injects. */
export interface ExpertsFace {
  hooks: {
    /** Page snapshot bound by the renderer as useExperts. */
    experts: SnapshotStore<ExpertsState>
  }
  /** Read the library and skill inventory; the page calls it on mount. */
  load(): Promise<void>
  /**
   * Create or edit an Expert.
   * @param request - Expert fields; `id` selects an edit.
   * @returns whether the Host accepted the write.
   */
  saveExpert(request: ExpertSaveRequest): Promise<boolean>
  /**
   * Delete an Expert.
   * @param id - Expert to delete.
   * @returns whether the Host accepted the delete.
   */
  deleteExpert(id: ExpertDeleteRequest['id']): Promise<boolean>
  /**
   * Store a text document in the private library.
   * @param request - title and text.
   * @returns whether the Host accepted the document.
   */
  createDocument(request: ExpertDocumentCreateRequest): Promise<boolean>
  /**
   * Delete a document; the Host removes it from every selection.
   * @param id - document to delete.
   * @returns whether the Host accepted the delete.
   */
  deleteDocument(id: ExpertDocumentDeleteRequest['id']): Promise<boolean>
  /**
   * Create or edit a knowledge base.
   * @param request - knowledge base fields; `id` selects an edit.
   * @returns whether the Host accepted the write.
   */
  saveKnowledgeBase(request: ExpertKnowledgeBaseSaveRequest): Promise<boolean>
  /**
   * Delete a knowledge base; the Host removes it from every Expert.
   * @param id - knowledge base to delete.
   * @returns whether the Host accepted the delete.
   */
  deleteKnowledgeBase(id: ExpertKnowledgeBaseDeleteRequest['id']): Promise<boolean>
}

/** Bridges the Host `experts` Remote and the skill inventory onto one page store. */
export class ExpertsController {
  private readonly store = createSnapshotStore<ExpertsState>({
    phase: 'loading', library: undefined, skills: [], error: undefined, busy: false, actionError: undefined,
  })
  private pending: AbortController | undefined
  private loaded = false
  /** Advances whenever a mutation owns the library snapshot over pending reads. */
  private libraryRevision = 0

  /**
   * @param remote - generated `experts` Remote namespace.
   * @param skills - generated `skills` Remote namespace.
   */
  constructor(
    private readonly remote: ExpertsRemote,
    private readonly skills: ExpertSkillsRemote,
  ) {}

  /**
   * Observe the controller lifetime.
   * @returns a disposer that aborts any pending read.
   */
  start(): () => void {
    return () => { this.pending?.abort() }
  }

  /** Read the library again after a reconnect, only when it has been read before. */
  async reload(): Promise<void> {
    if (this.loaded) {
      await this.refresh()
    }
  }

  /** Read the library and skill inventory, superseding any read in flight. */
  refresh(): Promise<void> {
    this.loaded = true
    this.pending?.abort()
    const abort = new AbortController()
    this.pending = abort
    return this.read(abort.signal, this.libraryRevision)
  }

  /**
   * Read the Host's usage-ranked list of enabled Experts. Every call reads the
   * Host again, so a mention that just succeeded reorders the next `@` or Add menu open.
   * @param signal - cancels the read when the menu closes.
   * @returns enabled Experts, most used first.
   * @throws when the Host refuses the read.
   */
  async rankedExperts(signal: AbortSignal): Promise<readonly ExpertRankedEntry[]> {
    const result = await this.remote.ranked({}, signal)
    if (!result.ok) {
      throw new Error(result.error.message)
    }
    return result.value.experts
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page snapshot and its actions.
   */
  inject(): ExpertsFace {
    const signal = (): AbortSignal => new AbortController().signal
    return {
      hooks: { experts: this.store },
      load: () => this.refresh(),
      saveExpert: request => this.mutate(() => this.remote.saveExpert(request, signal())),
      deleteExpert: id => this.mutate(() => this.remote.deleteExpert({ id }, signal())),
      createDocument: request => this.mutate(() => this.remote.createDocument(request, signal())),
      deleteDocument: id => this.mutate(() => this.remote.deleteDocument({ id }, signal())),
      saveKnowledgeBase: request => this.mutate(() => this.remote.saveKnowledgeBase(request, signal())),
      deleteKnowledgeBase: id => this.mutate(() => this.remote.deleteKnowledgeBase({ id }, signal())),
    }
  }

  private async read(signal: AbortSignal, revision: number): Promise<void> {
    try {
      const [library, inventory] = await Promise.all([
        this.remote.list({}, signal),
        this.skills.inventory({}, signal),
      ])
      if (signal.aborted || revision !== this.libraryRevision) {
        return
      }
      if (library.ok) {
        const names = inventory.ok
          ? [...new Set(inventory.value.skills.filter(entry => entry.enabled).map(entry => entry.name))]
          : []
        this.store.update((draft) => {
          draft.phase = 'ready'
          draft.error = undefined
          draft.library = library.value
          draft.skills = names
        })
      } else {
        this.store.update((draft) => { draft.phase = 'error'; draft.error = library.error.message })
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        return
      }
      this.store.update((draft) => { draft.phase = 'error'; draft.error = String(error) })
    }
  }

  private async mutate(call: () => RemoteResult<ExpertLibraryValue>): Promise<boolean> {
    this.libraryRevision++
    this.pending?.abort()
    this.store.update((draft) => { draft.busy = true; draft.actionError = undefined })
    try {
      const result = await call()
      if (result.ok) {
        this.store.update((draft) => { draft.busy = false; draft.library = result.value })
        return true
      }
      this.store.update((draft) => { draft.busy = false; draft.actionError = result.error.message })
    } catch (error: unknown) {
      this.store.update((draft) => { draft.busy = false; draft.actionError = String(error) })
    }
    return false
  }
}
