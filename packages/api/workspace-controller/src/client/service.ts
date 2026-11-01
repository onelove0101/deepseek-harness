/** React-free Client Workspace service and command facade. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { FolderId, GroupId, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceFolderView, WorkspaceGroupView, WorkspaceView } from '../types.ts'
import type { ClientWorkspaceModel, WorkspaceSnapshot } from './model.ts'

/** Structured create failure for callers that distinguish Host business errors. */
export class WorkspaceCreateError extends Error {
  override readonly name = 'WorkspaceCreateError'

  /** @param rpcError - Host business or folded carrier failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/**
 * Archive failed on the Host. `rpcError.code` distinguishes the active-session
 * refusal (`workspace/session-active`, whose details name what still runs)
 * from a missing session or a carrier fault.
 */
export class WorkspaceArchiveError extends Error {
  override readonly name = 'WorkspaceArchiveError'

  /** @param rpcError - Host business or folded carrier failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`workspace session archive failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Structured Group or Folder command failure that preserves the Host failure code. */
export class WorkspaceCommandError extends Error {
  override readonly name = 'WorkspaceCommandError'

  /**
   * @param operation - failed command label.
   * @param rpcError - Host business or folded carrier failure.
   */
  constructor(operation: string, readonly rpcError: RemoteFailure) {
    super(`workspace ${operation} failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Bare observable source for the Workspace Controller snapshot. */
export interface WorkspaceSource {
  /** Read the identity-stable current snapshot. */
  getSnapshot(): WorkspaceSnapshot
  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** Workspace Controller's Client service face. */
export interface IWorkspaces {
  /** Host-authoritative Workspace rows, order, archive set, and follow lifecycle. */
  readonly list: WorkspaceSource
  /**
   * Register an existing path as a Workspace.
   * @param input - Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  create(input: { path: string }): Promise<WorkspaceView>
  /**
   * Initialize or reuse the default Workspace.
   * @param signal - caller lifetime.
   * @returns the prepared Workspace, or undefined when first-use initialization is ineligible; rejects on preparation failure.
   */
  initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined>
  /**
   * Rename a Workspace.
   * @param workspaceId - target Workspace.
   * @param title - new display title.
   * @returns the renamed Workspace.
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  /**
   * Delete a Workspace registration without deleting Sessions or files.
   * @param workspaceId - target Workspace.
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  /**
   * Move a Workspace within the Host registry order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - anchor Workspace; omitted appends.
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  /**
   * Archive a Session from Workspace grouping surfaces.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` asks the Host to stop the Session's running work instead of refusing.
   * @throws {WorkspaceArchiveError} when the Host refuses; without `stopActivity` a Session with
   *   running work fails as `workspace/session-active`, its details naming what runs.
   */
  archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
  /**
   * Unarchive a Session from the archived Session list.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * Pin a Session ahead of unpinned Sessions on Workspace grouping surfaces.
   * @param sessionId - Session to pin.
   */
  pinSession(sessionId: SessionId): Promise<void>
  /**
   * Remove a Session's pin without changing its saved Session order.
   * @param sessionId - Session to unpin.
   */
  unpinSession(sessionId: SessionId): Promise<void>
  /**
   * Move a Session within one Workspace account.
   * @param workspaceId - owning Workspace.
   * @param sessionId - Session to move.
   * @param beforeSessionId - anchor Session; omitted appends.
   * @returns the changed Workspace.
   */
  insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView>
  /**
   * Create a Workspace Group at the head of the Group order.
   * @param title - unique non-blank Group title.
   * @returns the created Group.
   * @throws {WorkspaceCommandError} when the Host rejects the title.
   */
  createGroup(title: string): Promise<WorkspaceGroupView>
  /**
   * Rename a Workspace Group.
   * @param groupId - target Group.
   * @param title - unique non-blank Group title.
   * @returns the renamed Group.
   * @throws {WorkspaceCommandError} when the Group is unknown or the title conflicts.
   */
  renameGroup(groupId: GroupId, title: string): Promise<WorkspaceGroupView>
  /**
   * Dissolve a Group; its Workspaces return to the top level.
   * @param groupId - Group to dissolve.
   * @throws {WorkspaceCommandError} when the Group is unknown.
   */
  deleteGroup(groupId: GroupId): Promise<void>
  /**
   * File a Workspace in a Group, or lift it to the top level.
   * @param workspaceId - Workspace to file.
   * @param groupId - target Group; omitted lifts to the top level.
   * @throws {WorkspaceCommandError} when the Workspace or Group is unknown.
   */
  moveToGroup(workspaceId: WorkspaceId, groupId?: GroupId): Promise<void>
  /**
   * Create a Session Folder inside a Workspace.
   * @param workspaceId - owning Workspace.
   * @param title - unique non-blank Folder title within the Workspace.
   * @returns the created Folder.
   * @throws {WorkspaceCommandError} when the Workspace is unknown or the title conflicts.
   */
  createFolder(workspaceId: WorkspaceId, title: string): Promise<WorkspaceFolderView>
  /**
   * Rename a Session Folder.
   * @param workspaceId - owning Workspace.
   * @param folderId - target Folder.
   * @param title - unique non-blank Folder title within the Workspace.
   * @returns the owning Workspace.
   * @throws {WorkspaceCommandError} when the Folder is unknown or the title conflicts.
   */
  renameFolder(workspaceId: WorkspaceId, folderId: FolderId, title: string): Promise<WorkspaceView>
  /**
   * Remove a Session Folder; its Sessions return to the Workspace root.
   * @param workspaceId - owning Workspace.
   * @param folderId - Folder to remove.
   * @returns the owning Workspace.
   * @throws {WorkspaceCommandError} when the Folder is unknown.
   */
  deleteFolder(workspaceId: WorkspaceId, folderId: FolderId): Promise<WorkspaceView>
  /**
   * File a Session in a Folder, or return it to the Workspace root.
   * @param workspaceId - owning Workspace.
   * @param sessionId - Session to file.
   * @param folderId - target Folder; omitted returns the Session to the root.
   * @returns the owning Workspace.
   * @throws {WorkspaceCommandError} when the Session or Folder is not owned by the Workspace.
   */
  moveSessionToFolder(workspaceId: WorkspaceId, sessionId: SessionId, folderId?: FolderId): Promise<WorkspaceView>
}

/** Owns the bare Workspace snapshot and Workspace-only commands. */
export class WorkspaceController extends Service implements IWorkspaces {
  readonly list: WorkspaceSource

  /**
   * @param ctx - Client root Context.
   * @param model - Remote-backed Workspace state model.
   */
  constructor(ctx: Context, private readonly model: ClientWorkspaceModel) {
    super(ctx, 'workspaces')
    this.list = model
  }

  async create(input: { path: string }): Promise<WorkspaceView> {
    const result = await this.model.create(input)
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return result.value.workspace
  }

  async initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined> {
    const result = await this.model.initializeDefault(signal)
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return result.value?.workspace
  }

  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const result = await this.model.rename(workspaceId, title)
    if (!result.ok) throw commandError('rename', result.error)
    return result.value.workspace
  }

  async delete(workspaceId: WorkspaceId): Promise<void> {
    const result = await this.model.delete(workspaceId)
    if (!result.ok) throw commandError('delete', result.error)
  }

  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const result = await this.model.insertBefore(workspaceId, beforeWorkspaceId)
    if (!result.ok) throw commandError('reorder', result.error)
  }

