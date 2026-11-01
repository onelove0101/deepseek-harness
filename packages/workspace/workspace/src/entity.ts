/**
 * Package-private workspace entity: the single {@link Workspace}
 * implementation. Holds a record snapshot that is swapped in place after each
 * durable mutation; every write funnels through the private `mutate` so
 * `updatedAt` stamping and invalid-account pruning happen exactly once.
 * Not re-exported from the package entrypoint — consumers see only the
 * `Workspace` interface.
 * @module @deepseek-ai/dsh-workspace/src/entity
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceFolderRecord, WorkspaceRecord } from './spec.ts'
import type { FolderId, Workspace, WorkspaceFolder, WorkspaceId } from './types.ts'
import { realpathNormalize } from './paths.ts'

/** An insertSessionBefore request named a session or anchor not on the account (storage failures stay plain errors). */
export class WorkspaceMoveInvalidError extends Error {
  /**
   * @param message - Which id was unaccounted and where.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMoveInvalidError'
  }
}

/** A Folder operation named an unknown folder or an unowned Session. */
export class WorkspaceFolderInvalidError extends Error {
  /**
   * @param message - The rejected filing or Folder operation.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceFolderInvalidError'
  }
}

/**
 * The registry-owned machinery an entity mutates through. Entities never see
 * the registry itself — only the open table, the canonical session-path
 * index backing the `sessionIds` projection, and attach-time header reads.
 */
export interface WorkspaceEntityHost {
  /**
   * Resolve the open `workspaces` table.
   * @returns the table; throws while the registry has not started yet.
   */
  table(): KvTable<WorkspaceId, WorkspaceRecord>

  /**
   * Validate an already-accounted session, preserving ownership when its fully
   * qualified cwd cannot resolve because a path component is missing.
   * @param id - Session already present in this workspace's candidate account.
   * @param path - Workspace's stored canonical directory.
   * @returns whether the candidate remains a member.
   */
  candidateMatches(id: SessionId, path: string): boolean

  /**
   * Read one stored session header for attach validation.
   * @param id - The session whose header to read.
   * @returns the header; rejects when session persistence is absent or holds
   * no session with this id.
   */
  readSessionHeader(id: SessionId): Promise<SessionHeader>

  /**
   * Publish a successfully validated canonical cwd to the projection index.
   * @param id - Validated session id.
   * @param path - Canonical existing directory from the immutable header cwd.
   */
  rememberSessionPath(id: SessionId, path: string): void
}

/** Chain-slot abort sentinel thrown by the update fn when the record needs no change; only `mutate` observes it. */
const unchangedSentinel = new Error('workspace record unchanged (internal sentinel)')

/** The single {@link Workspace} implementation; constructed only by the registry. */
export class WorkspaceEntity implements Workspace {
  private record: WorkspaceRecord

  /**
   * @param host - Registry-owned table, session-path index, and header reads.
   * @param id - The record's stable id.
   * @param record - The validated record snapshot loaded or just written.
   */
  constructor(
    private readonly host: WorkspaceEntityHost,
    readonly id: WorkspaceId,
    record: WorkspaceRecord,
  ) {
    this.record = record
  }

  get path(): string {
    return this.record.path
  }

  get title(): string {
    return this.record.title
  }

  get createdAt(): string {
    return this.record.createdAt
  }

  get updatedAt(): string {
    return this.record.updatedAt
  }

  get sessionIds(): readonly SessionId[] {
    return this.record.sessionIds.filter(id => this.host.candidateMatches(id, this.record.path))
  }

  get folders(): readonly WorkspaceFolder[] {
    const accounted = new Set(this.sessionIds)
    return this.record.folders.map(folder => this.folderView(folder, accounted))
  }

