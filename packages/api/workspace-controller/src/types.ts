/**
 * Browser-safe request, result, and state-stream vocabulary for the Workspace
 * and directory-picking Remote namespaces this package owns. The picking seam
 * declares its own listing types, so they are re-exported here rather than
 * restated: a browser consumer reads the very declaration the backend answers.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FolderId, GroupId, SessionActivity, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type { FolderId, GroupId, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap,
} from '@deepseek-ai/dsh-workspace/types'
export type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

/** One logical Session Folder of a Workspace projected for browser consumers. */
export interface WorkspaceFolderView {
  readonly folderId: FolderId
  /** User-visible title, unique within its Workspace at the command surface. */
  readonly title: string
  /** Sessions filed in this Folder, in display order. */
  readonly sessionIds: readonly SessionId[]
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 last-mutation instant. */
  readonly updatedAt: string
}

/** One durable Workspace Group projected for browser consumers. */
export interface WorkspaceGroupView {
  readonly groupId: GroupId
  /** User-visible title, unique across Groups at the command surface. */
  readonly title: string
  /** Workspaces filed in this Group, in display order. */
  readonly workspaceIds: readonly WorkspaceId[]
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 last-mutation instant. */
  readonly updatedAt: string
}

/**
 * Complete Workspace containment and order. Every Workspace appears exactly
 * once: in {@link topLevelWorkspaceIds} or in one Group's `workspaceIds`.
 */
export interface WorkspaceLayout {
  /** Workspaces outside every Group, in display order. */
  readonly topLevelWorkspaceIds: readonly WorkspaceId[]
  /** Groups in display order. */
  readonly groups: readonly WorkspaceGroupView[]
}

/** One durable Workspace projected for browser consumers. */
export interface WorkspaceView {
  readonly workspaceId: WorkspaceId
  /** Canonical host directory path. */
  readonly path: string
  /** User-visible title. */
  readonly title: string
  /** Sessions accounted to this Workspace in manual order. */
  readonly sessionIds: readonly SessionId[]
  /**
   * Logical Session Folders in display order. A Session in `sessionIds` that
   * no Folder lists is filed at the Workspace root.
   */
  readonly folders: readonly WorkspaceFolderView[]
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 last-mutation instant. */
  readonly updatedAt: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The requested directory cannot back a Workspace. */
    'workspace/invalid-path': { readonly path: string }
    /** Another Workspace already uses the requested name. */
    'workspace/name-conflict': { readonly name: string }
    /**
     * The Session still has running work — its own turn, a subagent, a
     * background job, or an active schedule — so archiving was refused
     * without a write; `activity` names what must stop first.
     */
    'workspace/session-active': {
      readonly sessionId: SessionId
      readonly activity: readonly SessionActivity[]
    }
    /** The Session or its anchor is not in the Workspace's manual order. */
    'workspace/move-invalid': {
      readonly workspaceId: WorkspaceId
      readonly sessionId: SessionId
      readonly beforeSessionId?: SessionId
    }
    /** The requested Workspace Group does not exist. */
    'workspace/group-not-found': { readonly groupId: GroupId }
    /** Another Workspace Group already uses the requested title. */
    'workspace/group-name-conflict': { readonly title: string }
    /** The requested Folder does not exist in the named Workspace. */
    'workspace/folder-not-found': {
      readonly workspaceId: WorkspaceId
      readonly folderId: FolderId
    }
    /** Another Folder in the Workspace already uses the requested title. */
    'workspace/folder-name-conflict': {
      readonly workspaceId: WorkspaceId
      readonly title: string
    }
    /** The Session cannot be filed in the named Workspace or Folder. */
    'workspace/folder-move-invalid': {
      readonly workspaceId: WorkspaceId
      readonly sessionId: SessionId
    }
    /** The verb needs an interaction the composed backend does not serve. */
    'directory-picker/unavailable': { readonly capability: string }
    /** The target is not fully qualified, or the backend cannot list it. */
    'directory-picker/unreadable': { readonly path: string }
    /** A child of that name is already there. */
    'directory-picker/exists': { readonly path: string }
    /** The parent is not fully qualified, the name is not one segment, or creation failed. */
    'directory-picker/create-failed': { readonly path: string }
  }
}

/** Existing directory requested for Workspace adoption. */
export interface WorkspaceCreateRequest {
  readonly path: string
}

/** Created or previously registered Workspace. */
export interface WorkspaceCreateValue {
  readonly workspace: WorkspaceView
  readonly created: boolean
}

/** Workspace title mutation. */
export interface WorkspaceRenameRequest {
  readonly workspaceId: WorkspaceId
  readonly title: string
}

/** Workspace mutation returning the complete changed row. */
export interface WorkspaceValue {
  readonly workspace: WorkspaceView
}

/** Workspace registration deletion. */
export interface WorkspaceDeleteRequest {
  readonly workspaceId: WorkspaceId
}

/** Receipt after one Workspace registration is deleted. */
export interface WorkspaceDeleteValue {
  readonly deleted: true
}

/** DOM-insertBefore-like top-level Workspace order mutation. */
export interface WorkspaceInsertBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly beforeWorkspaceId?: WorkspaceId
}

