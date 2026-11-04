/** Test-owned workspaces face: the renderer standard-kit observable plus recorded actions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  IWorkspaces, FolderId, GroupId, WorkspaceFolderView, WorkspaceGroupView, WorkspaceId,
  WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { workspaceSnapshot } from './fixtures.ts'
import type { FixtureSnapshot, Stabilizer } from './fixtures.ts'

/** Writable test representation of the immutable Workspace Controller snapshot. */
type WorkspaceFixtureSnapshot = FixtureSnapshot<WorkspaceSnapshot>

/** Callable command names on the production Workspace Controller face. */
type WorkspaceAction = {
  [Key in keyof IWorkspaces]: IWorkspaces[Key] extends (...args: never[]) => unknown ? Key : never
}[keyof IWorkspaces]

/** Test replacement retaining one Controller command's parameters and result. */
type WorkspaceStub<Key extends WorkspaceAction> = (
  ...args: Parameters<IWorkspaces[Key]>
) => ReturnType<IWorkspaces[Key]>

/**
 * Workspaces test double. Implements the same IWorkspaces face features
 * receive as `ctx.workspaces`, so a production face change breaks this
 * double at compile time. Every action records into {@link
 * TestWorkspaces.calls}; defaults are inert echoes — feature tests needing
 * richer behavior replace them via {@link TestWorkspaces.stub}.
 */
export class TestWorkspaces implements IWorkspaces {
  /** The useWorkspaces standard feed. */
  readonly list: SnapshotStore<WorkspaceFixtureSnapshot>

  /** Calls observed on the action face, newest last. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** Replaceable action seat: feature tests may stub richer behavior. */
  private readonly stubs = new Map<WorkspaceAction, (...args: unknown[]) => unknown>()

  /**
   * @param stabilize - the owning runtime's act wrapper.
   */
  constructor(private readonly stabilize: Stabilizer) {
    this.list = createSnapshotStore<WorkspaceFixtureSnapshot>({ ...workspaceSnapshot() })
  }

  /**
   * Update the workspace list state through an immer draft.
   * @param mutate - draft mutator.
   */
  async update(mutate: (draft: WorkspaceFixtureSnapshot) => void): Promise<void> {
    await this.stabilize(() => { this.list.update(mutate) })
  }

  /**
   * Replace an action's behavior (the recorded call is still appended first).
   * @param method - Controller action name (e.g. 'create').
   * @param impl - replacement behavior.
   */
  stub<Key extends WorkspaceAction>(method: Key, impl: WorkspaceStub<Key>): void {
    this.stubs.set(method, impl as (...args: unknown[]) => unknown)
  }

  /**
   * Create a Workspace (recorded). The default echoes a view derived from
   * the input; stub for failure or list-coupled flows.
   * @param input - the Host create payload.
   * @returns the created Workspace view.
   */
  async create(input: { path: string }): Promise<WorkspaceView> {
    this.calls.push({ method: 'create', args: [input] })
    const stub = this.stubs.get('create')
    if (stub !== undefined) return await (stub(input) as Promise<WorkspaceView>)
    return {
      workspaceId: `ws-${input.path}` as WorkspaceId,
      title: input.path,
      path: input.path,
      sessionIds: [],
    } as unknown as WorkspaceView
  }

  /**
   * Initialize the default Workspace through a test stub; defaults to an ineligible first use.
   * @param signal - caller lifetime.
   * @returns the stubbed Workspace, or undefined when initialization is ineligible.
   */
  async initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined> {
    this.calls.push({ method: 'initializeDefault', args: [signal] })
    const stub = this.stubs.get('initializeDefault')
    return await (stub?.(signal) as Promise<WorkspaceView | undefined> | undefined)
  }