  async archiveSession(sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    const result = await this.model.archiveSession(sessionId, options)
    if (!result.ok) throw new WorkspaceArchiveError(result.error)
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.unarchiveSession(sessionId)
    if (!result.ok) throw commandError('session unarchive', result.error)
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.pinSession(sessionId)
    if (!result.ok) throw commandError('session pin', result.error)
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.unpinSession(sessionId)
    if (!result.ok) throw commandError('session unpin', result.error)
  }

  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const result = await this.model.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    if (!result.ok) throw commandError('move', result.error)
    return result.value.workspace
  }

  async createGroup(title: string): Promise<WorkspaceGroupView> {
    const result = await this.model.createGroup(title)
    if (!result.ok) throw new WorkspaceCommandError('group create', result.error)
    return result.value.group
  }

  async renameGroup(groupId: GroupId, title: string): Promise<WorkspaceGroupView> {
    const result = await this.model.renameGroup(groupId, title)
    if (!result.ok) throw new WorkspaceCommandError('group rename', result.error)
    return result.value.group
  }

  async deleteGroup(groupId: GroupId): Promise<void> {
    const result = await this.model.deleteGroup(groupId)
    if (!result.ok) throw new WorkspaceCommandError('group delete', result.error)
  }

  async moveToGroup(workspaceId: WorkspaceId, groupId?: GroupId): Promise<void> {
    const result = await this.model.moveToGroup(workspaceId, groupId)
    if (!result.ok) throw new WorkspaceCommandError('group move', result.error)
  }

  async createFolder(workspaceId: WorkspaceId, title: string): Promise<WorkspaceFolderView> {
    const result = await this.model.createFolder(workspaceId, title)
    if (!result.ok) throw new WorkspaceCommandError('folder create', result.error)
    return result.value.folder
  }

  async renameFolder(workspaceId: WorkspaceId, folderId: FolderId, title: string): Promise<WorkspaceView> {
    const result = await this.model.renameFolder(workspaceId, folderId, title)
    if (!result.ok) throw new WorkspaceCommandError('folder rename', result.error)
    return result.value.workspace
  }

  async deleteFolder(workspaceId: WorkspaceId, folderId: FolderId): Promise<WorkspaceView> {
    const result = await this.model.deleteFolder(workspaceId, folderId)
    if (!result.ok) throw new WorkspaceCommandError('folder delete', result.error)
    return result.value.workspace
  }

  async moveSessionToFolder(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    folderId?: FolderId,
  ): Promise<WorkspaceView> {
    const result = await this.model.moveSessionToFolder(workspaceId, sessionId, folderId)
    if (!result.ok) throw new WorkspaceCommandError('folder move', result.error)
    return result.value.workspace
  }
}

function commandError(operation: string, failure: RemoteFailure): Error {
  return new Error(`workspace ${operation} failed: ${failure.code}: ${failure.message}`)
}
