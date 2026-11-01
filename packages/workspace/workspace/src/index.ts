/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
 * stable registry order, and header-validated session membership over the
 * domain data form.
 * @module @deepseek-ai/dsh-workspace
 */

import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'

export { WorkspaceFolderInvalidError, WorkspaceMoveInvalidError } from './entity.ts'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath, realpathNormalize } from './paths.ts'
import { workspaceDomainSpec } from './spec.ts'
import type {
  WorkspaceDomainState,
  WorkspaceGroupRecord,
  WorkspacePendingMutation as WorkspacePendingMarker,
  WorkspaceRecord,
} from './spec.ts'
import type {
  FolderId as FolderIdBrand,
  GroupId as GroupIdBrand,
  SessionActivity,
  Workspace,
  WorkspaceGroup,
  WorkspaceId as WorkspaceIdBrand,
} from './types.ts'

export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap,
  Workspace, WorkspaceFolder, WorkspaceGroup,
} from './types.ts'
export {
  workspaceDomainState, workspaceFolderRecord, workspaceGroupRecord, workspaceRecord, workspaceDomainSpec,
} from './spec.ts'
export type {
  WorkspaceDomainState,
  WorkspaceFolderRecord,
  WorkspaceGroupRecord,
  WorkspacePendingMutation,
  WorkspaceRecord,
} from './spec.ts'
export { realpathNormalize } from './paths.ts'

/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand

/** Identifies one workspace group record (see `src/types.ts`). */
export type GroupId = GroupIdBrand

/** Identifies one logical Session folder (see `src/types.ts`). */
export type FolderId = FolderIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw workspace id string.
 * @returns the same string, branded at compile time.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/**
 * Brand a string as a {@link GroupId}.
 * @param id - Raw group id string.
 * @returns the same string, branded at compile time.
 */
export function GroupId(id: string): GroupId {
  return id as GroupId
}

/**
 * Brand a string as a {@link FolderId}.
 * @param id - Raw Folder id string.
 * @returns the same string, branded at compile time.
 */
export function FolderId(id: string): FolderId {
  return id as FolderId
}

/**
 * An archiveSession or pinSession request named a session neither live nor in
 * session persistence — a definite miss only; storage faults propagate as
 * themselves.
 */