  /**
   * Rename a Workspace (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param title - new title.
   * @returns the updated view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'rename', args: [workspaceId, title] })
    const stub = this.stubs.get('rename')
    if (stub !== undefined) return await (stub(workspaceId, title) as Promise<WorkspaceView>)
    return { workspaceId, title, path: `/${title}`, sessionIds: [] } as unknown as WorkspaceView
  }

  /**
   * Delete a Workspace (recorded; default no-op).
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'delete', args: [workspaceId] })
    await (this.stubs.get('delete')?.(workspaceId) as Promise<void> | undefined)
  }

  /**
   * Move a Workspace in display order (recorded; default no-op).
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'insertBefore', args: [workspaceId, beforeWorkspaceId] })
    await (this.stubs.get('insertBefore')?.(workspaceId, beforeWorkspaceId) as Promise<void> | undefined)
  }

  /**
   * Move an accounted session (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param sessionId - session to move.
   * @param beforeSessionId - anchor; omitted appends.
   * @returns the updated view.
   */
  async insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView> {
    this.calls.push({ method: 'insertSessionBefore', args: [workspaceId, sessionId, beforeSessionId] })
    const stub = this.stubs.get('insertSessionBefore')
    if (stub !== undefined) return await (stub(workspaceId, sessionId, beforeSessionId) as Promise<WorkspaceView>)
    return { workspaceId, title: '', path: '', sessionIds: [sessionId] } as unknown as WorkspaceView
  }

  /**
   * Archive a session (recorded). The default mirrors the production face's
   * observable effect: the id joins the list state's archive set.
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'archiveSession', args: [sessionId] })
    const stub = this.stubs.get('archiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = [...draft.archivedSessionIds, sessionId]
    })
  }

  /**
   * Create a Workspace Group (recorded). The default echoes a minimal empty
   * Group; stub for failure or layout-coupled flows.
   * @param title - Group title.
   * @returns the created Group view.
   */
  async createGroup(title: string): Promise<WorkspaceGroupView> {
    this.calls.push({ method: 'createGroup', args: [title] })
    const stub = this.stubs.get('createGroup')
    if (stub !== undefined) return await (stub(title) as Promise<WorkspaceGroupView>)
    return {
      groupId: `group-${title}` as GroupId, title, workspaceIds: [], createdAt: '', updatedAt: '',
    } as unknown as WorkspaceGroupView
  }

  /**
   * Rename a Workspace Group (recorded). The default echoes a minimal Group.
   * @param groupId - target Group.
   * @param title - new title.
   * @returns the renamed Group view.
   */
  async renameGroup(groupId: GroupId, title: string): Promise<WorkspaceGroupView> {
    this.calls.push({ method: 'renameGroup', args: [groupId, title] })
    const stub = this.stubs.get('renameGroup')
    if (stub !== undefined) return await (stub(groupId, title) as Promise<WorkspaceGroupView>)
    return {
      groupId, title, workspaceIds: [], createdAt: '', updatedAt: '',
    } as unknown as WorkspaceGroupView
  }

  /**
   * Dissolve a Workspace Group (recorded; default no-op).
   * @param groupId - Group to dissolve.
   */
  async deleteGroup(groupId: GroupId): Promise<void> {
    this.calls.push({ method: 'deleteGroup', args: [groupId] })
    await (this.stubs.get('deleteGroup')?.(groupId) as Promise<void> | undefined)
  }

  /**
   * File a Workspace in a Group or lift it to the top level (recorded; default no-op).
   * @param workspaceId - Workspace to file.
   * @param groupId - target Group; omitted lifts to the top level.
   */
  async moveToGroup(workspaceId: WorkspaceId, groupId?: GroupId): Promise<void> {
    this.calls.push({ method: 'moveToGroup', args: [workspaceId, groupId] })
    await (this.stubs.get('moveToGroup')?.(workspaceId, groupId) as Promise<void> | undefined)
  }

