/** Reconnect-safe Workspace baseline and increment producer. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {
  Workspace,
  WorkspaceFolder,
  WorkspaceGroup,
  WorkspaceRecord,
  WorkspaceRegistry,
} from '@deepseek-ai/dsh-workspace'
import {
  workspaceDomainState,
  workspaceGroupRecord,
  workspaceRecord,
  GroupId,
  WorkspaceId,
} from '@deepseek-ai/dsh-workspace'
import type {
  WorkspaceBaseline,
  WorkspaceFolderView,
  WorkspaceFollowFrame,
  WorkspaceGroupView,
  WorkspaceLayout,
  WorkspaceView,
} from './types.ts'

/** The frames the feed produces: every follow frame except `replace`, which only access filtering sends. */
type WorkspaceFeedFrame = Exclude<WorkspaceFollowFrame, { readonly type: 'replace' }>

/**
 * Project one Session Folder of an authoritative Workspace into its Remote value.
 * @param folder - authoritative Folder read model.
 * @returns detached Folder projection for Remote consumers.
 */
export function folderView(folder: WorkspaceFolder): WorkspaceFolderView {
  return {
    folderId: folder.id,
    title: folder.title,
    sessionIds: [...folder.sessionIds],
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  }
}

/**
 * Project one authoritative Workspace entity into its Remote value.
 * @param workspace - authoritative registry entity.
 * @returns detached Workspace projection for Remote consumers.
 */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    folders: workspace.folders.map(folderView),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/**
 * Project one authoritative Workspace Group into its Remote value.
 * @param group - authoritative registry Group.
 * @returns detached Group projection for Remote consumers.
 */
export function groupView(group: WorkspaceGroup): WorkspaceGroupView {
  return {
    groupId: group.id,
    title: group.title,
    workspaceIds: [...group.workspaceIds],
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  }
}

/**
 * Read the registry's complete containment and order synchronously.
 * @param registry - authoritative Workspace registry.
 * @returns top-level order and every Group with its filed Workspaces.
 */
export function workspaceLayout(registry: WorkspaceRegistry): WorkspaceLayout {
  return {
    topLevelWorkspaceIds: registry.list().map(workspace => workspace.id),
    groups: registry.listGroups().map(groupView),
  }
}