export class WorkspaceUnknownSessionError extends Error {
  /**
   * @param sessionId - The unknown session id.
   * @param verb - The registry operation that named the session.
   */
  constructor(readonly sessionId: SessionId, verb: 'archive' | 'pin') {
    super(`cannot ${verb} session '${sessionId}': live sessions and session persistence hold no such session`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/**
 * An archiveSession request named a session that at least one
 * `workspace/session-activity` listener reported active. Nothing was written;
 * `activity` names what must stop before the session can be archived.
 */
export class WorkspaceActiveSessionError extends Error {
  /**
   * @param sessionId - The active session id.
   * @param activity - The reported activity, in listener order.
   */
  constructor(readonly sessionId: SessionId, readonly activity: readonly SessionActivity[]) {
    super(`cannot archive session '${sessionId}': the session is active (${activity.map(entry => entry.kind).join(', ')})`)
    this.name = 'WorkspaceActiveSessionError'
  }
}

/** A pinSession request named a session currently in the archive set; pinning and archival are mutually exclusive. */
export class WorkspaceArchivedSessionPinError extends Error {
  /**
   * @param sessionId - The archived session id.
   */
  constructor(readonly sessionId: SessionId) {
    super(`cannot pin session '${sessionId}': the session is archived`)
    this.name = 'WorkspaceArchivedSessionPinError'
  }
}

/** A workspace reorder named a source or anchor absent from the durable registry order. */
export class WorkspaceOrderInvalidError extends Error {
  /**
   * @param workspaceId - Missing source or anchor id.
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}

/** A group operation named a group absent from the durable registry group order. */
export class WorkspaceGroupUnknownError extends Error {
  /**
   * @param groupId - Missing group id.
   */
  constructor(readonly groupId: GroupId) {
    super(`unknown workspace group '${groupId}'`)
    this.name = 'WorkspaceGroupUnknownError'
  }
}


/** The session an archive request is about to write into the archive set. */
export interface SessionActivityRequest {
  readonly sessionId: SessionId
}

/** Caller choices for {@link WorkspaceRegistry.archiveSession}. */
export interface ArchiveSessionOptions {
  /**
   * Ask the composed providers to stop the session's running work instead of
   * refusing the archive because of it. The archive is written first, then
   * the stops are requested; running work is never awaited to settlement, and
   * a provider failure is logged without undoing the archive.
   */
  readonly stopActivity?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }

  interface Events {
    /**
     * Ask the composed providers what still runs for a session before it is
     * archived. A listener prepends its own {@link SessionActivity} entries to
     * the result of `next()`; the registry's innermost callback returns an
     * empty list, so a composition without providers archives freely. Any
     * non-empty result refuses the archive without a write.
     * @param request - the session about to be archived.
     * @param next - delegate to the remaining providers.
     * @mode waterfall
     */
    'workspace/session-activity'(
      request: SessionActivityRequest,
      next: () => Promise<readonly SessionActivity[]>,
    ): Promise<readonly SessionActivity[]>
    /**
     * Stop a session's running work because the caller archived it with
     * `stopActivity`; the archive set is durable when this dispatches. Each
     * provider stops its own families — cancelling a turn, its subagent
     * descendants, owned jobs, or active schedules — through the same cancel
     * paths the user's own stop actions use, so the session log ends every
     * open turn regularly and a later unarchive can continue the
     * conversation. Listeners issue their stop requests without waiting for
     * running work to settle; a listener may await its own durability
     * barrier. A rejection is logged by the registry and does not undo the
     * archive.
     * @param request - the session being archived.
     * @mode parallel
     */
    'workspace/session-stop'(request: SessionActivityRequest): Promise<void> | void
  }
}

interface BootstrapGroup {
  readonly path: string
  readonly headers: SessionHeader[]
  readonly newestAt: number
}

/**
 * The registry-internal group view: the public {@link WorkspaceGroup} plus
 * the snapshot-adopt channel registry-level group writes refresh through, so
 * an already published view never goes stale.
 */
interface RegistryGroup extends WorkspaceGroup {
  /**
   * Swap the snapshot after a registry-level durable write.
   * @param record - The committed record.
   */
  adopt(record: WorkspaceGroupRecord): void
}

const sameIds = (left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const compareHeaders = (left: SessionHeader, right: SessionHeader): number =>
  right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

/**
 * Durable workspace registry. Startup waits for `sessionPersistence`, builds
 * one canonical-cwd header index, and completes the one-time history
 * bootstrap before the service becomes active. The persistence dependency is
 * mandatory so an unavailable peer can never be mistaken for an empty
 * history and commit the initialized marker.
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private groupTable?: KvTable<GroupId, WorkspaceGroupRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  private state?: WorkspaceDomainState
  private readonly entities = new Map<WorkspaceId, WorkspaceEntity>()
  private readonly groups = new Map<GroupId, RegistryGroup>()
  private readonly headers = new Map<SessionId, SessionHeader>()
  private readonly sessionPaths = new Map<SessionId, string>()
  private readonly missingSessionPaths = new Set<SessionId>()
  private readonly invalidSessionPaths = new Map<SessionId, string>()
  private operationTail: Promise<void> = Promise.resolve()

  private readonly host: WorkspaceEntityHost = {
    table: () => this.requireTable(),
    candidateMatches: (id, path) => this.sessionPaths.get(id) === path || this.missingSessionPaths.has(id),
    readSessionHeader: id => this.readSessionHeader(id),
    rememberSessionPath: (id, path) => {
      this.sessionPaths.set(id, path)
      this.missingSessionPaths.delete(id)
      this.invalidSessionPaths.delete(id)
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.groupTable = domain.table('groups')
    this.global = domain.global
    this.state = domain.global.get()

    await this.recoverPendingMutation()
    this.validateStoredState(this.state)
    if (!this.state.initialized) {
      const headers = await this.listStoredHeaders()
      await this.replaceHeaderIndex(headers)
      await this.bootstrap(headers)
    } else if (this.table.size > 0) {
      await this.replaceHeaderIndex(await this.listStoredHeaders())
    }

    await this.indexLiveSessions()
    this.validateStoredState(this.requireState())
    this.rebuildEntities()
    this.reportFilteredCandidates()
  }

  /**
   * Create or reuse a workspace for an existing directory. The fully qualified
   * path is canonicalized through `fs.realpath`; a relative, nonexistent, or
   * non-directory path rejects. Repeated calls for the same canonical path
   * return the existing entity without changing its title.
   * A newly created workspace is prepended to the durable registry order.
   * Different canonical paths may share a display title.
   * @param path - Existing directory to own, in a fully qualified path spelling.
   * @param title - Display title used only when a new record is created.
   * @returns the existing or newly durable workspace.
   */
  // TODO: `title` lost its last production caller when the gateway's
  // create-by-name branch was deleted
  // (.agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.md);
  // drop the parameter with its @param clause and the `create(path, title?)`
  // lines in this package's README pair.
  async create(path: string, title?: string): Promise<Workspace> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return await this.enqueueOperation(() => this.createCanonical(canonical, title))
  }

  /**
   * Initialize the default Workspace only while both the registry and Session
   * history are empty. Repeated requests reuse its durable identity; deleting
   * that registration permanently disables automatic creation.
   * @param resolveDirectory - resolve the absolute directory; called only for
   * eligible creation, inside the registry mutation queue. Missing directories
   * are created recursively before registration, and the initial title is the
   * requested directory's own final segment — not the canonical one, so a
   * symlink at that path does not retitle the Workspace after its target.
   * After resolution, caller cancellation does not roll back creation or registration.
   * @returns the initialized Workspace, or undefined when automatic creation is ineligible.
   */
  initializeDefault(resolveDirectory: () => Promise<string>): Promise<Workspace | undefined> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (state.defaultWorkspaceId !== undefined) return this.entities.get(state.defaultWorkspaceId)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined) throw new Error('default Workspace initialization requires the Session store')
      if (state.workspaceIds.length > 0 || state.archivedSessionIds.length > 0
        || sessions.list().length > 0 || (await this.listStoredHeaders()).length > 0) return undefined

      const path = await resolveDirectory()
      if (!fullyQualifiedWorkspacePath(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
      await mkdir(path, { recursive: true })
      const canonical = await realpathNormalize(path)
      // A Session can start outside the registry queue while directory preparation awaits I/O.
      if ((await this.listStoredHeaders()).length > 0 || sessions.list().length > 0) return undefined
      return this.createCanonical(canonical, defaultWorkspaceTitle(path), true)
    })
  }