  /**
   * Create a Session Folder (recorded). The default echoes a minimal empty
   * Folder; stub for failure or list-coupled flows.
   * @param workspaceId - owning Workspace.
   * @param title - Folder title.
   * @returns the created Folder view.
   */
  async createFolder(workspaceId: WorkspaceId, title: string): Promise<WorkspaceFolderView> {
    this.calls.push({ method: 'createFolder', args: [workspaceId, title] })
    const stub = this.stubs.get('createFolder')
    if (stub !== undefined) return await (stub(workspaceId, title) as Promise<WorkspaceFolderView>)
    return {
      folderId: `folder-${title}` as FolderId, title, sessionIds: [], createdAt: '', updatedAt: '',
    } as unknown as WorkspaceFolderView
  }

  /**
   * Rename a Session Folder (recorded). The default echoes a minimal Workspace.
   * @param workspaceId - owning Workspace.
   * @param folderId - target Folder.
   * @param title - new title.
   * @returns the owning Workspace view.
   */
  async renameFolder(workspaceId: WorkspaceId, folderId: FolderId, title: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'renameFolder', args: [workspaceId, folderId, title] })
    const stub = this.stubs.get('renameFolder')
    if (stub !== undefined) {
      return await (stub(workspaceId, folderId, title) as Promise<WorkspaceView>)
    }
    return { workspaceId, title: '', path: '', sessionIds: [], folders: [] } as unknown as WorkspaceView
  }

  /**
   * Remove a Session Folder (recorded). The default echoes a minimal Workspace.
   * @param workspaceId - owning Workspace.
   * @param folderId - Folder to remove.
   * @returns the owning Workspace view.
   */
  async deleteFolder(workspaceId: WorkspaceId, folderId: FolderId): Promise<WorkspaceView> {
    this.calls.push({ method: 'deleteFolder', args: [workspaceId, folderId] })
    const stub = this.stubs.get('deleteFolder')
    if (stub !== undefined) return await (stub(workspaceId, folderId) as Promise<WorkspaceView>)
    return { workspaceId, title: '', path: '', sessionIds: [], folders: [] } as unknown as WorkspaceView
  }

  /**
   * File a Session in a Folder or return it to the root (recorded). The
   * default echoes a minimal Workspace.
   * @param workspaceId - owning Workspace.
   * @param sessionId - Session to file.
   * @param folderId - target Folder; omitted returns the Session to the root.
   * @returns the owning Workspace view.
   */
  async moveSessionToFolder(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    folderId?: FolderId,
  ): Promise<WorkspaceView> {
    this.calls.push({ method: 'moveSessionToFolder', args: [workspaceId, sessionId, folderId] })
    const stub = this.stubs.get('moveSessionToFolder')
    if (stub !== undefined) {
      return await (stub(workspaceId, sessionId, folderId) as Promise<WorkspaceView>)
    }
    return { workspaceId, title: '', path: '', sessionIds: [], folders: [] } as unknown as WorkspaceView
  }

  /**
   * Unarchive a session (recorded). The default mirrors the production face's
   * observable effect: the id leaves the list state's archive set.
   * @param sessionId - session to unarchive.
   */
  async unarchiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'unarchiveSession', args: [sessionId] })
    const stub = this.stubs.get('unarchiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = draft.archivedSessionIds.filter(id => id !== sessionId)
    })
  }

  /**
   * Pin a session (recorded). The default mirrors the production face's
   * observable effect: the id leads the list state's pin set.
   * @param sessionId - session to pin.
   */
  async pinSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'pinSession', args: [sessionId] })
    const stub = this.stubs.get('pinSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.pinnedSessionIds = [
        sessionId,
        ...draft.pinnedSessionIds.filter(id => id !== sessionId),
      ]
    })
  }

  /**
   * Unpin a session (recorded). The default mirrors the production face's
   * observable effect: the id leaves the list state's pin set.
   * @param sessionId - session to unpin.
   */
  async unpinSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'unpinSession', args: [sessionId] })
    const stub = this.stubs.get('unpinSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.pinnedSessionIds = draft.pinnedSessionIds.filter(id => id !== sessionId)
    })
  }
}