  async setTitle(title: string): Promise<void> {
    await this.mutate(record => ({ ...record, title }))
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    // Validation is skipped when the settled snapshot already accounts the
    // id: the cwd fact was checked when it first attached and both inputs
    // (stored header cwd, workspace path) are immutable. Membership itself is
    // decided on the write chain inside `mutate`, never on this snapshot.
    if (!this.record.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + 'its stored header carries no cwd to validate against',
        )
      }
      let cwd: string
      try {
        cwd = await realpathNormalize(header.cwd)
      } catch (error) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
          { cause: error },
        )
      }
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' is not a directory`,
        )
      }
      if (cwd !== this.record.path) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd resolves to '${cwd}'`,
        )
      }
      this.host.rememberSessionPath(sessionId, cwd)
    }
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? record
      : { ...record, sessionIds: [sessionId, ...record.sessionIds] })
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`,
        )
      }
      if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': `
          + 'the anchor session is not accounted',
        )
      }
      if (beforeSessionId === sessionId) return record
      const without = record.sessionIds.filter(id => id !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
      return sessionIds.every((id, index) => id === record.sessionIds[index])
        ? record
        : { ...record, sessionIds }
    })
  }

  async detachSession(sessionId: SessionId): Promise<void> {
    await this.mutate((record) => {
      const sessionIds = record.sessionIds.filter(id => id !== sessionId)
      const now = new Date().toISOString()
      const folders = record.folders.map((folder) => {
        const next = folder.sessionIds.filter(id => id !== sessionId)
        return next.length === folder.sessionIds.length ? folder : { ...folder, sessionIds: next, updatedAt: now }
      })
      return sessionIds.length === record.sessionIds.length
        && folders.every((folder, index) => folder === record.folders[index])
        ? record
        : { ...record, sessionIds, folders }
    })
  }

  async createFolder(title: string): Promise<WorkspaceFolder> {
    const id = randomUUID() as FolderId
    const now = new Date().toISOString()
    const folder: WorkspaceFolderRecord = { id, title, sessionIds: [], createdAt: now, updatedAt: now }
    await this.mutate(record => ({ ...record, folders: [...record.folders, folder] }))
    const created = this.folders.find(candidate => candidate.id === id)
    if (created === undefined) {
      throw new WorkspaceFolderInvalidError(`created folder '${id}' is unavailable in workspace '${this.path}'`)
    }
    return created
  }

  async setFolderTitle(folderId: FolderId, title: string): Promise<void> {
    await this.mutate((record) => {
      const index = record.folders.findIndex(folder => folder.id === folderId)
      if (index === -1) {
        throw new WorkspaceFolderInvalidError(`unknown folder '${folderId}' in workspace '${record.path}'`)
      }
      const folder = record.folders[index]
      if (folder === undefined) {
        throw new WorkspaceFolderInvalidError(`unknown folder '${folderId}' in workspace '${record.path}'`)
      }
      if (folder.title === title) {
        return record
      }
      const folders = record.folders.slice()
      folders[index] = { ...folder, title, updatedAt: new Date().toISOString() }
      return { ...record, folders }
    })
  }

  async deleteFolder(folderId: FolderId): Promise<void> {
    await this.mutate((record) => {
      if (!record.folders.some(folder => folder.id === folderId)) {
        throw new WorkspaceFolderInvalidError(`unknown folder '${folderId}' in workspace '${record.path}'`)
      }
      return { ...record, folders: record.folders.filter(folder => folder.id !== folderId) }
    })
  }

  async moveSessionToFolder(sessionId: SessionId, folderId?: FolderId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) {
        throw new WorkspaceFolderInvalidError(
          `cannot file session '${sessionId}' in workspace '${record.path}': the session is not accounted`,
        )
      }
      if (folderId !== undefined && !record.folders.some(folder => folder.id === folderId)) {
        throw new WorkspaceFolderInvalidError(`unknown folder '${folderId}' in workspace '${record.path}'`)
      }
      const now = new Date().toISOString()
      const folders = record.folders.map((folder) => {
        const without = folder.sessionIds.filter(id => id !== sessionId)
        if (folder.id !== folderId) {
          return without.length === folder.sessionIds.length
            ? folder
            : { ...folder, sessionIds: without, updatedAt: now }
        }
        if (without.length === folder.sessionIds.length - 1 && folder.sessionIds.at(-1) === sessionId) {
          return folder
        }
        return { ...folder, sessionIds: [...without, sessionId], updatedAt: now }
      })
      return folders.every((folder, index) => folder === record.folders[index]) ? record : { ...record, folders }
    })
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return (await stat(this.record.path)).isDirectory() ? 'ok' : 'missing-dir'
    } catch {
      // Any stat failure (ENOENT, dangling parent, permission loss) means the
      // directory is not usable right now; the record itself never mutates.
      return 'missing-dir'
    }
  }

  /**
   * The single write path: run `fn` on the domain write chain via
   * `table.update`, stamping `updatedAt` and pruning candidates that no
   * longer pass the candidate membership check, then swap the
   * snapshot.
   *
   * `fn` sees the value current at its chain slot, so membership decisions
   * (attach/detach idempotence) are race-free against queued writes; a fn
   * signalling no change by returning `current` verbatim aborts the slot
   * through the sentinel when pruning also finds nothing, so a no-op neither
   * rewrites the medium nor emits a change event.
   */
  private async mutate(fn: (record: WorkspaceRecord) => WorkspaceRecord): Promise<void> {
    let next: WorkspaceRecord
    try {
      next = await this.host.table().update(this.id, (current) => {
        const changed = fn(current)
        const sessionIds = changed.sessionIds.filter(
          id => this.host.candidateMatches(id, changed.path),
        )
        const folders = normalizeFolders(changed.folders, sessionIds)
        if (changed === current
          && sessionIds.length === current.sessionIds.length
          && foldersEqual(folders, current.folders)) {
          throw unchangedSentinel
        }
        return { ...changed, sessionIds, folders, updatedAt: new Date().toISOString() }
      })
    } catch (error) {
      if (error === unchangedSentinel) return
      throw error
    }
    this.record = next
  }

  /** Project one stored Folder using only currently valid Workspace members. */
  private folderView(record: WorkspaceFolderRecord, accounted: ReadonlySet<SessionId>): WorkspaceFolder {
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      sessionIds: record.sessionIds.filter(id => accounted.has(id)),
    }
  }
}

/** Retain only first Folder occurrences of valid Workspace-owned Session ids. */
function normalizeFolders(
  folders: readonly WorkspaceFolderRecord[],
  sessionIds: readonly SessionId[],
): WorkspaceFolderRecord[] {
  const accounted = new Set(sessionIds)
  const filed = new Set<SessionId>()
  const now = new Date().toISOString()
  return folders.map((folder) => {
    const next = folder.sessionIds.filter((id) => {
      if (!accounted.has(id) || filed.has(id)) {
        return false
      }
      filed.add(id)
      return true
    })
    return next.length === folder.sessionIds.length
      ? folder
      : { ...folder, sessionIds: next, updatedAt: now }
  })
}

/** Compare Folder record arrays by their stored identities and Session order. */
function foldersEqual(left: readonly WorkspaceFolderRecord[], right: readonly WorkspaceFolderRecord[]): boolean {
  return left.length === right.length && left.every((folder, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && folder.id === candidate.id
      && folder.title === candidate.title
      && folder.createdAt === candidate.createdAt
      && folder.updatedAt === candidate.updatedAt
      && folder.sessionIds.length === candidate.sessionIds.length
      && folder.sessionIds.every((id, sessionIndex) => id === candidate.sessionIds[sessionIndex])
  })
}