function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: WorkspaceId(workspaceId),
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    folders: record.folders.map(folder => ({
      folderId: folder.id,
      title: folder.title,
      sessionIds: [...folder.sessionIds],
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function changedGroupView(groupId: string, value: unknown): WorkspaceGroupView {
  const record = workspaceGroupRecord.parse(value)
  return {
    groupId: GroupId(groupId),
    title: record.title,
    workspaceIds: [...record.workspaceIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function layoutWorkspaceIds(layout: WorkspaceLayout): WorkspaceId[] {
  return [...layout.topLevelWorkspaceIds, ...layout.groups.flatMap(group => group.workspaceIds)]
}

/** Compare layouts by placement and Group titles; a bare Group `updatedAt` touch is not a layout change. */
function layoutKey(layout: WorkspaceLayout): string {
  return JSON.stringify({
    topLevelWorkspaceIds: layout.topLevelWorkspaceIds,
    groups: layout.groups.map(group => [group.groupId, group.title, group.workspaceIds]),
  })
}

/**
 * Owns Workspace domain observation and all active follow generations.
 *
 * Domain events arrive per durable write, and a Group move, Group dissolution,
 * Workspace create, or Workspace delete spans several writes. The feed keeps
 * its own copy of every table row and publishes a layout only when that copy
 * places each known Workspace exactly once, so followers never observe a
 * Workspace missing from, or twice in, the hierarchy.
 */
export class WorkspaceFeed {
  private readonly followers = new Set<WorkspaceFollower>()
  private readonly views = new Map<WorkspaceId, WorkspaceView>()
  /** Workspaces already delivered to followers through a baseline or upsert. */
  private readonly announced = new Set<WorkspaceId>()
  private readonly groupViews = new Map<string, WorkspaceGroupView>()
  private topLevel: readonly WorkspaceId[]
  private groupOrder: readonly string[]
  /** Last layout delivered to followers. */
  private layout: WorkspaceLayout
  private archived: readonly string[]
  private pinned: readonly string[]

  /** @param ctx - Host context containing the authoritative Workspace registry. */
  constructor(private readonly ctx: Context) {
    this.layout = workspaceLayout(ctx.workspaceRegistry)
    for (const id of layoutWorkspaceIds(this.layout)) {
      this.views.set(id, workspaceView(this.requireEntity(id)))
      this.announced.add(id)
    }
    for (const group of this.layout.groups) {
      this.groupViews.set(group.groupId, group)
    }
    this.topLevel = this.layout.topLevelWorkspaceIds
    this.groupOrder = this.layout.groups.map(group => group.groupId)
    this.archived = ctx.workspaceRegistry.archivedSessionIds.map(String)
    this.pinned = ctx.workspaceRegistry.pinnedSessionIds.map(String)
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'workspace-controller.feed')
  }

  /**
   * Read the complete current projection synchronously.
   * @returns all Workspaces, the last published layout, and archived and pinned Session identities.
   */
  baseline(): WorkspaceBaseline {
    return {
      items: layoutWorkspaceIds(this.layout).map(id => this.requireView(id)),
      topLevelWorkspaceIds: [...this.layout.topLevelWorkspaceIds],
      groups: this.layout.groups.map(group => ({
        ...group,
        workspaceIds: [...group.workspaceIds],
      })),
      archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds],
      pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds],
    }
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFeedFrame> {
    signal.throwIfAborted()
    const follower = new WorkspaceFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== 'workspace') {
      return
    }
    if (change.table === '') {
      if (change.operation !== 'put') {
        return
      }
      const state = workspaceDomainState.parse(change.value)
      this.topLevel = state.workspaceIds
      this.groupOrder = state.groupIds
      const nextArchived = state.archivedSessionIds.map(String)
      if (!sameStrings(this.archived, nextArchived)) {
        this.archived = nextArchived
        this.publish({ type: 'archived', archivedSessionIds: [...state.archivedSessionIds] })
      }
      const nextPinned = state.pinnedSessionIds.map(String)
      if (!sameStrings(this.pinned, nextPinned)) {
        this.pinned = nextPinned
        this.publish({ type: 'pinned', pinnedSessionIds: [...state.pinnedSessionIds] })
      }
      this.reconcile()
      return
    }
    if (change.table === 'groups') {
      if (change.operation === 'deleted') {
        this.groupViews.delete(change.key)
      } else {
        this.groupViews.set(change.key, changedGroupView(change.key, change.value))
      }
      this.reconcile()
      return
    }
    if (change.table !== 'workspaces') {
      return
    }
    const workspaceId = WorkspaceId(change.key)
    if (change.operation === 'deleted') {
      this.views.delete(workspaceId)
      if (this.announced.delete(workspaceId)) {
        this.publish({ type: 'remove', workspaceId })
      }
      this.reconcile()
      return
    }
    const view = changedWorkspaceView(change.key, change.value)
    this.views.set(workspaceId, view)
    if (this.announced.has(workspaceId)) {
      this.publish({ type: 'upsert', workspace: view })
    }
    this.reconcile()
  }

  /**
   * Publish the layout implied by the observed rows once it is whole: each
   * Group in the order has a row, and every known Workspace appears exactly
   * once. Newly placed Workspaces are announced before the layout that
   * contains them.
   */
  private reconcile(): void {
    const candidate = this.candidateLayout()
    if (candidate === undefined) {
      return
    }
    for (const id of layoutWorkspaceIds(candidate)) {
      if (this.announced.has(id)) {
        continue
      }
      this.announced.add(id)
      this.publish({ type: 'upsert', workspace: this.requireView(id) })
    }
    const unchanged = layoutKey(candidate) === layoutKey(this.layout)
    this.layout = candidate
    if (!unchanged) {
      this.publish({ type: 'layout', layout: candidate })
    }
  }

  private candidateLayout(): WorkspaceLayout | undefined {
    const groups: WorkspaceGroupView[] = []
    for (const id of this.groupOrder) {
      const group = this.groupViews.get(id)
      if (group === undefined) {
        return undefined
      }
      groups.push(group)
    }
    const layout: WorkspaceLayout = { topLevelWorkspaceIds: this.topLevel, groups }
    const placed = new Set(layoutWorkspaceIds(layout))
    const whole = placed.size === layoutWorkspaceIds(layout).length
      && placed.size === this.views.size
      && [...placed].every(id => this.views.has(id))
    return whole ? layout : undefined
  }

  private requireEntity(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      throw new Error(`Workspace registry layout references missing Workspace "${workspaceId}"`)
    }
    return workspace
  }

  private requireView(workspaceId: WorkspaceId): WorkspaceView {
    const view = this.views.get(workspaceId)
    /* v8 ignore next -- announced and layout-placed Workspaces always have a stored row. */
    if (view === undefined) {
      throw new Error(`Workspace feed has no row for "${workspaceId}"`)
    }
    return view
  }

  private publish(frame: Exclude<WorkspaceFeedFrame, { readonly type: 'baseline' }>): void {
    for (const follower of this.followers) follower.push(frame)
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

class WorkspaceFollower {
  private readonly frames = new Deque<WorkspaceFeedFrame>()
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: WorkspaceFeedFrame): void {
    /* v8 ignore next -- closed followers are removed before later publication can reach them. */
    if (this.closed) {
      return
    }
    this.frames.pushBack(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<WorkspaceFeedFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}
