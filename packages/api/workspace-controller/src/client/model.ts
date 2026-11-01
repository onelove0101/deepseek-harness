/** Client-side Workspace state model shared by Remote transport and UI projection. */

import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteFailure, RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceBaseline,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteValue,
  WorkspaceFolderCreateRequest,
  WorkspaceFolderDeleteRequest,
  WorkspaceFolderRenameRequest,
  WorkspaceFolderValue,
  WorkspaceGroupCreateRequest,
  WorkspaceGroupDeleteRequest,
  WorkspaceGroupRenameRequest,
  WorkspaceGroupValue,
  WorkspaceGroupView,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceLayout,
  WorkspaceLayoutValue,
  WorkspaceMoveSessionToFolderRequest,
  WorkspaceMoveToGroupRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
  WorkspaceId,
  WorkspaceView,
} from '../types.ts'

/** Complete generated `ctx.remote.workspace` namespace. */
export type WorkspaceRemote = TypertClientRemote['workspace']

/** Monotone Workspace-list arrival lifecycle. */
export type WorkspaceListPhase = 'pending' | 'ready'

/** Immutable Client Workspace state. */
export interface WorkspaceSnapshot {
  /** Every Workspace in layout order: top-level Workspaces first, then each Group's members. */
  readonly items: readonly WorkspaceView[]
  /** Workspaces outside every Group, in display order. */
  readonly topLevelWorkspaceIds: readonly WorkspaceId[]
  /** Groups in display order, each listing its member Workspaces in order. */
  readonly groups: readonly WorkspaceGroupView[]
  /** Complete registry-global archive set in Host order. */
  readonly archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']
  /** Complete registry-global pin set, most recently pinned first. */
  readonly pinnedSessionIds: WorkspacePinValue['pinnedSessionIds']
  readonly state: 'idle' | 'loading' | 'error'
  readonly phase: WorkspaceListPhase
  readonly error: RemoteFailure | null
}

/** State operations emitted by a decoded Workspace follow generation. */
export interface WorkspaceFollowSink {
  /** Replace all state from the generation baseline. */
  replaceBaseline(value: WorkspaceBaseline): void
  /** Merge one Workspace row. */
  upsertView(workspace: WorkspaceView): void
  /** Remove one Workspace row. */
  removeView(workspaceId: WorkspaceId): void
  /** Replace the Host-confirmed top-level order and Group membership. */
  replaceLayout(layout: WorkspaceLayout): void
  /** Replace the complete archived Session set. */
  replaceArchived(sessionIds: WorkspaceArchiveValue['archivedSessionIds']): void
  /** Replace the complete pinned Session set. */
  replacePinned(pinnedSessionIds: WorkspacePinValue['pinnedSessionIds']): void
}

/**
 * Owns the Client Workspace projection, mutation echoes, and stream/unary race resolution.
 */
export class ClientWorkspaceModel implements WorkspaceFollowSink {
  private items: readonly WorkspaceView[] = []
  private topLevelWorkspaceIds: readonly WorkspaceId[] = []
  private groups: readonly WorkspaceGroupView[] = []
  private archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds'] = []
  private pinnedSessionIds: WorkspacePinValue['pinnedSessionIds'] = []
  private state: WorkspaceSnapshot['state'] = 'loading'
  private phase: WorkspaceListPhase = 'pending'
  private error: RemoteFailure | null = null
  /** Latest structural request (reorder or Group command); only its unary echo may install a layout. */
  private layoutRequestGeneration = 0
  /** Increments on stream layouts so a later remote commit outranks an older unary echo. */
  private layoutFrameGeneration = 0
  /** Last complete layout accepted from a baseline, increment, or current unary echo. */
  private committedLayout: WorkspaceLayout = { topLevelWorkspaceIds: [], groups: [] }
  /** Latest archive-set request; a later request or a pushed set supersedes it. */
  private archiveRequestSeq = 0
  /** Latest pin-set request; a later request or a pushed set supersedes it. */
  private pinRequestSeq = 0
  /** Host Workspace ids are never reused, so delayed data cannot resurrect a removed row. */
  private readonly removedIds = new Set<WorkspaceId>()
  /** Monotone follow-frame revision for resolving equal-timestamp row races. */
  private streamRevision = 0
  /** Latest follow-frame revision received for each Workspace row. */
  private readonly streamedRevisions = new Map<WorkspaceId, number>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache: WorkspaceSnapshot
  private snapshotDirty = false
  private notificationPending = false
  private notificationScheduled = false
  private notificationGeneration = 0

