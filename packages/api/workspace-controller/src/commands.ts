/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import type { Workspace, WorkspaceGroup } from '@deepseek-ai/dsh-workspace'
import {
  FolderId,
  GroupId,
  WorkspaceActiveSessionError,
  WorkspaceArchivedSessionPinError,
  WorkspaceFolderInvalidError,
  WorkspaceGroupUnknownError,
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { folderView, groupView, workspaceLayout, workspaceView } from './feed.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFolderCreateRequest,
  WorkspaceFolderDeleteRequest,
  WorkspaceFolderRenameRequest,
  WorkspaceFolderValue,
  WorkspaceGroupCreateRequest,
  WorkspaceGroupDeleteRequest,
  WorkspaceGroupRenameRequest,
  WorkspaceGroupValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceLayoutValue,
  WorkspaceMoveSessionToFolderRequest,
  WorkspaceMoveToGroupRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Create or resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.enqueue(async () => {
      try {
        const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path)
        if (existing !== undefined) {
          return { workspace: workspaceView(existing), created: false }
        }
        const workspace = await this.ctx.workspaceRegistry.create(request.path)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) {
          throw error
        }
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title)) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.enqueue(async () => {
      try {
        const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
          WorkspaceId(request.workspaceId),
          request.beforeWorkspaceId === undefined
            ? undefined
            : WorkspaceId(request.beforeWorkspaceId),
        )
        return { workspaceIds: [...workspaceIds] }
      } catch (error) {
        if (!(error instanceof WorkspaceOrderInvalidError)) {
          throw error
        }
        throw workspaceNotFound(error.workspaceId)
      }
    })
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      try {
        await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
      } catch (error) {
        if (!(error instanceof WorkspaceMoveInvalidError)) {
          throw error
        }
        throw new RemoteError(
          'workspace/move-invalid',
          error.message,
          {
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            ...request.beforeSessionId === undefined
              ? {}
              : { beforeSessionId: request.beforeSessionId },
          },
          { cause: error },
        )
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Add one known Session to the registry-global archive set. Without
   * `stopActivity` a Session with running work is refused as
   * `workspace/session-active` with the activity the registry's providers
   * reported; with it, the providers stop that work first.
   * @param request - Session identity to archive and whether to stop its work.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(
        request.sessionId,
        request.stopActivity === true ? { stopActivity: true } : {},
      )
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceActiveSessionError) {
        throw new RemoteError(
          'workspace/session-active',
          error.message,
          { sessionId: request.sessionId, activity: error.activity },
          { cause: error },
        )
      }
      throw error
    }
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global archive set. An id that is not
   * archived is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.enqueue(async () => {
      await this.ctx.workspaceRegistry.unarchiveSession(request.sessionId)
      return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
    })
  }

  /**
   * Create one Workspace Group at the head of the Group order.
   * @param request - proposed unique non-blank title.
   * @returns the new Group and the complete resulting layout.
   */
  createGroup(request: WorkspaceGroupCreateRequest): Promise<WorkspaceGroupValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(blankTitle('Group creation'))
    }
    return this.enqueue(async () => {
      this.requireUniqueGroupTitle(title)
      const group = await this.ctx.workspaceRegistry.createGroup(title)
      return { group: groupView(group), layout: workspaceLayout(this.ctx.workspaceRegistry) }
    })
  }

  /**
   * Rename one Workspace Group to a unique non-blank title.
   * @param request - Group identity and proposed title.
   * @returns the updated Group and the complete resulting layout.
   */
  renameGroup(request: WorkspaceGroupRenameRequest): Promise<WorkspaceGroupValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(blankTitle('Group rename'))
    }
    return this.enqueue(async () => {
      const group = this.requireGroup(request.groupId)
      if (title !== group.title) {
        this.requireUniqueGroupTitle(title, group.id)
        await group.setTitle(title)
      }
      return { group: groupView(group), layout: workspaceLayout(this.ctx.workspaceRegistry) }
    })
  }

  /**
   * Dissolve one Group; its Workspaces return to the head of the top level.
   * @param request - Group identity to remove.
   * @returns the complete resulting layout.
   */
  deleteGroup(request: WorkspaceGroupDeleteRequest): Promise<WorkspaceLayoutValue> {
    return this.enqueue(async () => {
      try {
        await this.ctx.workspaceRegistry.deleteGroup(GroupId(request.groupId))
      } catch (error) {
        throw mapGroupFailure(error)
      }
      return { layout: workspaceLayout(this.ctx.workspaceRegistry) }
    })
  }

  /**
   * File one Workspace in a Group, optionally before another Group member, or lift it back to the top level.
   * @param request - Workspace identity, optional target Group, and optional member anchor.
   * @returns the complete resulting layout.
   */
  moveToGroup(request: WorkspaceMoveToGroupRequest): Promise<WorkspaceLayoutValue> {
    return this.enqueue(async () => {
      try {
        await this.ctx.workspaceRegistry.moveToGroup(
          WorkspaceId(request.workspaceId),
          request.groupId === undefined ? undefined : GroupId(request.groupId),
          request.beforeWorkspaceId === undefined || request.beforeWorkspaceId === null
            ? request.beforeWorkspaceId
            : WorkspaceId(request.beforeWorkspaceId),
        )
      } catch (error) {
        throw mapGroupFailure(error)
      }
      return { layout: workspaceLayout(this.ctx.workspaceRegistry) }
    })
  }

  /**
   * Create one Session Folder at the end of a Workspace's Folder order.
   * @param request - Workspace identity and proposed unique non-blank title.
   * @returns the new Folder and its complete owning Workspace.
   */
  createFolder(request: WorkspaceFolderCreateRequest): Promise<WorkspaceFolderValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(blankTitle('Folder creation'))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      requireUniqueFolderTitle(workspace, title)
      const folder = await workspace.createFolder(title)
      return { folder: folderView(folder), workspace: workspaceView(workspace) }
    })
  }

  /**
   * Rename one Session Folder to a title unique within its Workspace.
   * @param request - Workspace, Folder, and proposed title.
   * @returns the updated Workspace projection.
   */
  renameFolder(request: WorkspaceFolderRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(blankTitle('Folder rename'))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      const folder = workspace.folders.find(candidate => candidate.id === request.folderId)
      if (folder === undefined) {
        throw folderNotFound(request.workspaceId, request.folderId)
      }
      if (title !== folder.title) {
        requireUniqueFolderTitle(workspace, title, folder.id)
        await this.guardFolder(request.workspaceId, request.folderId, undefined, () =>
          workspace.setFolderTitle(FolderId(request.folderId), title))
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Remove one Session Folder; its Sessions return to the Workspace root.
   * @param request - Workspace and Folder identities.
   * @returns the updated Workspace projection.
   */
  deleteFolder(request: WorkspaceFolderDeleteRequest): Promise<WorkspaceValue> {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      await this.guardFolder(request.workspaceId, request.folderId, undefined, () =>
        workspace.deleteFolder(FolderId(request.folderId)))
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * File one accounted Session in a Folder, or return it to the Workspace root.
   * @param request - Workspace, Session, and optional target Folder.
   * @returns the updated Workspace projection.
   */
  moveSessionToFolder(request: WorkspaceMoveSessionToFolderRequest): Promise<WorkspaceValue> {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      await this.guardFolder(request.workspaceId, request.folderId, request.sessionId, () =>
        workspace.moveSessionToFolder(
          request.sessionId,
          request.folderId === undefined ? undefined : FolderId(request.folderId),
        ))
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Run one Folder mutation and translate its domain rejection. An unknown
   * Folder maps to `workspace/folder-not-found`; any other rejection names the
   * unaccounted Session (`workspace/folder-move-invalid`).
   */
  private async guardFolder(
    workspaceId: WorkspaceId,
    folderId: FolderId | undefined,
    sessionId: WorkspaceMoveSessionToFolderRequest['sessionId'] | undefined,
    mutate: () => Promise<void>,
  ): Promise<void> {
    try {
      await mutate()
    } catch (error) {
      if (!(error instanceof WorkspaceFolderInvalidError)) {
        throw error
      }
      const workspace = this.ctx.workspaceRegistry.get(workspaceId)
      if (folderId !== undefined && workspace?.folders.some(folder => folder.id === folderId) !== true) {
        throw folderNotFound(workspaceId, folderId)
      }
      if (sessionId === undefined) {
        throw error
      }
      throw new RemoteError(
        'workspace/folder-move-invalid',
        error.message,
        { workspaceId, sessionId },
        { cause: error },
      )
    }
  }

  private requireGroup(groupId: GroupId): WorkspaceGroup {
    const group = this.ctx.workspaceRegistry.getGroup(GroupId(groupId))
    if (group === undefined) {
      throw groupNotFound(groupId)
    }
    return group
  }

  private requireUniqueGroupTitle(title: string, exceptGroupId?: GroupId): void {
    if (this.ctx.workspaceRegistry.listGroups().some(group =>
      group.id !== exceptGroupId && group.title === title)) {
      throw new RemoteError(
        'workspace/group-name-conflict',
        `Group name '${title}' is already in use`,
        { title },
      )
    }
  }

  /**
   * Add one known unarchived Session to the registry-global pin set.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    try {
      await this.ctx.workspaceRegistry.pinSession(request.sessionId)
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceArchivedSessionPinError) {
        throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
      }
      throw error
    }
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global pin set. An id that is not
   * pinned is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    await this.ctx.workspaceRegistry.unpinSession(request.sessionId)
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) {
      throw workspaceNotFound(workspaceId)
    }
    return workspace
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function groupNotFound(groupId: GroupId): RemoteError<'workspace/group-not-found'> {
  return new RemoteError(
    'workspace/group-not-found',
    `Workspace Group "${groupId}" not found`,
    { groupId },
  )
}

function folderNotFound(workspaceId: WorkspaceId, folderId: FolderId): RemoteError<'workspace/folder-not-found'> {
  return new RemoteError(
    'workspace/folder-not-found',
    `Folder "${folderId}" not found in Workspace "${workspaceId}"`,
    { workspaceId, folderId },
  )
}

function mapGroupFailure(error: unknown): unknown {
  if (error instanceof WorkspaceGroupUnknownError) {
    return groupNotFound(error.groupId)
  }
  if (error instanceof WorkspaceOrderInvalidError) {
    return workspaceNotFound(error.workspaceId)
  }
  return error
}

function blankTitle(operation: string): RemoteError<'gateway/bad-request'> {
  return new RemoteError('gateway/bad-request', `${operation} requires a non-blank title`, {})
}

function requireUniqueFolderTitle(workspace: Workspace, title: string, exceptFolderId?: FolderId): void {
  if (workspace.folders.some(folder => folder.id !== exceptFolderId && folder.title === title)) {
    throw new RemoteError(
      'workspace/folder-name-conflict',
      `Folder name '${title}' is already in use in Workspace "${workspace.id}"`,
      { workspaceId: workspace.id, title },
    )
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