  /**
   * Look up a workspace by id.
   * @param id - Workspace id.
   * @returns the workspace, or `undefined` when unknown.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * Synchronous workspace projection in durable registry order. Every
   * entity's `sessionIds` getter is already filtered by the startup/live
   * canonical-cwd header index; this method performs no persistence reads.
   * @returns a fresh ordered array of workspace entities.
   */
  list(): Workspace[] {
    return this.requireState().workspaceIds.map((id) => {
      const entity = this.entities.get(id)
      if (entity === undefined) {
        throw new Error(`workspace registry order references missing workspace '${id}'`)
      }
      return entity
    })
  }

  /**
   * Delete one workspace registration while retaining its directory and every
   * session log. The durable order is updated before the table deletion; a
   * failed table write restores the prior order and keeps the entity
   * published. Unknown ids are an idempotent no-op for domain callers.
   * @param id - Workspace registration to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  delete(id: WorkspaceId): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteKnown(id))
  }

  /**
   * Move one workspace within the durable display order, DOM-insertBefore-like.
   * With an anchor it lands before that workspace; without one it appends.
   * @param id - Workspace to move.
   * @param beforeId - Workspace anchor; omitted appends.
   * @returns the complete committed workspace order.
   */
  insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !state.workspaceIds.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return state.workspaceIds
      const without = state.workspaceIds.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(workspaceIds, state.workspaceIds)) return state.workspaceIds
      await this.setState({ ...state, workspaceIds })
      return workspaceIds
    })
  }

  /**
   * Create a workspace group folder. The new group is prepended to the
   * durable group display order. Group titles are not unique at this layer;
   * the Remote command surface enforces the title-uniqueness policy.
   * @param title - Display title.
   * @returns the newly durable group.
   */
  async createGroup(title: string): Promise<WorkspaceGroup> {
    return await this.enqueueOperation(async () => {
      const groupTable = this.requireGroupTable()
      const state = this.requireState()
      const id = GroupId(randomUUID())
      const now = new Date().toISOString()
      const record: WorkspaceGroupRecord = { title, workspaceIds: [], createdAt: now, updatedAt: now }
      const pendingState: WorkspaceDomainState = {
        ...state,
        pendingMutation: { operation: 'group-create', groupId: id },
      }
      try {
        await this.setState(pendingState)
      } catch (error) {
        throw error
      }
      try {
        await groupTable.put(id, record)
      } catch (error) {
        try {
          await this.setState(state)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `workspace group '${id}' record write and pending-marker rollback both failed`,
          )
        }
        throw error
      }
      try {
        await this.setState({ ...state, groupIds: [id, ...state.groupIds] })
      } catch (error) {
        try {
          await groupTable.delete(id)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `workspace group '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
          )
        }
        try {
          await this.setState(state)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `workspace group '${id}' order write and pending-marker rollback both failed`,
          )
        }
        throw error
      }
      const view = this.groupView(id, record)
      this.groups.set(id, view)
      return view
    })
  }

  /**
   * Look up a group by id.
   * @param id - Group id.
   * @returns the group, or `undefined` when unknown.
   */
  getGroup(id: GroupId): WorkspaceGroup | undefined {
    return this.groups.get(id)
  }

  /**
   * Synchronous group projection in durable group display order.
   * @returns a fresh ordered array of group views.
   */
  listGroups(): WorkspaceGroup[] {
    return this.requireState().groupIds.map((id) => {
      const group = this.groups.get(id)
      if (group === undefined) {
        throw new Error(`workspace registry group order references missing group '${id}'`)
      }
      return group
    })
  }

  /**
   * Delete one group while retaining every filed workspace registration: the
   * members are filed back to the top level at the head of the workspace
   * order (preserving their in-group order) before the group record drops,
   * so no workspace is ever lost with its folder. Unknown ids reject.
   * @param id - Group to remove.
   * @returns resolution after durability.
   */
  deleteGroup(id: GroupId): Promise<void> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.groupIds.includes(id)) throw new WorkspaceGroupUnknownError(id)
      const record = this.requireGroupTable().get(id) as WorkspaceGroupRecord
      const nextState: WorkspaceDomainState = {
        ...state,
        workspaceIds: [...record.workspaceIds, ...state.workspaceIds],
        groupIds: state.groupIds.filter(groupId => groupId !== id),
      }
      await this.setState({ ...nextState, pendingMutation: { operation: 'group-delete', groupId: id } })
      this.groups.delete(id)
      try {
        await this.requireGroupTable().delete(id)
      } catch (error) {
        this.groups.set(id, this.groupView(id, record))
        try {
          await this.setState(state)
        } catch (rollbackError) {
          // The durable marker still says to finish deletion, so the cache must
          // agree with that recoverable direction rather than republish a row
          // absent from the persisted order.
          this.groups.delete(id)
          throw new AggregateError(
            [error, rollbackError],
            `workspace group '${id}' record deletion and registry-order rollback both failed`,
          )
        }
        throw error
      }
      try {
        await this.setState(nextState)
      } catch (error) {
        this.ctx.logger.error(
          `workspace group '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
        )
      }
    })
  }

  /**
   * File one workspace under a group — appended to the group's member order —
   * or lift it back to the head of the top-level order when `groupId` is
   * omitted. Filing never touches the workspace's session accounting. An
   * unknown workspace rejects with {@link WorkspaceOrderInvalidError}; an
   * unknown target group rejects with {@link WorkspaceGroupUnknownError}; a
   * move to the current slot resolves without writing. The transfer crosses
   * two durable slots, so it runs inside a `group-move` marker window that
   * startup recovery completes forward.
   * @param workspaceId - Workspace to file.
   * @param groupId - Target group; omitted files top-level.
   * @returns resolution after durability.
   */
  moveToGroup(workspaceId: WorkspaceId, groupId?: GroupId): Promise<void> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!this.entities.has(workspaceId)) throw new WorkspaceOrderInvalidError(workspaceId)
      const owner = this.groupOwner(workspaceId)
      const target: GroupId | '' = groupId ?? ''
      if (groupId !== undefined && !state.groupIds.includes(groupId)) {
        throw new WorkspaceGroupUnknownError(groupId)
      }
      if ((owner?.id ?? '') === target) return

      const sourceRecord = owner?.record.workspaceIds ?? state.workspaceIds
      const targetRecord = groupId === undefined ? state.workspaceIds : this.groupRecord(groupId).workspaceIds
      const from = sourceRecord.filter(id => id !== workspaceId)
      const to = target === '' ? [workspaceId, ...targetRecord] : [...targetRecord, workspaceId]
      await this.setState({
        ...state,
        pendingMutation: {
          operation: 'group-move',
          workspaceId,
          source: owner?.id ?? '',
          target,
          from,
          to,
        },
      })
      try {
        await this.fileWorkspace(owner?.id ?? '', from)
        await this.fileWorkspace(target, to)
        await this.clearPendingMutation()
      } catch (error) {
        try {
          // Undo whichever slot writes landed before dropping the marker, so a
          // fully rolled-back transfer leaves no durable trace; a failed undo
          // keeps the marker and recovery completes the transfer forward.
          await this.fileWorkspace(owner?.id ?? '', sourceRecord)
          await this.fileWorkspace(target, targetRecord)
          await this.setState(state)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `workspace '${workspaceId}' group transfer and rollback both failed; the pending marker remains recoverable`,
          )
        }
        throw error
      }
    })
  }

  /**
   * The registry-global archive set: sessions hidden from every grouping
   * surface. Archiving never touches workspace accounting — an archived
   * session keeps its `sessionIds` slot so unarchiving restores its position.
   * @returns the archived session ids in archive order.
   */
  get archivedSessionIds(): readonly SessionId[] {
    return this.requireState().archivedSessionIds
  }

  /**
   * Archive one session durably. The session must exist (live or in session
   * persistence); its workspace accounting — or lack of one — is irrelevant.
   * Without `stopActivity` the session must also be inactive: the
   * `workspace/session-activity` waterfall is asked once, and any reported
   * activity rejects with {@link WorkspaceActiveSessionError} before anything
   * is written. With `stopActivity` the archive is written without an
   * activity check, and the `workspace/session-stop` providers are then asked
   * to stop the session's work: the durable archive set is what a provider's
   * `agent/pre-step` gate reads, so every wake the stops induce is already
   * blocked. Archiving drops the session's pin in the same durable write
   * (pinning and archival are mutually exclusive). An already archived id
   * resolves without writing, asking, or stopping.
   * @param sessionId - The session to archive.
   * @param options - Whether running work is stopped instead of refusing.
   * @returns resolution after durability and, with `stopActivity`, after every stop request was issued.
   */
  archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another archive.
      if (this.requireState().archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'archive')
      }
      if (options.stopActivity !== true) {
        const activity = await this.ctx.waterfall(
          'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
        )
        if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        archivedSessionIds: [...state.archivedSessionIds, sessionId],
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
      if (options.stopActivity === true) await this.stopSessionActivity(sessionId)
    })
  }

  /**
   * Unarchive one session durably by dropping it from the registry-global
   * archive set; the accounting slot was never touched, so the session
   * returns to its recorded position. Unarchiving runs no session-existence
   * check because removing an id cannot introduce an unknown one, so an
   * entry whose session is gone still resolves. An id that is not archived
   * resolves without writing.
   * @param sessionId - The session to unarchive.
   * @returns resolution after durability.
   */
  unarchiveSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent archive.
      const state = this.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * The registry-global pin set: sessions surfaced ahead of every unpinned
   * session on grouping surfaces. Pinning never touches workspace accounting.
   * @returns Session ids in pin order (most recently pinned first).
   */
  get pinnedSessionIds(): readonly SessionId[] {
    return this.requireState().pinnedSessionIds
  }

  /**
   * Pin one session durably, prepending it to the registry-global pin set.
   * The session must exist (live or in session persistence) and must not be
   * archived. An already pinned id resolves without writing or reordering.
   * @param sessionId - The session to pin.
   * @returns resolution after durability.
   */
  pinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another pin or archive.
      if (this.requireState().pinnedSessionIds.includes(sessionId)) return
      if (this.requireState().archivedSessionIds.includes(sessionId)) {
        throw new WorkspaceArchivedSessionPinError(sessionId)
      }
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'pin')
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        pinnedSessionIds: [sessionId, ...state.pinnedSessionIds],
      })
    })
  }

  /**
   * Unpin one session durably by dropping it from the registry-global pin
   * set. Unpinning runs no session-existence check because removing an id
   * cannot introduce an unknown one, so an entry whose session is gone still
   * resolves. An id that is not pinned resolves without writing.
   * @param sessionId - The session to unpin.
   * @returns resolution after durability.
   */
  unpinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent pin.
      const state = this.requireState()
      if (!state.pinnedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * Permanently delete one session: erase its stored log through
   * `sessionPersistence.delete`, then drop every registry reference to it
   * (archive set, pin set, workspace membership, header and path caches). Persistence
   * is erased first, so a failure there leaves the session and its registry
   * entries untouched; a failure while scrubbing leaves only orphan ids that
   * the membership filter already ignores. A session persistence no longer
   * holds still has its registry references scrubbed.
   * @param sessionId - The session to delete.
   * @returns resolution after the registry no longer references the session.
   * @throws {SessionAlreadyOwnedError} when a live handle holds the session.
   */
  deleteSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        await this.ctx.sessionPersistence.delete(sessionId)
      } catch (error) {
        if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      }
      for (const entity of this.entities.values()) await entity.detachSession(sessionId)
      this.headers.delete(sessionId)
      this.sessionPaths.delete(sessionId)
      this.invalidSessionPaths.delete(sessionId)
      const state = this.requireState()
      const archivedSessionIds = state.archivedSessionIds.filter(id => id !== sessionId)
      const pinnedSessionIds = state.pinnedSessionIds.filter(id => id !== sessionId)
      if (
        archivedSessionIds.length !== state.archivedSessionIds.length
        || pinnedSessionIds.length !== state.pinnedSessionIds.length
      ) {
        await this.setState({ ...state, archivedSessionIds, pinnedSessionIds })
      }
    })
  }

  /**
   * Whether a session is live, header-indexed, or present in a fresh
   * persistence listing. Only a definite miss returns false — a failing
   * `sessionPersistence.list()` propagates so storage faults never
   * masquerade as an unknown session.
   */
  private async sessionKnown(id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if (this.headers.has(id)) return true
    await this.indexHeaders(await this.listStoredHeaders())
    return this.headers.has(id)
  }

  /** Request every provider's stop; a failing provider is logged, never a reason to keep the session visible. */
  private async stopSessionActivity(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error: unknown) {
      // ctx.parallel settles every listener and rejects with one AggregateError.
      /* v8 ignore next -- the plain arm guards a rethrowing dispatcher. */
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) {
        this.ctx.logger.warn(`workspace: stopping session '${sessionId}' for archive failed: ${String(failure)}`)
      }
    }
  }

  /**
   * Resolve by canonical directory path without creating or mutating a
   * workspace. A missing path rejects during `realpath`; an existing unowned
   * directory returns `undefined`.
   * @param path - Existing directory path in a fully qualified spelling.
   * @returns the workspace owning the canonical path, when one exists.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const canonical = await realpathNormalize(path)
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }
    return undefined
  }

  private async createCanonical(canonical: string, title?: string, firstUse = false): Promise<WorkspaceEntity> {
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }

    const workspaceName = title ?? defaultWorkspaceTitle(canonical)
    const table = this.requireTable()
    const state = this.requireState()
    const id = WorkspaceId(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      path: canonical,
      title: workspaceName,
      sessionIds: [],
      folders: [],
      createdAt: now,
      updatedAt: now,
    }
    const entity = new WorkspaceEntity(this.host, id, record)
    this.entities.set(id, entity)
    const pendingState: WorkspaceDomainState = {
      ...state,
      pendingMutation: { operation: 'create', workspaceId: id },
    }
    try {
      await this.setState(pendingState)
    } catch (error) {
      this.entities.delete(id)
      throw error
    }
    try {
      await table.put(id, record)
    } catch (error) {
      this.entities.delete(id)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record write and pending-marker rollback both failed`,
        )
      }
      throw error
    }

    try {
      await this.setState({
        ...state,
        pendingMutation: undefined,
        initialized: true,
        ...(firstUse ? { defaultWorkspaceId: id } : {}),
        workspaceIds: [id, ...state.workspaceIds],
      })
    } catch (error) {
      this.entities.delete(id)
      try {
        await table.delete(id)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
        )
      }
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and pending-marker rollback both failed`,
        )
      }
      throw error
    }
    return entity
  }

  private async deleteKnown(id: WorkspaceId): Promise<boolean> {
    const entity = this.entities.get(id)
    if (entity === undefined) return false
    const state = this.requireState()
    const nextState = {
      ...state,
      pendingMutation: undefined,
      initialized: true,
      workspaceIds: state.workspaceIds.filter(workspaceId => workspaceId !== id),
    }
    await this.setState({
      ...nextState,
      pendingMutation: { operation: 'delete', workspaceId: id },
    })
    this.entities.delete(id)
    try {
      // The scrub runs inside the marker window: a crash between the group
      // writes and the record delete leaves the marker for recovery to finish
      // both, and every intermediate state stays one the medium may hold.
      await this.scrubGroupMembership(id)
      await this.requireTable().delete(id)
    } catch (error) {
      this.entities.set(id, entity)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        // The durable marker still says to finish deletion, so the cache must
        // agree with that recoverable direction rather than republish a row
        // absent from the persisted order.
        this.entities.delete(id)
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record deletion and registry-order rollback both failed`,
        )
      }
      throw error
    }
    try {
      await this.setState(nextState)
    } catch (error) {
      // The deletion committed at the table write and was already published
      // to Host streams. Keep the durable marker for startup recovery rather
      // than reporting failure after the requested state became true.
      this.ctx.logger.error(
        `workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
      )
    }
    return true
  }

  /**
   * Complete the one mutation explicitly named by durable state. Create,
   * delete, group-create, and group-delete markers recover by dropping the
   * named row — the id must already be absent from its order array — and a
   * workspace delete also finishes the group-membership scrub. A `group-move`
   * marker completes forward: the recorded source and target member arrays
   * are rewritten to their post-transfer contents, with the moved id sitting
   * in the source slot, in the target slot, or in neither (the crash windows
   * between the slot writes). Unexplained divergence beyond the marker still
   * reaches {@link validateStoredState} and fails loud.
   */
  private async recoverPendingMutation(): Promise<void> {
    const state = this.requireState()
    const pending = state.pendingMutation
    if (pending === undefined) return
    const marker: WorkspacePendingMarker = pending
    switch (marker.operation) {
      case 'create':
      case 'delete': {
        if (state.workspaceIds.includes(marker.workspaceId)) {
          throw new Error(
            `workspace domain is inconsistent: pending ${marker.operation} workspace `
            + `'${marker.workspaceId}' is still present in registry order`,
          )
        }
        if (marker.operation === 'delete') await this.scrubGroupMembership(marker.workspaceId)
        await this.requireTable().delete(marker.workspaceId)
        break
      }
      case 'group-create':
      case 'group-delete': {
        if (state.groupIds.includes(marker.groupId)) {
          throw new Error(
            `workspace domain is inconsistent: pending ${marker.operation} group `
            + `'${marker.groupId}' is still present in registry group order`,
          )
        }
        await this.requireGroupTable().delete(marker.groupId)
        break
      }
      case 'group-move': {
        const owner = this.groupOwner(marker.workspaceId)
        const slot: GroupId | '' | undefined = owner === undefined
          ? (state.workspaceIds.includes(marker.workspaceId) ? '' : undefined)
          : owner.id
        // Legitimate crash points: the id still sits in the source slot (no
        // slot write landed), sits nowhere (only the source write landed), or
        // already sits in the target slot (the marker clear failed after both
        // writes landed). Sitting anywhere else is unexplained divergence.
        if (slot !== undefined && slot !== marker.source && slot !== marker.target) {
          throw new Error(
            'workspace domain is inconsistent: pending group-move workspace '
            + `'${marker.workspaceId}' sits outside its recorded transfer slots`,
          )
        }
        await this.fileWorkspace(marker.source, marker.from)
        await this.fileWorkspace(marker.target, marker.to)
        break
      }
      /* v8 ignore next 2 -- closed-union backstop after the zod-validated durable boundary */
      default:
        assertNever(marker)
    }
    await this.clearPendingMutation()
  }

  /**
   * Commit one filing slot durably: a group's member array, or the top-level
   * workspace order when `slot` is the empty string. An unchanged slot
   * resolves without writing; group writes swap the live view's snapshot.
   */
  private async fileWorkspace(slot: GroupId | '', memberIds: readonly WorkspaceId[]): Promise<void> {
    if (slot === '') {
      const state = this.requireState()
      if (sameIds(memberIds, state.workspaceIds)) return
      await this.setState({ ...state, workspaceIds: [...memberIds] })
      return
    }
    const record = this.groupRecord(slot)
    if (sameIds(memberIds, record.workspaceIds)) return
    const next = await this.requireGroupTable().update(slot, current => ({
      ...current,
      workspaceIds: [...memberIds],
      updatedAt: new Date().toISOString(),
    }))
    this.groups.get(slot)?.adopt(next)
  }

  /**
   * Remove one workspace from every group record still filing it, swapping
   * the live views. Filing is exclusive by validation, but the scrub does not
   * assume it: an interrupted filing transfer can leave the id in two member
   * arrays, and the recovery re-running this scrub must finish both.
   */
  private async scrubGroupMembership(workspaceId: WorkspaceId): Promise<void> {
    const groupTable = this.requireGroupTable()
    for (const [id, record] of groupTable.entries()) {
      if (!record.workspaceIds.includes(workspaceId)) continue
      const next = await groupTable.update(id, current => ({
        ...current,
        workspaceIds: current.workspaceIds.filter(member => member !== workspaceId),
        updatedAt: new Date().toISOString(),
      }))
      this.groups.get(id)?.adopt(next)
    }
  }

  /** Locate the group currently filing one workspace, when any. */
  private groupOwner(workspaceId: WorkspaceId): { id: GroupId; record: WorkspaceGroupRecord } | undefined {
    for (const id of this.requireState().groupIds) {
      const record = this.groupRecord(id)
      if (record.workspaceIds.includes(workspaceId)) return { id, record }
    }
    return undefined
  }

  /**
   * Read one group record. Callers validate order membership first, so a
   * miss here means the medium diverged from the validated order.
   */
  private groupRecord(id: GroupId): WorkspaceGroupRecord {
    const record = this.requireGroupTable().get(id)
    if (record === undefined) {
      throw new Error(`workspace domain is inconsistent: missing group record '${id}'`)
    }
    return record
  }

  /** Commit the state's non-marker fields, dropping `pendingMutation`. */
  private async clearPendingMutation(): Promise<void> {
    const state = this.requireState()
    await this.setState({ ...state, pendingMutation: undefined })
  }

  private async bootstrap(headers: readonly SessionHeader[]): Promise<void> {
    const table = this.requireTable()
    const state = this.requireState()
    const groupsByPath = new Map<string, SessionHeader[]>()
    for (const header of headers) {
      const path = this.sessionPaths.get(header.id)
      if (path === undefined) continue
      const group = groupsByPath.get(path)
      if (group === undefined) groupsByPath.set(path, [header])
      else group.push(header)
    }
    const groups: BootstrapGroup[] = [...groupsByPath].map(([path, groupHeaders]) => {
      groupHeaders.sort(compareHeaders)
      const newest = groupHeaders[0] as SessionHeader
      return { path, headers: groupHeaders, newestAt: newest.createdAt }
    }).sort((left, right) =>
      right.newestAt - left.newestAt || left.path.localeCompare(right.path))

    const byPath = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      byPath.set(record.path, id)
      for (const sessionId of record.sessionIds) accounted.set(sessionId, id)
    }

    for (const group of groups) {
      let id = byPath.get(group.path)
      if (id === undefined) {
        const sessionIds = group.headers
          .map(header => header.id)
          .filter(sessionId => !accounted.has(sessionId))
        if (sessionIds.length === 0) continue
        id = WorkspaceId(randomUUID())
        const createdAt = new Date(group.newestAt).toISOString()
        const record: WorkspaceRecord = {
          path: group.path,
          title: defaultWorkspaceTitle(group.path),
          sessionIds,
          folders: [],
          createdAt,
          updatedAt: createdAt,
        }
        await table.put(id, record)
        byPath.set(group.path, id)
        for (const sessionId of sessionIds) accounted.set(sessionId, id)
        continue
      }

      const current = table.get(id) as WorkspaceRecord
      const historical = group.headers
        .map(header => header.id)
        .filter(sessionId => accounted.get(sessionId) === undefined || accounted.get(sessionId) === id)
      const historicalSet = new Set(historical)
      const sessionIds = [
        ...historical,
        ...current.sessionIds.filter(sessionId => !historicalSet.has(sessionId)),
      ]
      if (sameSessionIds(current.sessionIds, sessionIds)) continue
      await table.update(id, record => ({
        ...record,
        sessionIds,
        updatedAt: new Date().toISOString(),
      }))
      for (const sessionId of historical) accounted.set(sessionId, id)
    }

    const groupRank = new Map(groups.map(group => [group.path, group.newestAt]))
    const priorRank = new Map(state.workspaceIds.map((id, index) => [id, index]))
    const workspaceIds = [...table.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const leftTime = groupRank.get(left.path) ?? Date.parse(left.createdAt)
        const rightTime = groupRank.get(right.path) ?? Date.parse(right.createdAt)
        return rightTime - leftTime
          || (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER)
            - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
          || String(leftId).localeCompare(String(rightId))
      })
      .map(([id]) => id)

    // Group state cannot predate bootstrap: group operations exist only on a
    // started registry, so both slots carry over verbatim.
    if (!sameIds(state.workspaceIds, workspaceIds)) {
      await this.setState({
        initialized: false,
        workspaceIds,
        archivedSessionIds: state.archivedSessionIds,
        pinnedSessionIds: state.pinnedSessionIds,
        groupIds: state.groupIds,
      })
    }
    await this.setState({
      initialized: true,
      workspaceIds,
      archivedSessionIds: state.archivedSessionIds,
      pinnedSessionIds: state.pinnedSessionIds,
      groupIds: state.groupIds,
    })
  }

  private validateStoredState(state: WorkspaceDomainState): void {
    const table = this.requireTable()
    const groupTable = this.requireGroupTable()
    const order = new Set<WorkspaceId>()
    for (const id of state.workspaceIds) {
      if (order.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`)
      }
      order.add(id)
    }

    const groupOrder = new Set<GroupId>()
    for (const id of state.groupIds) {
      if (groupOrder.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry group order repeats group '${id}'`)
      }
      if (groupTable.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry group order references missing group '${id}'`)
      }
      groupOrder.add(id)
    }
    if (state.initialized && groupOrder.size !== groupTable.size) {
      const orphan = [...groupTable.keys()].find(id => !groupOrder.has(id))
      throw new Error(
        `workspace domain is inconsistent: group '${orphan as GroupId}' is absent from registry group order`,
      )
    }

    const filed = new Set<WorkspaceId>()
    for (const [groupId, record] of groupTable.entries()) {
      for (const workspaceId of record.workspaceIds) {
        if (table.get(workspaceId) === undefined) {
          throw new Error(
            `workspace domain is inconsistent: group '${groupId}' references missing workspace '${workspaceId}'`,
          )
        }
        if (order.has(workspaceId)) {
          throw new Error(
            `workspace domain is inconsistent: workspace '${workspaceId}' sits in both `
            + `registry order and group '${groupId}'`,
          )
        }
        if (filed.has(workspaceId)) {
          throw new Error(
            `workspace domain is inconsistent: workspace '${workspaceId}' is filed by two groups`,
          )
        }
        filed.add(workspaceId)
      }
    }
    if (state.initialized && order.size + filed.size !== table.size) {
      const orphan = [...table.keys()].find(id => !order.has(id) && !filed.has(id))
      throw new Error(
        `workspace domain is inconsistent: workspace '${orphan as WorkspaceId}' is absent from registry order`,
      )
    }

    const paths = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      const folderIds = new Set<FolderId>()
      const filedSessionIds = new Set<SessionId>()
      for (const folder of record.folders) {
        if (folderIds.has(folder.id)) {
          throw new Error(`workspace domain is inconsistent: workspace '${id}' repeats folder '${folder.id}'`)
        }
        folderIds.add(folder.id)
        for (const sessionId of folder.sessionIds) {
          if (!record.sessionIds.includes(sessionId)) {
            throw new Error(
              `workspace domain is inconsistent: folder '${folder.id}' references unowned session '${sessionId}'`,
            )
          }
          if (filedSessionIds.has(sessionId)) {
            throw new Error(
              `workspace domain is inconsistent: session '${sessionId}' is filed by two folders in workspace '${id}'`,
            )
          }
          filedSessionIds.add(sessionId)
        }
      }
      const pathHolder = paths.get(record.path)
      if (pathHolder !== undefined) {
        throw new Error(
          `workspace domain is inconsistent: path '${record.path}' is claimed `
          + `by both workspace '${pathHolder}' and workspace '${id}'`,
        )
      }
      paths.set(record.path, id)
      for (const sessionId of record.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
    }
  }

  private rebuildEntities(): void {
    const table = this.requireTable()
    this.entities.clear()
    for (const [id, record] of table.entries()) {
      this.entities.set(id, new WorkspaceEntity(this.host, id, record))
    }
    const groupTable = this.requireGroupTable()
    this.groups.clear()
    for (const [id, record] of groupTable.entries()) {
      this.groups.set(id, this.groupView(id, record))
    }
  }

  /**
   * Freeze one group record into the consumer view. The view's getters read a
   * snapshot swapped through its own write path or through the registry's
   * `adopt` channel after a registry-level group write (filing, move-out,
   * membership scrub), so a group is observed atomically like a workspace
   * entity and an already published view never goes stale.
   */
  private groupView(id: GroupId, record: WorkspaceGroupRecord): RegistryGroup {
    let snapshot = this.groupSnapshot(record)
    const view: RegistryGroup = {
      id,
      get title() {
        return snapshot.title
      },
      get createdAt() {
        return snapshot.createdAt
      },
      get updatedAt() {
        return snapshot.updatedAt
      },
      get workspaceIds() {
        return snapshot.workspaceIds
      },
      adopt: (next: WorkspaceGroupRecord) => {
        snapshot = this.groupSnapshot(next)
      },
      setTitle: async (title: string) => {
        if (snapshot.title === title) return
        const next = await this.requireGroupTable().update(id, current => ({
          ...current,
          title,
          updatedAt: new Date().toISOString(),
        }))
        snapshot = this.groupSnapshot(next)
      },
    }
    return view
  }

  /** Freeze the group record's member ids in registry-entity order. */
  private groupSnapshot(record: WorkspaceGroupRecord): {
    readonly title: string
    readonly createdAt: string
    readonly updatedAt: string
    readonly workspaceIds: readonly WorkspaceId[]
  } {
    return {
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      workspaceIds: Object.freeze(record.workspaceIds.slice()),
    }
  }

  private async replaceHeaderIndex(headers: readonly SessionHeader[]): Promise<void> {
    this.headers.clear()
    this.sessionPaths.clear()
    this.missingSessionPaths.clear()
    this.invalidSessionPaths.clear()
    await this.indexHeaders(headers)
  }

  private async indexHeaders(headers: readonly SessionHeader[]): Promise<void> {
    for (const header of headers) await this.indexHeader(header)
  }

  private async indexHeader(header: SessionHeader): Promise<void> {
    this.headers.set(header.id, header)
    this.sessionPaths.delete(header.id)
    this.missingSessionPaths.delete(header.id)
    if (header.cwd === undefined) {
      this.invalidSessionPaths.set(header.id, 'header has no cwd')
      return
    }
    try {
      const path = await realpathNormalize(header.cwd)
      if (!(await stat(path)).isDirectory()) {
        this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`)
        return
      }
      this.sessionPaths.set(header.id, path)
      this.invalidSessionPaths.delete(header.id)
    } catch (error) {
      if (fullyQualifiedWorkspacePath(header.cwd)
        && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.missingSessionPaths.add(header.id)
      }
      this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`)
    }
  }

  /** Every stored session's header, projected from the persistence snapshot listing. */
  private async listStoredHeaders(): Promise<SessionHeader[]> {
    const snapshots = await this.ctx.sessionPersistence.list()
    return snapshots.map(snapshot => snapshot.header)
  }

  private async indexLiveSessions(): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await this.indexHeaders(sessions.list().map(session => session.header))
  }

  private reportFilteredCandidates(): void {
    for (const entity of this.entities.values()) {
      const record = this.requireTable().get(entity.id) as WorkspaceRecord
      for (const sessionId of record.sessionIds) {
        if (this.host.candidateMatches(sessionId, record.path)) continue
        const path = this.sessionPaths.get(sessionId)
        const reason = this.invalidSessionPaths.get(sessionId)
          ?? (this.headers.has(sessionId)
            ? `canonical cwd '${path}' differs from workspace path '${record.path}'`
            : 'session header is missing')
        this.ctx.logger.error(
          `workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`,
        )
      }
    }
  }

  private async readSessionHeader(id: SessionId): Promise<SessionHeader> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      this.headers.set(id, live.header)
      return live.header
    }
    const cached = this.headers.get(id)
    if (cached !== undefined) return cached

    const headers = await this.listStoredHeaders()
    await this.indexHeaders(headers)
    const header = this.headers.get(id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }

  private requireGroupTable(): KvTable<GroupId, WorkspaceGroupRecord> {
    if (this.groupTable === undefined) throw new Error('workspace registry is not started yet')
    return this.groupTable
  }

  private requireState(): WorkspaceDomainState {
    if (this.state === undefined) throw new Error('workspace registry is not started yet')
    return this.state
  }

  private async setState(state: WorkspaceDomainState): Promise<void> {
    await (this.global as DomainGlobal<WorkspaceDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      // A committed delete may leave only its marker cleanup pending. Retry
      // recovery before another create/delete can overwrite that pending operation record.
      await this.recoverPendingMutation()
      return await operation()
    })
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

const sameSessionIds = (left: readonly SessionId[], right: readonly SessionId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

/* v8 ignore next 3 -- closed-union backstop after the zod-validated durable boundary */
function assertNever(value: never): never {
  throw new Error(`unreachable workspace pending mutation: ${JSON.stringify(value)}`)
}

export default WorkspaceRegistry