  /** @param remote - generated Workspace Remote namespace. */
  constructor(private readonly remote: WorkspaceRemote) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Create or resolve a Workspace and merge the unary result immediately.
   * @param input - existing absolute path to adopt.
   * @returns generated Remote result.
   */
  async create(input: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>> {
    return await this.rowMutation(() => this.remote.create(input), result => result.workspace)
  }

  /**
   * Initialize the default Workspace and merge its authoritative row.
   * @param signal - caller lifetime.
   * @returns generated Remote result.
   */
  async initializeDefault(signal?: AbortSignal): Promise<RemoteResult<WorkspaceValue | undefined>> {
    const result = await this.remote.initializeDefault(signal)
    if (result.ok && result.value !== undefined) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Rename a Workspace and merge the unary result immediately.
   * @param workspaceId - target Workspace.
   * @param title - new display title.
   * @returns generated Remote result.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<RemoteResult<WorkspaceValue>> {
    return await this.rowMutation(() => this.remote.rename({ workspaceId, title }), result => result.workspace)
  }

  /**
   * Delete a Workspace and remove it from the local projection immediately.
   * @param workspaceId - target Workspace.
   * @returns generated Remote result.
   */
  async delete(workspaceId: WorkspaceId): Promise<RemoteResult<WorkspaceDeleteValue>> {
    const result = await this.remote.delete({ workspaceId })
    if (result.ok) this.remove(workspaceId, true)
    return result
  }

  /**
   * Optimistically move a Workspace and reconcile the returned complete order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - anchor Workspace; omitted appends.
   * @returns generated Remote result.
   */
  async insertBefore(
    workspaceId: WorkspaceId,
    beforeWorkspaceId?: WorkspaceId,
  ): Promise<RemoteResult<WorkspaceOrderValue>> {
    const requestGeneration = ++this.layoutRequestGeneration
    const frameGeneration = this.layoutFrameGeneration
    this.installLayout({
      topLevelWorkspaceIds: insertIdBefore(this.topLevelWorkspaceIds, workspaceId, beforeWorkspaceId),
      groups: this.groups,
    })
    const result = await this.remote.insertBefore({
      workspaceId,
      ...beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId },
    })
    if (requestGeneration === this.layoutRequestGeneration
      && frameGeneration === this.layoutFrameGeneration) {
      if (result.ok) {
        this.installLayout({ topLevelWorkspaceIds: result.value.workspaceIds, groups: this.groups }, true)
      } else {
        this.installLayout(this.committedLayout)
      }
    }
    return result
  }

  /**
   * Create a Workspace Group and install the returned complete layout.
   * @param title - proposed unique Group title.
   * @returns generated Remote result.
   */
  async createGroup(title: WorkspaceGroupCreateRequest['title']): Promise<RemoteResult<WorkspaceGroupValue>> {
    return await this.structural(() => this.remote.createGroup({ title }))
  }

  /**
   * Rename a Workspace Group and install the returned complete layout.
   * @param groupId - target Group.
   * @param title - proposed unique Group title.
   * @returns generated Remote result.
   */
  async renameGroup(
    groupId: WorkspaceGroupRenameRequest['groupId'],
    title: WorkspaceGroupRenameRequest['title'],
  ): Promise<RemoteResult<WorkspaceGroupValue>> {
    return await this.structural(() => this.remote.renameGroup({ groupId, title }))
  }

  /**
   * Dissolve a Workspace Group and install the returned complete layout.
   * @param groupId - Group to dissolve.
   * @returns generated Remote result.
   */
  async deleteGroup(groupId: WorkspaceGroupDeleteRequest['groupId']): Promise<RemoteResult<WorkspaceLayoutValue>> {
    return await this.structural(() => this.remote.deleteGroup({ groupId }))
  }

  /**
   * File a Workspace in a Group, or lift it to the top level, and install the returned layout.
   * @param workspaceId - Workspace to file.
   * @param groupId - target Group; omitted lifts to the top level.
   * @returns generated Remote result.
   */
  async moveToGroup(
    workspaceId: WorkspaceMoveToGroupRequest['workspaceId'],
    groupId?: WorkspaceMoveToGroupRequest['groupId'],
  ): Promise<RemoteResult<WorkspaceLayoutValue>> {
    return await this.structural(() => this.remote.moveToGroup({
      workspaceId,
      ...groupId === undefined ? {} : { groupId },
    }))
  }

  /**
   * Create a Session Folder and merge the returned owning Workspace.
   * @param workspaceId - owning Workspace.
   * @param title - proposed unique Folder title.
   * @returns generated Remote result.
   */
  async createFolder(
    workspaceId: WorkspaceFolderCreateRequest['workspaceId'],
    title: WorkspaceFolderCreateRequest['title'],
  ): Promise<RemoteResult<WorkspaceFolderValue>> {
    return await this.rowMutation(() => this.remote.createFolder({ workspaceId, title }), result => result.workspace)
  }

  /**
   * Rename a Session Folder and merge the returned owning Workspace.
   * @param workspaceId - owning Workspace.
   * @param folderId - target Folder.
   * @param title - proposed unique Folder title.
   * @returns generated Remote result.
   */
  async renameFolder(
    workspaceId: WorkspaceFolderRenameRequest['workspaceId'],
    folderId: WorkspaceFolderRenameRequest['folderId'],
    title: WorkspaceFolderRenameRequest['title'],
  ): Promise<RemoteResult<WorkspaceValue>> {
    return await this.rowMutation(() => this.remote.renameFolder({ workspaceId, folderId, title }), result => result.workspace)
  }

  /**
   * Delete a Session Folder and merge the returned owning Workspace.
   * @param workspaceId - owning Workspace.
   * @param folderId - Folder to remove.
   * @returns generated Remote result.
   */
  async deleteFolder(
    workspaceId: WorkspaceFolderDeleteRequest['workspaceId'],
    folderId: WorkspaceFolderDeleteRequest['folderId'],
  ): Promise<RemoteResult<WorkspaceValue>> {
    return await this.rowMutation(() => this.remote.deleteFolder({ workspaceId, folderId }), result => result.workspace)
  }

  /**
   * File a Session in a Folder, or return it to the Workspace root, and merge the owning Workspace.
   * @param workspaceId - owning Workspace.
   * @param sessionId - Session to file.
   * @param folderId - target Folder; omitted returns the Session to the root.
   * @returns generated Remote result.
   */
  async moveSessionToFolder(
    workspaceId: WorkspaceMoveSessionToFolderRequest['workspaceId'],
    sessionId: WorkspaceMoveSessionToFolderRequest['sessionId'],
    folderId?: WorkspaceMoveSessionToFolderRequest['folderId'],
  ): Promise<RemoteResult<WorkspaceValue>> {
    return await this.rowMutation(
      () => this.remote.moveSessionToFolder({
        workspaceId,
        sessionId,
        ...folderId === undefined ? {} : { folderId },
      }),
      result => result.workspace,
    )
  }

  /**
   * Move a Session within its Workspace and merge the returned row.
   * @param workspaceId - owning Workspace.
   * @param sessionId - accounted Session to move.
   * @param beforeSessionId - accounted anchor; omitted appends.
   * @returns generated Remote result.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceInsertSessionBeforeRequest['workspaceId'],
    sessionId: WorkspaceInsertSessionBeforeRequest['sessionId'],
    beforeSessionId?: WorkspaceInsertSessionBeforeRequest['beforeSessionId'],
  ): Promise<RemoteResult<WorkspaceValue>> {
    return await this.rowMutation(
      () => this.remote.insertSessionBefore({
        workspaceId,
        sessionId,
        ...beforeSessionId === undefined ? {} : { beforeSessionId },
      }),
      result => result.workspace,
    )
  }

  /**
   * Archive one Session and install the returned complete archive set.
   * A reply superseded by a later archive request or a pushed set installs nothing.
   * @param sessionId - Session to archive.
   * @param options - Whether the Host stops the Session's running work instead of refusing.
   * @returns generated Remote result.
   */
  async archiveSession(
    sessionId: WorkspaceArchiveSessionRequest['sessionId'],
    options: Pick<WorkspaceArchiveSessionRequest, 'stopActivity'> = {},
  ): Promise<RemoteResult<WorkspaceArchiveValue>> {
    const requestSeq = ++this.archiveRequestSeq
    const result = await this.remote.archiveSession({
      sessionId,
      ...(options.stopActivity === true ? { stopActivity: true } : {}),
    })
    if (result.ok && requestSeq === this.archiveRequestSeq) {
      this.installArchived(result.value.archivedSessionIds)
      // The Host drops an archived session's pin in the same durable write;
      // mirror that locally so no frame shows the row both archived and pinned.
      this.installPinned(this.pinnedSessionIds.filter(id => id !== sessionId))
    }
    return result
  }

  /**
   * Unarchive one Session and install the returned complete archive set.
   * A reply superseded by a later archive request or a pushed set installs nothing.
   * @param sessionId - Session to unarchive.
   * @returns generated Remote result.
   */
  async unarchiveSession(
    sessionId: WorkspaceUnarchiveSessionRequest['sessionId'],
  ): Promise<RemoteResult<WorkspaceArchiveValue>> {
    const requestSeq = ++this.archiveRequestSeq
    const result = await this.remote.unarchiveSession({ sessionId })
    if (result.ok && requestSeq === this.archiveRequestSeq) {
      this.installArchived(result.value.archivedSessionIds)
    }
    return result
  }

  /**
   * Pin one Session and install the returned complete pin set.
   * A reply superseded by a later pin request or a pushed set installs nothing.
   * @param sessionId - Session to pin.
   * @returns generated Remote result.
   */
  async pinSession(
    sessionId: WorkspacePinSessionRequest['sessionId'],
  ): Promise<RemoteResult<WorkspacePinValue>> {
    const requestSeq = ++this.pinRequestSeq
    const result = await this.remote.pinSession({ sessionId })
    if (result.ok && requestSeq === this.pinRequestSeq) {
      this.installPinned(result.value.pinnedSessionIds)
    }
    return result
  }

  /**
   * Unpin one Session and install the returned complete pin set.
   * A reply superseded by a later pin request or a pushed set installs nothing.
   * @param sessionId - Session to unpin.
   * @returns generated Remote result.
   */
  async unpinSession(
    sessionId: WorkspaceUnpinSessionRequest['sessionId'],
  ): Promise<RemoteResult<WorkspacePinValue>> {
    const requestSeq = ++this.pinRequestSeq
    const result = await this.remote.unpinSession({ sessionId })
    if (result.ok && requestSeq === this.pinRequestSeq) {
      this.installPinned(result.value.pinnedSessionIds)
    }
    return result
  }

  /**
   * Replace the projection from one complete stream-generation baseline.
   * @param baseline - complete Workspace and archive projection.
   */
  replaceBaseline(baseline: WorkspaceBaseline): void {
    this.layoutFrameGeneration++
    this.archiveRequestSeq++
    this.pinRequestSeq++
    this.streamRevision++
    this.streamedRevisions.clear()
    for (const workspace of baseline.items) {
      this.streamedRevisions.set(workspace.workspaceId, this.streamRevision)
    }
    this.installViews(baseline.items)
    this.installLayout(baseline, true)
    this.installArchived(baseline.archivedSessionIds)
    this.installPinned(baseline.pinnedSessionIds)
    this.state = 'idle'
    this.phase = 'ready'
    this.error = null
    this.invalidate()
  }

  /** Merge one decoded Workspace upsert from the current follow generation. */
  upsertView(workspace: WorkspaceView): void {
    this.streamRevision++
    this.streamedRevisions.set(workspace.workspaceId, this.streamRevision)
    this.upsert(workspace)
  }

  /** Apply one decoded Workspace removal from the current follow generation. */
  removeView(workspaceId: WorkspaceId): void {
    this.remove(workspaceId)
  }

  /** Replace the Host-confirmed layout from the current follow generation. */
  replaceLayout(layout: WorkspaceLayout): void {
    this.layoutFrameGeneration++
    this.installLayout(layout, true)
  }

  /**
   * Replace the archived Session set from the current follow generation.
   * @param archivedSessionIds - complete Host-confirmed archive set.
   */
  replaceArchived(archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']): void {
    this.archiveRequestSeq++
    this.installArchived(archivedSessionIds)
  }

  /**
   * Replace the pinned Session set from the current follow generation.
   * @param pinnedSessionIds - complete Host-confirmed pin set, most recently pinned first.
   */
  replacePinned(pinnedSessionIds: WorkspacePinValue['pinnedSessionIds']): void {
    this.pinRequestSeq++
    this.installPinned(pinnedSessionIds)
  }

  /** Keep the last complete projection visible while a lost carrier reconnects. */
  handleCarrierFailure(): void {
    this.state = 'loading'
    this.error = null
    this.invalidate()
  }

  /**
   * Publish a non-retryable stream or protocol failure.
   * @param error - terminal stream failure.
   */
  handleStreamFailure(error: unknown): void {
    if (!isRemoteFailure(error)) throw error
    this.state = 'error'
    this.error = error
    this.invalidate()
  }

  /**
   * Subscribe to Workspace state invalidation.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the cached state, rebuilding it first when necessary.
   * @returns the current stable Workspace list snapshot.
   */
  getSnapshot(): WorkspaceSnapshot {
    this.refreshSnapshot()
    return this.snapshotCache
  }

  private buildSnapshot(): WorkspaceSnapshot {
    return {
      items: this.items,
      topLevelWorkspaceIds: this.topLevelWorkspaceIds,
      groups: this.groups,
      archivedSessionIds: this.archivedSessionIds,
      pinnedSessionIds: this.pinnedSessionIds,
      state: this.state,
      phase: this.phase,
      error: this.error,
    }
  }

  private installArchived(archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']): void {
    if (archivedSessionIds.length === this.archivedSessionIds.length
      && archivedSessionIds.every((id, index) => id === this.archivedSessionIds[index])) return
    this.archivedSessionIds = [...archivedSessionIds]
    this.invalidate()
  }

  private installPinned(pinnedSessionIds: WorkspacePinValue['pinnedSessionIds']): void {
    if (pinnedSessionIds.length === this.pinnedSessionIds.length
      && pinnedSessionIds.every((id, index) => id === this.pinnedSessionIds[index])) return
    this.pinnedSessionIds = [...pinnedSessionIds]
    this.invalidate()
  }

  /**
   * Merge a row-command echo unless a later follow frame updated that row.
   */
  private async rowMutation<T>(
    send: () => Promise<RemoteResult<T>>,
    view: (value: T) => WorkspaceView,
  ): Promise<RemoteResult<T>> {
    const streamRevision = this.streamRevision
    const result = await send()
    if (result.ok) {
      const workspace = view(result.value)
      const streamedRevision = this.streamedRevisions.get(workspace.workspaceId)
      if (streamedRevision === undefined || streamedRevision <= streamRevision) {
        this.upsert(workspace)
      }
    }
    return result
  }

  /**
   * Start one structural Remote request and install its layout unless a later
   * structural request or stream layout superseded it.
   */
  private async structural<T extends { readonly layout: WorkspaceLayout }>(
    send: () => Promise<RemoteResult<T>>,
  ): Promise<RemoteResult<T>> {
    const requestGeneration = ++this.layoutRequestGeneration
    const frameGeneration = this.layoutFrameGeneration
    const result = await send()
    if (result.ok
      && requestGeneration === this.layoutRequestGeneration
      && frameGeneration === this.layoutFrameGeneration) {
      this.installLayout(result.value.layout, true)
    }
    return result
  }

  /**
   * Re-sort the installed rows by one layout. Layout ids without a row are
   * skipped; rows the layout does not place stay at the end of the top level.
   */
  private installLayout(
    layout: Pick<WorkspaceLayout, 'topLevelWorkspaceIds' | 'groups'>,
    committed = false,
  ): void {
    if (committed) {
      this.committedLayout = {
        topLevelWorkspaceIds: [...layout.topLevelWorkspaceIds],
        groups: layout.groups,
      }
    }
    const rows = new Map(this.items.map(item => [item.workspaceId, item]))
    const groups = layout.groups.map(group => ({
      ...group,
      workspaceIds: group.workspaceIds.filter(id => rows.has(id)),
    }))
    const topLevel = layout.topLevelWorkspaceIds.filter(id => rows.has(id))
    const placed = new Set([...topLevel, ...groups.flatMap(group => group.workspaceIds)])
    const unplaced = this.items.map(item => item.workspaceId).filter(id => !placed.has(id))
    const nextTopLevel = [...topLevel, ...unplaced]
    const ordered = [...nextTopLevel, ...groups.flatMap(group => group.workspaceIds)]
    const nextItems = ordered.flatMap((id) => {
      const row = rows.get(id)
      return row === undefined ? [] : [row]
    })
    const nextGroups = groups.map((group, index) => {
      const previous = this.groups[index]
      return previous !== undefined && sameGroup(group, previous) ? previous : group
    })
    const unchanged = nextItems.length === this.items.length
      && nextItems.every((item, index) => item === this.items[index])
      && sameIds(nextTopLevel, this.topLevelWorkspaceIds)
      && nextGroups.length === this.groups.length
      && nextGroups.every((group, index) => group === this.groups[index])
    if (unchanged) return
    this.items = nextItems
    this.topLevelWorkspaceIds = nextTopLevel
    this.groups = nextGroups
    this.invalidate()
  }

  private upsert(view: WorkspaceView): void {
    if (this.removedIds.has(view.workspaceId)) {
      return
    }
    const index = this.items.findIndex(item => item.workspaceId === view.workspaceId)
    const installed = this.items[index]
    if (installed !== undefined && Date.parse(view.updatedAt) < Date.parse(installed.updatedAt)) {
      return
    }
    if (index === -1) {
      this.committedLayout = {
        ...this.committedLayout,
        topLevelWorkspaceIds: [view.workspaceId, ...this.committedLayout.topLevelWorkspaceIds],
      }
      this.topLevelWorkspaceIds = [view.workspaceId, ...this.topLevelWorkspaceIds]
    }
    this.items = index === -1
      ? [view, ...this.items]
      : this.items.map((item, position) => position === index ? view : item)
    this.invalidate()
  }

  private remove(workspaceId: WorkspaceId, immediate = false): void {
    this.removedIds.add(workspaceId)
    this.streamedRevisions.delete(workspaceId)
    this.committedLayout = withoutWorkspace(this.committedLayout, workspaceId)
    const items = this.items.filter(item => item.workspaceId !== workspaceId)
    if (items.length === this.items.length) {
      // A successful unary echo still publishes an earlier increment's
      // pending removal before the user operation resolves.
      if (immediate) this.invalidate(true)
      return
    }
    this.items = items
    this.topLevelWorkspaceIds = this.topLevelWorkspaceIds.filter(id => id !== workspaceId)
    this.groups = this.groups.map(group => group.workspaceIds.includes(workspaceId)
      ? { ...group, workspaceIds: group.workspaceIds.filter(id => id !== workspaceId) }
      : group)
    this.invalidate(immediate)
  }

  private installViews(views: readonly WorkspaceView[]): void {
    const installed = new Map<WorkspaceId, WorkspaceView>()
    for (const view of views) {
      if (!this.removedIds.has(view.workspaceId)) installed.set(view.workspaceId, view)
    }
    this.items = [...installed.values()]
  }

  private invalidate(immediate = false): void {
    this.snapshotDirty = true
    this.notificationPending = true
    if (immediate) {
      this.notificationGeneration++
      this.notificationScheduled = false
      this.flush()
      return
    }
    if (this.notificationScheduled) return
    this.notificationScheduled = true
    const generation = ++this.notificationGeneration
    queueMicrotask(() => {
      if (generation !== this.notificationGeneration) return
      this.notificationScheduled = false
      this.flush()
    })
  }

  private flush(): void {
    if (!this.notificationPending || this.listeners.size === 0) return
    this.notificationPending = false
    this.refreshSnapshot()
    notifySubscribers(this.listeners, '[workspace-controller]')
  }

  private refreshSnapshot(): void {
    if (!this.snapshotDirty) return
    this.snapshotDirty = false
    this.snapshotCache = this.buildSnapshot()
  }
}

function insertIdBefore(
  ids: readonly WorkspaceId[],
  id: WorkspaceId,
  beforeId?: WorkspaceId,
): WorkspaceId[] {
  if (!ids.includes(id) || (beforeId !== undefined && !ids.includes(beforeId)) || beforeId === id) {
    return [...ids]
  }
  const without = ids.filter(candidate => candidate !== id)
  const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
  return [...without.slice(0, at), id, ...without.slice(at)]
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function sameGroup(group: WorkspaceGroupView, installed: WorkspaceGroupView | undefined): boolean {
  return installed !== undefined
    && installed.groupId === group.groupId
    && installed.title === group.title
    && installed.createdAt === group.createdAt
    && installed.updatedAt === group.updatedAt
    && sameIds(installed.workspaceIds, group.workspaceIds)
}

function withoutWorkspace(layout: WorkspaceLayout, workspaceId: WorkspaceId): WorkspaceLayout {
  return {
    topLevelWorkspaceIds: layout.topLevelWorkspaceIds.filter(id => id !== workspaceId),
    groups: layout.groups.map(group => group.workspaceIds.includes(workspaceId)
      ? { ...group, workspaceIds: group.workspaceIds.filter(id => id !== workspaceId) }
      : group),
  }
}