/** Complete top-level Workspace order after a mutation; Group members are not listed. */
export interface WorkspaceOrderValue {
  readonly workspaceIds: readonly WorkspaceId[]
}

/** DOM-insertBefore-like Session membership order mutation. */
export interface WorkspaceInsertSessionBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly beforeSessionId?: SessionId
}

/** Session requested for archival from Workspace grouping surfaces. */
export interface WorkspaceArchiveSessionRequest {
  readonly sessionId: SessionId
  /**
   * Stop the Session's running work — its turn, subagent descendants, owned
   * background jobs, and active schedules — instead of refusing the archive
   * as `workspace/session-active`. The stops are requested before the
   * archive write and are not awaited; the response arrives once the archive
   * set is durable.
   */
  readonly stopActivity?: boolean
}

/** Session requested for restoration from the archived Session list. */
export interface WorkspaceUnarchiveSessionRequest {
  readonly sessionId: SessionId
}

/** Complete archived Session set after a mutation. */
export interface WorkspaceArchiveValue {
  readonly archivedSessionIds: readonly SessionId[]
}

/** Session requested for pinning ahead of unpinned Sessions on grouping surfaces. */
export interface WorkspacePinSessionRequest {
  readonly sessionId: SessionId
}

/** Session requested for removal from the pin set. */
export interface WorkspaceUnpinSessionRequest {
  readonly sessionId: SessionId
}

/** Complete pinned Session set after a mutation, most recently pinned first. */
export interface WorkspacePinValue {
  readonly pinnedSessionIds: readonly SessionId[]
}

/** Workspace Group creation. */
export interface WorkspaceGroupCreateRequest {
  /** Proposed title; trimmed and rejected when blank or already used by another Group. */
  readonly title: string
}

/** Workspace Group title mutation. */
export interface WorkspaceGroupRenameRequest {
  readonly groupId: GroupId
  /** Proposed title; trimmed and rejected when blank or already used by another Group. */
  readonly title: string
}

/** Workspace Group dissolution; filed Workspaces return to the top level. */
export interface WorkspaceGroupDeleteRequest {
  readonly groupId: GroupId
}

/** Workspace filing into a Group, or back to the top level. */
export interface WorkspaceMoveToGroupRequest {
  readonly workspaceId: WorkspaceId
  /** Target Group; omitted files the Workspace at the head of the top-level order. */
  readonly groupId?: GroupId
}

/** Group mutation returning the changed Group and the complete resulting layout. */
export interface WorkspaceGroupValue {
  readonly group: WorkspaceGroupView
  readonly layout: WorkspaceLayout
}

/** Structural mutation returning the complete resulting layout. */
export interface WorkspaceLayoutValue {
  readonly layout: WorkspaceLayout
}

/** Session Folder creation inside one Workspace. */
export interface WorkspaceFolderCreateRequest {
  readonly workspaceId: WorkspaceId
  /** Proposed title; trimmed and rejected when blank or already used in the Workspace. */
  readonly title: string
}

/** Session Folder title mutation. */
export interface WorkspaceFolderRenameRequest {
  readonly workspaceId: WorkspaceId
  readonly folderId: FolderId
  /** Proposed title; trimmed and rejected when blank or already used in the Workspace. */
  readonly title: string
}

/** Session Folder removal; its Sessions return to the Workspace root. */
export interface WorkspaceFolderDeleteRequest {
  readonly workspaceId: WorkspaceId
  readonly folderId: FolderId
}

/** Session filing into a Folder, or back to the Workspace root. */
export interface WorkspaceMoveSessionToFolderRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  /** Target Folder; omitted returns the Session to the Workspace root. */
  readonly folderId?: FolderId
}

/** Folder creation result: the new Folder and its complete owning Workspace row. */
export interface WorkspaceFolderValue {
  readonly folder: WorkspaceFolderView
  readonly workspace: WorkspaceView
}

/** Complete reconnect baseline for Workspace browser state. */
export interface WorkspaceBaseline {
  /** Every Workspace, including those filed in a Group. */
  readonly items: readonly WorkspaceView[]
  /** Workspaces outside every Group, in display order. */
  readonly topLevelWorkspaceIds: readonly WorkspaceId[]
  /** Groups in display order. */
  readonly groups: readonly WorkspaceGroupView[]
  readonly archivedSessionIds: readonly SessionId[]
  /** Registry-global pin set, most recently pinned first. */
  readonly pinnedSessionIds: readonly SessionId[]
}

/**
 * One ordered Workspace change after a generation's baseline. `replace`
 * carries the complete state that supersedes everything delivered before it
 * in the generation; it is a change, not a new generation's opening frame.
 */
export type WorkspaceFollowIncrement =
  | { readonly type: 'replace'; readonly value: WorkspaceBaseline }
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'layout'; readonly layout: WorkspaceLayout }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }
  | { readonly type: 'pinned'; readonly pinnedSessionIds: readonly SessionId[] }

/** Workspace state stream; every generation starts with exactly one baseline. */
export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
  | WorkspaceFollowIncrement
