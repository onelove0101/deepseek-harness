import type { z } from 'zod'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyOwnedError, SessionPersistenceNotFoundError, SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry, {
  FolderId,
  GroupId,
  WorkspaceId,
  type workspaceDomainState,
  WorkspaceFolderInvalidError,
  WorkspaceGroupUnknownError,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '../src/index.ts'
import type {
  WorkspaceDomainState,
  WorkspaceFolderRecord,
  WorkspaceGroupRecord,
  WorkspaceRecord,
} from '../src/index.ts'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath } from '../src/paths.ts'
import * as workspacePaths from '../src/paths.ts'

const DOMAIN_VERSION = 2

const header = (id: string, cwd?: string, createdAt = 0): SessionHeader => ({
  version: SESSION_FORMAT_VERSION,
  id: SessionId(id),
  createdAt,
  isSeeded: false,
  ...(cwd === undefined ? {} : { cwd }),
})

interface HarnessOptions {
  pool?: MemoryMediaPool
  sessions?: SessionHeader[]
  liveSessions?: SessionHeader[]
  sessionStore?: boolean
  backend?: StorageBackend
}

/** Boot the real storage/domain/registry composition over controllable header-only peers. */
async function harness(options: HarnessOptions = {}) {
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  let listed = options.sessions ?? []
  const list = vi.fn(async (): Promise<SessionPersistenceSnapshot[]> =>
    listed.map(header => ({ header, revision: SessionPersistenceRevision(`rev-${header.id}`) })))
  const open = vi.fn(() => { throw new Error('event bodies must not be opened') })
  const stat = vi.fn(() => { throw new Error('per-session stat must not be needed') })
  const remove = vi.fn(async (id: SessionId): Promise<void> => {
    listed = listed.filter(header => header.id !== id)
  })
  ctx.provide('sessionPersistence', { list, open, stat, delete: remove } as never)

  if (options.sessionStore === true) {
    await ctx.plugin(SessionStore)
  } else if (options.liveSessions !== undefined) {
    const live = new Map(options.liveSessions.map(meta => [meta.id, { header: meta }]))
    ctx.provide('sessions', {
      get: (id: SessionId) => live.get(id),
      list: () => [...live.values()],
    } as never)
  }

  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  const fiber = await ctx.plugin(WorkspaceRegistry)
  const initChanges = [...changes]
  changes.length = 0
  return {
    ctx,
    fiber,
    pool,
    registry: ctx.workspaceRegistry,
    changes,
    initChanges,
    list,
    open,
    stat,
    remove,
    setSessions: (headers: SessionHeader[]) => { listed = headers },
  }
}

/** Boot only the storage side, for dependency-pending and startup-failure cases. */
async function storageContext(pool: MemoryMediaPool, backend: StorageBackend = new MemoryStorageBackend(pool)) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  return ctx
}

/** Backend wrapper that injects one selected bootstrap write failure. */
function selectiveFailureBackend(
  pool: MemoryMediaPool,
  failure: { putAt?: number; deleteAt?: number; globalAt?: number | readonly number[] },
): StorageBackend {
  const inner = new MemoryStorageBackend(pool)
  let puts = 0
  let deletes = 0
  let globals = 0
  return {
    kv: {
      open: async (descriptor) => {
        const unit = await inner.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            puts += 1
            if (puts === failure.putAt) throw new Error('selected bootstrap put failure')
            await unit.putRecord(table, key, value)
          },
          deleteRecord: async (table, key) => {
            deletes += 1
            if (deletes === failure.deleteAt) throw new Error('selected rollback delete failure')
            await unit.deleteRecord(table, key)
          },
          deleteRecords: (table, keys) => unit.deleteRecords(table, keys),
          setGlobal: async (value) => {
            globals += 1
            const failAt = Array.isArray(failure.globalAt) ? failure.globalAt : [failure.globalAt]
            if (failAt.includes(globals)) throw new Error('selected bootstrap marker failure')
            await unit.setGlobal(value)
          },
          close: () => unit.close(),
        }
      },
    },
    close: () => inner.close(),
  }
}

function record(
  path: string,
  sessionIds: string[],
  createdAt = '2026-07-24T00:00:00.000Z',
  folders: WorkspaceFolderRecord[] = [],
): WorkspaceRecord {
  return {
    path,
    title: basename(path),
    sessionIds: sessionIds.map(SessionId),
    folders,
    createdAt,
    updatedAt: createdAt,
  }
}

function folderRecord(
  id: string,
  title: string,
  sessionIds: string[],
  createdAt = '2026-07-24T00:00:00.000Z',
): WorkspaceFolderRecord {
  return {
    id: id as WorkspaceFolderRecord['id'],
    title,
    sessionIds: sessionIds.map(SessionId),
    createdAt,
    updatedAt: createdAt,
  }
}

function groupRecord(
  title: string,
  workspaceIds: string[],
  createdAt = '2026-07-24T00:00:00.000Z',
): WorkspaceGroupRecord {
  return {
    title,
    workspaceIds: workspaceIds.map(WorkspaceId),
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * Media written before archivedSessionIds, pinnedSessionIds, and groupIds existed omit
 * the fields; keeping the fixtures in that shape continuously proves the
 * schema defaults upgrade them.
 */
type StoredDomainState = z.input<typeof workspaceDomainState>

function storedPool(
  entries: Array<[string, WorkspaceRecord]>,
  state: StoredDomainState,
  groups: Array<[string, WorkspaceGroupRecord]> = [],
): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('workspace', DOMAIN_VERSION)
  pool.media.set('workspace', {
    tables: new Map([
      ['workspaces', new Map<string, unknown>(entries)],
      ['groups', new Map<string, unknown>(groups)],
    ]),
    global: state,
  })
  return pool
}

function storedRecord(pool: MemoryMediaPool, id: string): WorkspaceRecord {
  return pool.media.get('workspace')!.tables.get('workspaces')!.get(id) as WorkspaceRecord
}

function storedGroupRecord(pool: MemoryMediaPool, id: string): WorkspaceGroupRecord {
  return pool.media.get('workspace')!.tables.get('groups')!.get(id) as WorkspaceGroupRecord
}

/** The `groups` table materializes only on a put; count it as empty while absent. */
function storedGroupCount(pool: MemoryMediaPool): number {
  return pool.media.get('workspace')!.tables.get('groups')?.size ?? 0
}

function storedState(pool: MemoryMediaPool): WorkspaceDomainState {
  return pool.media.get('workspace')!.global as WorkspaceDomainState
}

let base: string
const tempDirs: string[] = []

async function makeDir(name: string): Promise<string> {
  base ??= await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-')))
  if (tempDirs.length === 0) tempDirs.push(base)
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  base = undefined as never
})

describe('WorkspaceRegistry lifecycle and bootstrap', () => {
  it('stays pending without sessionPersistence and never opens or marks the domain', async () => {
    const pool = new MemoryMediaPool()
    const ctx = await storageContext(pool)
    const fiber = await ctx.plugin(WorkspaceRegistry)
    expect(ctx.get('workspaceRegistry')).toBeUndefined()
    expect(pool.media.has('workspace')).toBe(false)

    const list = vi.fn(async () => [] as SessionPersistenceSnapshot[])
    ctx.provide('sessionPersistence', { list } as never)
    await fiber.await()
    expect(ctx.workspaceRegistry.list()).toEqual([])
    expect(list).toHaveBeenCalledTimes(1)
    expect(storedState(pool)).toEqual({ initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], groupIds: [] })
  })

  it('bootstraps once from list headers only, in workspace/session createdAt order', async () => {
    const older = await makeDir('older')
    const newer = await makeDir('newer')
    const alias = join(base, 'older-link')
    const plain = join(base, 'plain.txt')
    await symlink(older, alias)
    await writeFile(plain, 'not a directory')
    const missing = join(base, 'missing')
    const result = await harness({
      sessions: [
        header('older-first', older, 100),
        header('newer-only', newer, 500),
        header('older-latest', alias, 300),
        header('no-cwd', undefined, 900),
        header('missing-dir', missing, 800),
        header('plain-file', plain, 700),
      ],
    })

    expect(result.list).toHaveBeenCalledTimes(1)
    expect(result.open).not.toHaveBeenCalled()
    expect(result.stat).not.toHaveBeenCalled()
    expect(result.registry.list().map(workspace => workspace.path)).toEqual([newer, older])
    expect(result.registry.list().map(workspace => workspace.sessionIds)).toEqual([
      ['newer-only'],
      ['older-latest', 'older-first'],
    ])
    expect(storedState(result.pool)).toEqual({
      initialized: true,
      workspaceIds: result.registry.list().map(workspace => workspace.id),
      archivedSessionIds: [],
      pinnedSessionIds: [],
      groupIds: [],
    })
  })

  it('breaks equal bootstrap timestamps by session id and canonical path', async () => {
    const first = await makeDir('tie-first')
    const second = await makeDir('tie-second')
    const result = await harness({
      sessions: [
        header('z-session', first, 100),
        header('a-session', first, 100),
        header('second-session', second, 100),
      ],
    })
    expect(new Set(result.registry.list().map(workspace => workspace.path))).toEqual(new Set([first, second]))
    expect(result.registry.list().find(workspace => workspace.path === first)!.sessionIds)
      .toEqual(['a-session', 'z-session'])
  })

  it('does not rerun bootstrap for a genuinely initialized empty registry', async () => {
    const late = await makeDir('late-cwd-only')
    const pool = new MemoryMediaPool()
    const first = await harness({ pool, sessions: [] })
    expect(first.list).toHaveBeenCalledTimes(1)
    await first.fiber.dispose()

    const second = await harness({ pool, sessions: [header('late', late, 100)] })
    expect(second.list).not.toHaveBeenCalled()
    expect(second.registry.list()).toEqual([])
    expect(storedState(pool)).toEqual({ initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], groupIds: [] })
  })

  it('reuses partial records after a bootstrap record write fails', async () => {
    const firstDir = await makeDir('partial-first')
    const secondDir = await makeDir('partial-second')
    const sessions = [header('first', firstDir, 200), header('second', secondDir, 100)]
    const pool = new MemoryMediaPool()
    await expect(harness({
      pool,
      sessions,
      backend: selectiveFailureBackend(pool, { putAt: 2 }),
    })).rejects.toThrow(/selected bootstrap put failure/)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
    expect(pool.media.get('workspace')!.global).toBeNull()

    const retried = await harness({ pool, sessions })
    expect(retried.registry.list()).toHaveLength(2)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(2)
    expect(storedState(pool).initialized).toBe(true)
  })

  it('reuses durable order when the final initialized marker write fails', async () => {
    const dir = await makeDir('marker-retry')
    const sessions = [header('session', dir, 100)]
    const pool = new MemoryMediaPool()
    await expect(harness({
      pool,
      sessions,
      backend: selectiveFailureBackend(pool, { globalAt: 2 }),
    })).rejects.toThrow(/selected bootstrap marker failure/)
    expect(storedState(pool)).toMatchObject({ initialized: false })
    expect(storedState(pool).workspaceIds).toHaveLength(1)

    const retried = await harness({ pool, sessions })
    expect(retried.registry.list()).toHaveLength(1)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
    expect(storedState(pool).initialized).toBe(true)
  })

  it('merges partial records and leaves an already-accounted cwd drift ungrouped', async () => {
    const owned = await makeDir('partial-owned')
    const prior = await makeDir('partial-prior')
    const drifted = await makeDir('partial-drifted')
    const ownedId = WorkspaceId('00000000-0000-4000-8000-000000000010')
    const priorId = WorkspaceId('00000000-0000-4000-8000-000000000011')
    const pool = storedPool(
      [
        [ownedId, record(owned, ['old'], '2026-07-24T00:00:00.000Z')],
        [priorId, record(prior, ['drift'], '2026-07-23T00:00:00.000Z')],
      ],
      { initialized: false, workspaceIds: [] },
    )
    const result = await harness({
      pool,
      sessions: [header('new', owned, 200), header('old', owned, 100), header('drift', drifted, 300)],
    })
    expect(result.registry.list().map(workspace => workspace.id)).toContain(ownedId)
    expect(result.registry.get(ownedId)!.sessionIds).toEqual(['new', 'old'])
    expect(result.registry.list().some(workspace => workspace.path === drifted)).toBe(false)
  })

  it('orders headerless partial records by prior order, then stable id', async () => {
    const first = await makeDir('fallback-first')
    const second = await makeDir('fallback-second')
    const firstId = WorkspaceId('00000000-0000-4000-8000-000000000020')
    const secondId = WorkspaceId('00000000-0000-4000-8000-000000000021')
    const entries: Array<[string, WorkspaceRecord]> = [
      [secondId, record(second, [], '2026-07-24T00:00:00.000Z')],
      [firstId, record(first, [], '2026-07-24T00:00:00.000Z')],
    ]
    const prior = await harness({
      pool: storedPool(entries, { initialized: false, workspaceIds: [secondId, firstId] }),
    })
    expect(prior.registry.list().map(workspace => workspace.id)).toEqual([secondId, firstId])

    const byId = await harness({
      pool: storedPool(entries, { initialized: false, workspaceIds: [] }),
    })
    expect(byId.registry.list().map(workspace => workspace.id)).toEqual([firstId, secondId])
  })

  it('closes its domain on disposal and reloads the persisted stable order', async () => {
    const dir = await makeDir('replug')
    const result = await harness()
    const first = await result.registry.create(dir)
    await result.fiber.dispose()
    const nextFiber = await result.ctx.plugin(WorkspaceRegistry)
    expect(result.ctx.workspaceRegistry.list().map(workspace => workspace.id)).toEqual([first.id])
    await nextFiber.dispose()
  })
})

describe('WorkspaceRegistry create and lookup', () => {
  it('accepts fully qualified roots and directories without accepting drive-relative paths', () => {
    expect(fullyQualifiedWorkspacePath('C:\\', 'win32')).toBe(true)
    expect(fullyQualifiedWorkspacePath('C:\\work', 'win32')).toBe(true)
    expect(fullyQualifiedWorkspacePath('\\\\server\\share', 'win32')).toBe(true)
    expect(defaultWorkspaceTitle('C:\\', 'win32')).toBe('C:\\')
    expect(defaultWorkspaceTitle('C:\\work', 'win32')).toBe('work')
    expect(defaultWorkspaceTitle('\\\\server\\share', 'win32')).toBe('share')
    expect(fullyQualifiedWorkspacePath('C:', 'win32')).toBe(false)
    expect(fullyQualifiedWorkspacePath('C:work', 'win32')).toBe(false)
    expect(fullyQualifiedWorkspacePath('\\work', 'win32')).toBe(false)
    expect(fullyQualifiedWorkspacePath('.', 'win32')).toBe(false)
    expect(fullyQualifiedWorkspacePath('/', 'linux')).toBe(true)
    expect(fullyQualifiedWorkspacePath('/work', 'darwin')).toBe(true)
    expect(defaultWorkspaceTitle('/', 'linux')).toBe('/')
    expect(defaultWorkspaceTitle('/work', 'darwin')).toBe('work')
    expect(fullyQualifiedWorkspacePath('work', 'linux')).toBe(false)
  })

  it('creates newest-first and idempotently reuses a canonical path without retitling', async () => {
    const firstDir = await makeDir('first')
    const secondDir = await makeDir('second')
    const alias = join(base, 'first-link')
    await symlink(firstDir, alias)
    const { registry, pool } = await harness()
    const first = await registry.create(firstDir, 'Original')
    const second = await registry.create(secondDir)
    const reused = await registry.create(alias, 'Ignored')
    expect(reused).toBe(first)
    expect(first.title).toBe('Original')
    expect(registry.list()).toEqual([second, first])
    expect(storedState(pool).workspaceIds).toEqual([second.id, first.id])
    expect(await registry.resolveByPath(alias)).toBe(first)
    expect(await registry.resolveByPath(await makeDir('unowned'))).toBeUndefined()
  })

  it('serializes concurrent same-path creates into one entity', async () => {
    const dir = await makeDir('concurrent')
    const { registry, pool } = await harness()
    const [left, right] = await Promise.all([
      registry.create(dir, 'Winner'),
      registry.create(dir, 'Loser'),
    ])
    expect(left).toBe(right)
    expect(registry.list()).toEqual([left])
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
  })

  it('allows a duplicate display name on a different canonical path', async () => {
    const firstDir = await makeDir('named-first')
    const secondDir = await makeDir('named-second')
    const { registry } = await harness()
    const first = await registry.create(firstDir, 'Shared')
    const second = await registry.create(secondDir, 'Shared')
    expect(first.title).toBe('Shared')
    expect(second.title).toBe('Shared')
    expect(registry.list()).toEqual([second, first])
  })

  it('rejects nonexistent and non-directory paths without changing order', async () => {
    const parent = await makeDir('invalid')
    const file = join(parent, 'plain.txt')
    await writeFile(file, 'file')
    const { registry } = await harness()
    await expect(registry.create(join(parent, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(registry.create(file)).rejects.toThrow(/not a directory/)
    await expect(registry.resolveByPath(join(parent, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(registry.list()).toEqual([])
  })

  it('rejects a resolvable relative path instead of adopting it from the Host cwd', async () => {
    const { registry } = await harness()
    const fromHostCwd = '.'
    await expect(registry.create(fromHostCwd)).rejects.toThrow(/fully qualified/)
    await expect(registry.resolveByPath(fromHostCwd)).rejects.toThrow(/fully qualified/)
    expect(registry.list()).toEqual([])
  })

  it('rolls back the provisional cache when the record write fails', async () => {
    const dir = await makeDir('write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { putAt: 1 }),
    })
    await expect(result.registry.create(dir)).rejects.toThrow(/selected bootstrap put failure/)
    expect(result.registry.list()).toEqual([])
    expect(await result.registry.create(dir)).toBeDefined()
  })

  it('does not publish a Workspace when its pending marker cannot be written', async () => {
    const dir = await makeDir('pending-marker-write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 2 }),
    })
    await expect(result.registry.create(dir)).rejects.toThrow(/selected bootstrap marker failure/)
    expect(result.registry.list()).toEqual([])
    expect(pool.media.get('workspace')!.tables.get('workspaces')?.size ?? 0).toBe(0)
  })

  it('rolls back a record when registry-order persistence fails', async () => {
    const dir = await makeDir('order-write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 3 }),
    })
    await expect(result.registry.create(dir)).rejects.toThrow(/marker failure/)
    expect(result.registry.list()).toEqual([])
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(0)
  })

  it('reports both order and rollback failures while retaining the recoverable record', async () => {
    const dir = await makeDir('rollback-write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 3, deleteAt: 1 }),
    })
    await expect(result.registry.create(dir)).rejects.toBeInstanceOf(AggregateError)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
  })

  it('reports a record write and pending-marker rollback failure together', async () => {
    const dir = await makeDir('record-marker-rollback-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { putAt: 1, globalAt: 3 }),
    })
    await expect(result.registry.create(dir)).rejects.toBeInstanceOf(AggregateError)
    expect(storedState(pool)).toMatchObject({
      pendingMutation: { operation: 'create' },
    })
  })

  it('reports an order write and pending-marker rollback failure together', async () => {
    const dir = await makeDir('order-marker-rollback-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: [3, 4] }),
    })
    await expect(result.registry.create(dir)).rejects.toBeInstanceOf(AggregateError)
    expect(storedState(pool)).toMatchObject({
      pendingMutation: { operation: 'create' },
    })
  })

  it('deletes only the registration and leaves its directory and session headers untouched', async () => {
    const dir = await makeDir('delete-registration')
    const result = await harness({ sessions: [header('kept-session', dir)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('kept-session'))

    await expect(result.registry.delete(workspace.id)).resolves.toBe(true)
    await expect(result.registry.delete(workspace.id)).resolves.toBe(false)
    expect(result.registry.get(workspace.id)).toBeUndefined()
    expect(result.registry.list()).toEqual([])
    expect(storedState(result.pool)).toEqual({
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      groupIds: [],
    })
    expect(result.pool.media.get('workspace')!.tables.get('workspaces')!.has(workspace.id)).toBe(false)
    await expect(realpath(dir)).resolves.toBe(dir)
    expect(result.list).toHaveBeenCalledTimes(1)
    expect(result.open).not.toHaveBeenCalled()
    expect(result.stat).not.toHaveBeenCalled()

    const reregistered = await result.registry.create(dir)
    expect(reregistered.id).not.toBe(workspace.id)
    expect(reregistered.path).toBe(dir)
    expect(reregistered.sessionIds).toEqual([])
  })

  it('rolls registry order and cache back when record deletion fails', async () => {
    const dir = await makeDir('delete-rollback')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { deleteAt: 1 }),
    })
    const workspace = await result.registry.create(dir)

    await expect(result.registry.delete(workspace.id)).rejects.toThrow(/selected rollback delete failure/)
    expect(result.registry.get(workspace.id)).toBe(workspace)
    expect(result.registry.list()).toEqual([workspace])
    expect(storedState(pool).workspaceIds).toEqual([workspace.id])
    expect(storedRecord(pool, workspace.id)).toMatchObject({ path: dir })
  })

  it('commits deletion and leaves a recoverable marker when marker cleanup fails', async () => {
    const dir = await makeDir('delete-marker-cleanup')
    const pool = new MemoryMediaPool()
    const first = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 5 }),
    })
    const workspace = await first.registry.create(dir)

    await expect(first.registry.delete(workspace.id)).resolves.toBe(true)
    expect(first.registry.list()).toEqual([])
    expect(storedState(pool)).toEqual({
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      groupIds: [],
      pendingMutation: { operation: 'delete', workspaceId: workspace.id },
    })
    const reregistered = await first.registry.create(dir)
    expect(reregistered.id).not.toBe(workspace.id)
    expect(storedState(pool)).toEqual({
      initialized: true,
      workspaceIds: [reregistered.id],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      groupIds: [],
    })
    await first.fiber.dispose()

    const restarted = await harness({ pool })
    expect(restarted.registry.list().map(item => item.id)).toEqual([reregistered.id])
  })

  it('keeps the failed deletion unpublished when record and order rollback both fail', async () => {
    const dir = await makeDir('delete-double-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { deleteAt: 1, globalAt: 5 }),
    })
    const workspace = await result.registry.create(dir)

    await expect(result.registry.delete(workspace.id)).rejects.toBeInstanceOf(AggregateError)
    expect(result.registry.get(workspace.id)).toBeUndefined()
    expect(storedState(pool)).toMatchObject({
      workspaceIds: [],
      pendingMutation: { operation: 'delete', workspaceId: workspace.id },
    })
  })

  it('rejects table access before the registry has started', async () => {
    const dir = await makeDir('unstarted')
    const registry = new WorkspaceRegistry(new Context())
    await expect(registry.create(dir)).rejects.toThrow(/not started/)
    expect(() => registry.list()).toThrow(/not started/)
    const internals = registry as unknown as {
      requireTable(): unknown
      requireGroupTable(): unknown
      groupRecord(id: GroupId): unknown
    }
    expect(() => internals.requireTable()).toThrow(/not started/)
    expect(() => internals.requireGroupTable()).toThrow(/not started/)
    // groupRecord's own guard stays unreachable behind requireGroupTable until
    // the registry starts; a started registry with a diverged medium reaches
    // the missing-record throw below.
    expect(() => registry.listGroups()).toThrow(/not started/)
  })

  it('fails loud when a group read misses its live entry', async () => {
    const result = await harness()
    // The missing-entry guards behind groupRecord and listGroups are
    // unreachable through any booted-registry flow: validation runs at
    // startup and the registry keeps live entity caches, so a read after
    // startup always agrees. Poke the private reads directly, like
    // requireTable above.
    const internals = result.registry as unknown as {
      groups: Map<GroupId, unknown>
      groupRecord(id: GroupId): unknown
      listGroups(): unknown
    }
    expect(() => internals.groupRecord(GroupId('00000000-0000-4000-8000-0000000000f1')))
      .toThrow(/missing group record/)

    // Seed a durable group, then drop its live cache entry: listGroups must
    // fail loud on the order/cache divergence rather than skip it.
    const group = await result.registry.createGroup('cached')
    internals.groups.delete(group.id)
    expect(() => internals.listGroups()).toThrow(/group order references missing group/)
  })
})

describe('Workspace registry ordering', () => {
  it('moves a workspace before an anchor or to the end and restores that order after restart', async () => {
    const firstDir = await makeDir('order-first')
    const secondDir = await makeDir('order-second')
    const thirdDir = await makeDir('order-third')
    const result = await harness()
    const first = await result.registry.create(firstDir)
    const second = await result.registry.create(secondDir)
    const third = await result.registry.create(thirdDir)
    expect(result.registry.list().map(item => item.id)).toEqual([third.id, second.id, first.id])

    await expect(result.registry.insertBefore(first.id, second.id))
      .resolves.toEqual([third.id, first.id, second.id])
    await expect(result.registry.insertBefore(third.id))
      .resolves.toEqual([first.id, second.id, third.id])
    expect(storedState(result.pool).workspaceIds).toEqual([first.id, second.id, third.id])

    const restarted = await harness({ pool: result.pool })
    expect(restarted.registry.list().map(item => item.id)).toEqual([first.id, second.id, third.id])
  })

  it('keeps self-anchored and already-positioned moves write-free and rejects unknown ids', async () => {
    const firstDir = await makeDir('order-noop-first')
    const secondDir = await makeDir('order-noop-second')
    const result = await harness()
    const first = await result.registry.create(firstDir)
    const second = await result.registry.create(secondDir)
    const written = result.changes.length

    await result.registry.insertBefore(second.id, second.id)
    await result.registry.insertBefore(second.id, first.id)
    await result.registry.insertBefore(first.id)
    expect(result.changes).toHaveLength(written)
    expect(result.registry.list().map(item => item.id)).toEqual([second.id, first.id])

    await expect(result.registry.insertBefore(WorkspaceId('missing')))
      .rejects.toBeInstanceOf(WorkspaceOrderInvalidError)
    await expect(result.registry.insertBefore(second.id, WorkspaceId('missing-anchor')))
      .rejects.toMatchObject({ workspaceId: 'missing-anchor' })
    expect(result.changes).toHaveLength(written)
  })
})

describe('Workspace session ordering', () => {
  it('prepends new attaches and keeps repeat attach idempotent', async () => {
    const dir = await makeDir('attach-order')
    const result = await harness()
    result.setSessions([
      header('s1', dir, 1),
      header('s2', dir, 2),
    ])
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    expect(workspace.sessionIds).toEqual(['s2', 's1'])
    await workspace.attachSession(SessionId('s1'))
    expect(workspace.sessionIds).toEqual(['s2', 's1'])
    expect(storedRecord(result.pool, workspace.id).sessionIds).toEqual(['s2', 's1'])
  })

  it('moves one id before an anchor or to the end, durably', async () => {
    const dir = await makeDir('insert-before')
    const result = await harness()
    result.setSessions([header('s1', dir, 1), header('s2', dir, 2), header('s3', dir, 3)])
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    await workspace.attachSession(SessionId('s3'))
    expect(workspace.sessionIds).toEqual(['s3', 's2', 's1'])

    await workspace.insertSessionBefore(SessionId('s1'), SessionId('s2'))
    expect(workspace.sessionIds).toEqual(['s3', 's1', 's2'])
    await workspace.insertSessionBefore(SessionId('s3'))
    expect(workspace.sessionIds).toEqual(['s1', 's2', 's3'])
    expect(storedRecord(result.pool, workspace.id).sessionIds).toEqual(['s1', 's2', 's3'])
  })

  it('treats self-anchored and already-in-place moves as no-ops without writing', async () => {
    const dir = await makeDir('insert-noop')
    const result = await harness()
    result.setSessions([header('s1', dir, 1), header('s2', dir, 2)])
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    const written = result.changes.length

    await workspace.insertSessionBefore(SessionId('s1'), SessionId('s1'))
    await workspace.insertSessionBefore(SessionId('s2'), SessionId('s1'))
    await workspace.insertSessionBefore(SessionId('s1'))
    await workspace.detachSession(SessionId('absent'))
    expect(result.changes).toHaveLength(written)
    expect(workspace.sessionIds).toEqual(['s2', 's1'])
  })

  it('rejects moves naming an unaccounted session or anchor', async () => {
    const dir = await makeDir('insert-invalid')
    const result = await harness()
    result.setSessions([header('s1', dir, 1)])
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    const written = result.changes.length

    await expect(workspace.insertSessionBefore(SessionId('ghost')))
      .rejects.toBeInstanceOf(WorkspaceMoveInvalidError)
    await expect(workspace.insertSessionBefore(SessionId('s1'), SessionId('ghost')))
      .rejects.toThrow(/anchor session is not accounted/)
    expect(result.changes).toHaveLength(written)
    expect(workspace.sessionIds).toEqual(['s1'])
  })

  it('validates a lazy live session without requiring it in persistence.list()', async () => {
    const dir = await makeDir('live')
    const result = await harness({ sessions: [], liveSessions: [header('live', dir, 1)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('live'))
    expect(workspace.sessionIds).toEqual(['live'])
    expect(result.list).toHaveBeenCalledTimes(1)
  })

  it('rejects mismatched, missing, unresolved, non-directory, and unknown cwd facts', async () => {
    const dir = await makeDir('strict')
    const elsewhere = await makeDir('elsewhere')
    const gone = await makeDir('gone')
    const file = join(base, 'cwd-file')
    await writeFile(file, 'file')
    const result = await harness()
    result.setSessions([
      header('mismatch', elsewhere),
      header('no-cwd'),
      header('gone', gone),
      header('file', file),
    ])
    await rm(gone, { recursive: true })
    const workspace = await result.registry.create(dir)
    await expect(workspace.attachSession(SessionId('mismatch'))).rejects.toThrow(/resolves to/)
    await expect(workspace.attachSession(SessionId('no-cwd'))).rejects.toThrow(/no cwd/)
    await expect(workspace.attachSession(SessionId('gone'))).rejects.toThrow(/does not resolve/)
    await expect(workspace.attachSession(SessionId('file'))).rejects.toThrow(/not a directory/)
    await expect(workspace.attachSession(SessionId('unknown'))).rejects.toThrow(/no such session/)
    expect(workspace.sessionIds).toEqual([])
  })

  it('decides detach/attach membership at domain write-chain slots', async () => {
    const dir = await makeDir('race')
    const result = await harness({ sessions: [header('s1', dir)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    const detached = workspace.detachSession(SessionId('s1'))
    const attached = workspace.attachSession(SessionId('s1'))
    await Promise.all([detached, attached])
    expect(workspace.sessionIds).toEqual(['s1'])
  })

})

describe('Workspace Session folders', () => {
  it('creates, renames, files, and returns owned Sessions without changing Workspace membership', async () => {
    const dir = await makeDir('folder-lifecycle')
    const result = await harness({ sessions: [header('s1', dir), header('s2', dir)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))

    const folder = await workspace.createFolder('Current work')
    expect(folder.title).toBe('Current work')
    expect(folder.sessionIds).toEqual([])
    await workspace.moveSessionToFolder(SessionId('s1'), folder.id)
    await workspace.setFolderTitle(folder.id, 'Focused work')
    expect(workspace.sessionIds).toEqual(['s1', 's2'])
    expect(workspace.folders).toEqual([expect.objectContaining({
      id: folder.id,
      title: 'Focused work',
      sessionIds: ['s1'],
    })])

    await workspace.moveSessionToFolder(SessionId('s1'))
    expect(workspace.folders[0]?.sessionIds).toEqual([])
    expect(storedRecord(result.pool, workspace.id).folders[0]?.sessionIds).toEqual([])
  })

  it('keeps a Session in at most one Folder and makes repeated filing a no-op', async () => {
    const dir = await makeDir('folder-exclusive')
    const result = await harness({ sessions: [header('s1', dir)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    const first = await workspace.createFolder('First')
    const second = await workspace.createFolder('Second')
    await workspace.moveSessionToFolder(SessionId('s1'), first.id)
    const firstUpdatedAt = workspace.folders[0]!.updatedAt
    const waitStarted = Date.now()
    while (new Date().toISOString() === firstUpdatedAt && Date.now() - waitStarted < 1000) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    await workspace.moveSessionToFolder(SessionId('s1'), second.id)
    const written = result.changes.length
    await workspace.moveSessionToFolder(SessionId('s1'), second.id)

    expect(workspace.folders.map(folder => folder.sessionIds)).toEqual([[], ['s1']])
    expect(workspace.folders[0]!.updatedAt).not.toBe(firstUpdatedAt)
    expect(workspace.folders[0]!.updatedAt).toBe(workspace.folders[1]!.updatedAt)
    expect(result.changes).toHaveLength(written)
  })

  it('rejects operations on unknown Folders and unowned Sessions without writing', async () => {
    const dir = await makeDir('folder-invalid')
    const result = await harness({ sessions: [header('s1', dir)] })
    const workspace = await result.registry.create(dir)
    const folder = await workspace.createFolder('Existing')
    await workspace.attachSession(SessionId('s1'))
    await workspace.detachSession(SessionId('s1'))
    const written = result.changes.length

    await expect(workspace.setFolderTitle(FolderId('missing'), 'New')).rejects.toBeInstanceOf(WorkspaceFolderInvalidError)
    await expect(workspace.deleteFolder(FolderId('missing'))).rejects.toBeInstanceOf(WorkspaceFolderInvalidError)
    await expect(workspace.moveSessionToFolder(SessionId('s1'), folder.id))
      .rejects.toBeInstanceOf(WorkspaceFolderInvalidError)
    await expect(workspace.moveSessionToFolder(SessionId('s1'), FolderId('missing')))
      .rejects.toBeInstanceOf(WorkspaceFolderInvalidError)
    expect(result.changes).toHaveLength(written)
    expect(workspace.folders).toHaveLength(1)
  })

  it('deletes only the Folder and detaches Sessions from every Folder', async () => {
    const dir = await makeDir('folder-delete')
    const result = await harness({ sessions: [header('s1', dir), header('s2', dir)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    const first = await workspace.createFolder('First')
    const second = await workspace.createFolder('Second')
    await workspace.moveSessionToFolder(SessionId('s1'), first.id)
    await workspace.moveSessionToFolder(SessionId('s2'), second.id)

    await workspace.deleteFolder(first.id)
    expect(workspace.sessionIds).toEqual(['s1', 's2'])
    expect(workspace.folders).toEqual([expect.objectContaining({ id: second.id, sessionIds: ['s2'] })])
    const secondUpdatedAt = workspace.folders[0]!.updatedAt
    await new Promise(resolve => setTimeout(resolve, 1))
    await workspace.detachSession(SessionId('s2'))
    expect(workspace.sessionIds).toEqual(['s1'])
    expect(workspace.folders[0]?.sessionIds).toEqual([])
    expect(workspace.folders[0]?.updatedAt).not.toBe(secondUpdatedAt)
  })

  it('reads legacy version-two Workspace records without a folders field as unfiled', async () => {
    const dir = await makeDir('folder-legacy')
    const id = WorkspaceId('00000000-0000-4000-8000-00000000000f')
    const pool = storedPool([[id, record(dir, ['s1'])]], { initialized: true, workspaceIds: [id] })
    const stored = pool.media.get('workspace')!
    const records = stored.tables.get('workspaces')!
    const raw = records.get(id) as Record<string, unknown>
    delete raw.folders

    const result = await harness({ pool, sessions: [header('s1', dir)] })

    expect(result.registry.get(id)?.folders).toEqual([])
    expect(result.registry.get(id)?.sessionIds).toEqual(['s1'])
  })

  it('rejects corrupt duplicate Folder identities and filing at startup', async () => {
    const dir = await makeDir('folder-corruption')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000010')
    const duplicateFolders = storedPool(
      [[id, record(dir, ['s1'], undefined, [
        folderRecord('folder', 'First', ['s1']),
        folderRecord('folder', 'Second', []),
      ])]],
      { initialized: true, workspaceIds: [id] },
    )
    await expect(harness({ pool: duplicateFolders, sessions: [header('s1', dir)] }))
      .rejects.toThrow(/repeats folder/)

    const duplicateFiling = storedPool(
      [[id, record(dir, ['s1'], undefined, [
        folderRecord('first', 'First', ['s1']),
        folderRecord('second', 'Second', ['s1']),
      ])]],
      { initialized: true, workspaceIds: [id] },
    )
    await expect(harness({ pool: duplicateFiling, sessions: [header('s1', dir)] }))
      .rejects.toThrow(/filed by two folders/)
  })
})

describe('header-validated membership projection', () => {
  it('preserves owned sessions and manual order after directory removal and restart', async () => {
    const dir = await makeDir('removed-owned')
    const sessions = [header('first', dir), header('second', dir)]
    const initial = await harness()
    onTestFinished(() => initial.ctx.fiber.dispose())
    initial.setSessions(sessions)
    const workspace = await initial.registry.create(dir)
    await workspace.attachSession(SessionId('first'))
    await workspace.attachSession(SessionId('second'))
    await initial.ctx.fiber.dispose()
    await rm(dir, { recursive: true })

    const restarted = await harness({ pool: initial.pool, sessions: [...sessions, header('unowned', dir)] })
    onTestFinished(() => restarted.ctx.fiber.dispose())
    const restored = restarted.registry.get(workspace.id)!
    expect(restored.sessionIds).toEqual(['second', 'first'])
    expect(await restored.status()).toBe('missing-dir')
    await restored.setTitle('Still owned')
    await restored.insertSessionBefore(SessionId('first'), SessionId('second'))
    expect(storedRecord(initial.pool, workspace.id).sessionIds).toEqual(['first', 'second'])
    await expect(restored.attachSession(SessionId('unowned'))).rejects.toThrow(/does not resolve/)
    expect(restored.sessionIds).toEqual(['first', 'second'])
    await restarted.ctx.fiber.dispose()

    const again = await harness({ pool: initial.pool, sessions })
    onTestFinished(() => again.ctx.fiber.dispose())
    expect(again.registry.get(workspace.id)!.sessionIds).toEqual(['first', 'second'])
  })

  it('preserves an owned session when its symlink target disappears without bootstrapping missing paths', async () => {
    const target = await makeDir('removed-symlink-target')
    const alias = join(base, 'removed-symlink-alias')
    await symlink(target, alias, 'junction')
    const sessions = [header('linked', alias)]
    const initial = await harness()
    onTestFinished(() => initial.ctx.fiber.dispose())
    initial.setSessions(sessions)
    const workspace = await initial.registry.create(target)
    await workspace.attachSession(SessionId('linked'))
    await initial.ctx.fiber.dispose()
    await rm(target, { recursive: true })

    const restarted = await harness({ pool: initial.pool, sessions })
    onTestFinished(() => restarted.ctx.fiber.dispose())
    expect(restarted.registry.get(workspace.id)!.sessionIds).toEqual(['linked'])
    const fresh = await harness({ sessions })
    onTestFinished(() => fresh.ctx.fiber.dispose())
    expect(fresh.registry.list()).toEqual([])
  })

  it('preserves an owned session when the directory disappears between realpath and stat', async () => {
    const dir = await makeDir('stat-missing')
    const id = WorkspaceId('stat-missing-workspace')
    const pool = storedPool([[id, record(dir, ['kept'])]], { initialized: true, workspaceIds: [id] })
    const normalize = workspacePaths.realpathNormalize
    const spy = vi.spyOn(workspacePaths, 'realpathNormalize').mockImplementation(async (path) => {
      const canonical = await normalize(path)
      if (path === dir) await rm(dir, { recursive: true })
      return canonical
    })
    onTestFinished(() => { spy.mockRestore() })
    const result = await harness({ pool, sessions: [header('kept', dir)] })
    onTestFinished(() => result.ctx.fiber.dispose())
    expect(result.registry.get(id)!.sessionIds).toEqual(['kept'])
  })

  it.each(['EACCES', 'ELOOP', 'ENOTDIR'])('does not preserve candidates after a %s path failure', async (code) => {
    const dir = await makeDir(`path-error-${code}`)
    const id = WorkspaceId(`path-error-${code}`)
    const pool = storedPool([[id, record(dir, ['invalid'])]], { initialized: true, workspaceIds: [id] })
    const spy = vi.spyOn(workspacePaths, 'realpathNormalize').mockRejectedValue(Object.assign(new Error(code), { code }))
    onTestFinished(() => { spy.mockRestore() })
    const result = await harness({ pool, sessions: [header('invalid', dir)] })
    onTestFinished(() => result.ctx.fiber.dispose())
    const workspace = result.registry.get(id)!
    expect(workspace.sessionIds).toEqual([])
    await workspace.setTitle('Pruned')
    expect(storedRecord(pool, id).sessionIds).toEqual([])
  })

  it('clears the missing-path exemption when a later header index resolves elsewhere or becomes invalid', async () => {
    const dir = await makeDir('reindexed-missing')
    const elsewhere = await makeDir('reindexed-elsewhere')
    const id = WorkspaceId('reindexed-workspace')
    const pool = storedPool([[id, record(dir, ['kept'])]], { initialized: true, workspaceIds: [id] })
    await rm(dir, { recursive: true })
    const result = await harness({ pool, sessions: [header('kept', dir)] })
    onTestFinished(() => result.ctx.fiber.dispose())
    const workspace = result.registry.get(id)!
    expect(workspace.sessionIds).toEqual(['kept'])
    result.setSessions([header('kept', elsewhere), header('trigger-one', elsewhere)])
    await result.registry.pinSession(SessionId('trigger-one'))
    expect(workspace.sessionIds).toEqual([])
    result.setSessions([header('kept', dir), header('trigger-two', elsewhere)])
    await result.registry.pinSession(SessionId('trigger-two'))
    expect(workspace.sessionIds).toEqual(['kept'])
    result.setSessions([header('kept'), header('trigger-three', elsewhere)])
    await result.registry.pinSession(SessionId('trigger-three'))
    expect(workspace.sessionIds).toEqual([])
    await workspace.setTitle('Pruned')
    expect(storedRecord(pool, id).sessionIds).toEqual([])
  })

  it('filters absent headers and invalid cwd facts while retaining only missing-directory candidates', async () => {
    const dir = await makeDir('candidate-validation')
    const elsewhere = await makeDir('candidate-elsewhere')
    const missing = join(base, 'candidate-missing')
    const file = join(base, 'candidate-file')
    await writeFile(file, 'not a directory')
    const id = WorkspaceId('candidate-validation')
    const pool = storedPool(
      [[id, record(dir, ['missing-dir', 'no-header', 'no-cwd', 'relative', 'file', 'elsewhere'])]],
      { initialized: true, workspaceIds: [id] },
    )
    const result = await harness({
      pool,
      sessions: [
        header('missing-dir', missing), header('no-cwd'), header('relative', 'relative-missing'),
        header('file', file), header('elsewhere', elsewhere), header('unowned', missing),
      ],
    })
    onTestFinished(() => result.ctx.fiber.dispose())
    const workspace = result.registry.get(id)!
    expect(workspace.sessionIds).toEqual(['missing-dir'])
    await workspace.setTitle('Validated')
    expect(storedRecord(pool, id).sessionIds).toEqual(['missing-dir'])
  })

  it('can detach and reattach a missing-directory candidate after the directory is restored', async () => {
    const dir = await makeDir('reattach-restored')
    const id = WorkspaceId('reattach-restored')
    const pool = storedPool([[id, record(dir, ['restored'])]], { initialized: true, workspaceIds: [id] })
    await rm(dir, { recursive: true })
    const result = await harness({ pool, sessions: [header('restored', dir)] })
    onTestFinished(() => result.ctx.fiber.dispose())
    const workspace = result.registry.get(id)!
    await workspace.detachSession(SessionId('restored'))
    expect(workspace.sessionIds).toEqual([])
    await mkdir(dir)
    await workspace.attachSession(SessionId('restored'))
    expect(workspace.sessionIds).toEqual(['restored'])
    expect(await workspace.status()).toBe('ok')
  })

  it('requires both candidate id and matching canonical cwd without re-reading on list()', async () => {
    const owned = await makeDir('owned')
    const elsewhere = await makeDir('projection-elsewhere')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000001')
    const pool = storedPool(
      [[id, record(owned, ['good', 'mismatch', 'missing'])]],
      { initialized: true, workspaceIds: [id] },
    )
    const result = await harness({
      pool,
      sessions: [
        header('good', owned),
        header('mismatch', elsewhere),
        header('cwd-only', owned),
      ],
    })
    const workspace = result.registry.list()[0]!
    expect(workspace.sessionIds).toEqual(['good'])
    expect(result.registry.list()[0]!.sessionIds).toEqual(['good'])
    expect(result.list).toHaveBeenCalledTimes(1)
    expect(storedRecord(pool, id).sessionIds).toEqual(['good', 'mismatch', 'missing'])

    await workspace.setTitle('pruned')
    expect(storedRecord(pool, id).sessionIds).toEqual(['good'])
    expect(workspace.sessionIds).not.toContain('cwd-only')
  })

  it('rejects duplicate candidate ownership, duplicate paths, and initialized order drift', async () => {
    const first = await makeDir('corrupt-first')
    const second = await makeDir('corrupt-second')
    const firstId = '00000000-0000-4000-8000-000000000002'
    const secondId = '00000000-0000-4000-8000-000000000003'
    const duplicateSession = storedPool(
      [[firstId, record(first, ['dup'])], [secondId, record(second, ['dup'])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId), WorkspaceId(secondId)] },
    )
    await expect(harness({ pool: duplicateSession })).rejects.toThrow(/accounted/)

    const duplicatePath = storedPool(
      [[firstId, record(first, [])], [secondId, record(first, [])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId), WorkspaceId(secondId)] },
    )
    await expect(harness({ pool: duplicatePath })).rejects.toThrow(/claimed/)

    const orphan = storedPool(
      [[firstId, record(first, [])], [secondId, record(second, [])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId)] },
    )
    await expect(harness({ pool: orphan })).rejects.toThrow(/absent from registry order/)

    const repeated = storedPool(
      [[firstId, record(first, [])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId), WorkspaceId(firstId)] },
    )
    await expect(harness({ pool: repeated })).rejects.toThrow(/repeats workspace/)

    const missing = storedPool(
      [],
      { initialized: true, workspaceIds: [WorkspaceId(firstId)] },
    )
    await expect(harness({ pool: missing })).rejects.toThrow(/references missing workspace/)
  })

  it('fails list if the durable order and entity cache are externally diverged', async () => {
    const dir = await makeDir('cache-diverged')
    const result = await harness()
    const workspace = await result.registry.create(dir)
    const internals = result.registry as unknown as { entities: Map<WorkspaceId, unknown> }
    internals.entities.delete(workspace.id)
    expect(() => result.registry.list()).toThrow(/references missing workspace/)
  })

  it('recovers only an explicitly marked interrupted create or delete', async () => {
    const createDir = await makeDir('pending-create')
    const deleteDir = await makeDir('pending-delete')
    const createId = WorkspaceId('00000000-0000-4000-8000-000000000004')
    const deleteId = WorkspaceId('00000000-0000-4000-8000-000000000005')

    const interruptedCreate = storedPool(
      [[createId, record(createDir, [])]],
      {
        initialized: true,
        workspaceIds: [],
        pendingMutation: { operation: 'create', workspaceId: createId },
      },
    )
    const createRecovery = await harness({ pool: interruptedCreate })
    expect(createRecovery.registry.list()).toEqual([])
    expect(interruptedCreate.media.get('workspace')!.tables.get('workspaces')!.has(createId)).toBe(false)
    expect(storedState(interruptedCreate)).toEqual({
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      groupIds: [],
    })

    const filingGroupId = '00000000-0000-4000-8000-0000000000e1'
    const untouchedGroupId = '00000000-0000-4000-8000-0000000000e2'
    const interruptedDelete = storedPool(
      [[deleteId, record(deleteDir, [])]],
      {
        initialized: true,
        workspaceIds: [],
        groupIds: [filingGroupId, untouchedGroupId].map(GroupId),
        pendingMutation: { operation: 'delete', workspaceId: deleteId },
      },
      // The delete recovery scrubs the id from every group record still
      // filing it; a group not filing it is skipped untouched.
      [
        [filingGroupId, groupRecord('filing', [deleteId])],
        [untouchedGroupId, groupRecord('untouched', [])],
      ],
    )
    const deleteRecovery = await harness({ pool: interruptedDelete })
    expect(deleteRecovery.registry.list()).toEqual([])
    expect(interruptedDelete.media.get('workspace')!.tables.get('workspaces')!.has(deleteId)).toBe(false)
    const filingId = GroupId(filingGroupId)
    const untouchedId = GroupId(untouchedGroupId)
    expect(storedState(interruptedDelete)).toEqual({
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      groupIds: [filingId, untouchedId],
    })
    expect(storedGroupRecord(interruptedDelete, filingId).workspaceIds).toEqual([])
    expect(storedGroupRecord(interruptedDelete, untouchedId).title).toBe('untouched')

    const corruptPending = storedPool(
      [[deleteId, record(deleteDir, [])]],
      {
        initialized: true,
        workspaceIds: [deleteId],
        pendingMutation: { operation: 'delete', workspaceId: deleteId },
      },
    )
    await expect(harness({ pool: corruptPending })).rejects.toThrow(/still present in registry order/)
  })
})

describe('workspace mutation and status', () => {
  it('keeps createdAt stable, advances updatedAt, and preserves snapshot on write failure', async () => {
    const dir = await makeDir('timestamps')
    const result = await harness()
    const workspace = await result.registry.create(dir)
    const createdAt = workspace.createdAt
    expect(workspace.updatedAt).toBe(createdAt)
    await workspace.setTitle('kept')
    expect(workspace.createdAt).toBe(createdAt)
    expect(Date.parse(workspace.updatedAt)).toBeGreaterThanOrEqual(Date.parse(createdAt))
    result.pool.failNextWrites = 1
    await expect(workspace.setTitle('lost')).rejects.toThrow(/injected/)
    expect(workspace.title).toBe('kept')
  })

  it('reports directory disappearance without mutating the workspace', async () => {
    const dir = await makeDir('vanishing')
    const { registry } = await harness()
    const workspace = await registry.create(dir)
    expect(await workspace.status()).toBe('ok')
    await rm(dir, { recursive: true })
    expect(await workspace.status()).toBe('missing-dir')
    await writeFile(dir, 'now a file')
    expect(await workspace.status()).toBe('missing-dir')
    expect(registry.get(workspace.id)).toBe(workspace)
  })
})

describe('registry-global session archive', () => {
  it('archives durably in order, idempotently skips repeats, and leaves accounting untouched', async () => {
    const dir = await makeDir('archive-home')
    const result = await harness({ sessions: [header('kept', dir, 100), header('gone', dir, 200)] })
    const workspace = result.registry.list()[0]!
    expect(result.registry.archivedSessionIds).toEqual([])

    await result.registry.archiveSession(SessionId('gone'))
    expect(result.registry.archivedSessionIds).toEqual(['gone'])
    // Archiving is a display-set write: the workspace account keeps the id.
    expect(workspace.sessionIds).toContain('gone')
    expect(storedState(result.pool).archivedSessionIds).toEqual(['gone'])
    const changesAfterFirst = result.changes.filter(change => change.table === '').length

    await result.registry.archiveSession(SessionId('gone'))
    expect(result.registry.archivedSessionIds).toEqual(['gone'])
    // The idempotent repeat neither rewrites the medium nor emits a change.
    expect(result.changes.filter(change => change.table === '').length).toBe(changesAfterFirst)

    await result.registry.archiveSession(SessionId('kept'))
    expect(result.registry.archivedSessionIds).toEqual(['gone', 'kept'])
  })

  it('accepts unaccounted and live sessions but rejects unknown ids without writing', async () => {
    const dir = await makeDir('archive-strays')
    const live = await makeDir('archive-live')
    const result = await harness({
      sessions: [header('stray', dir, 100)],
      liveSessions: [header('live-only', live, 200)],
    })
    await result.registry.archiveSession(SessionId('stray'))
    await result.registry.archiveSession(SessionId('live-only'))
    expect(result.registry.archivedSessionIds).toEqual(['stray', 'live-only'])

    await expect(result.registry.archiveSession(SessionId('ghost')))
      .rejects.toThrow(/cannot archive session 'ghost'/)
    expect(storedState(result.pool).archivedSessionIds).toEqual(['stray', 'live-only'])
  })

  it('propagates a persistence-listing failure instead of reporting an unknown session', async () => {
    const result = await harness({ sessions: [] })
    result.list.mockRejectedValueOnce(new Error('persistence backend down'))
    // The storage fault is the error — never WorkspaceUnknownSessionError,
    // which the API layer would misreport as session-not-found.
    await expect(result.registry.archiveSession(SessionId('unlisted')))
      .rejects.toThrow(/persistence backend down/)
    expect(storedState(result.pool).archivedSessionIds).toEqual([])
  })

  it('refuses a session the activity waterfall reports active and writes nothing', async () => {
    const dir = await makeDir('archive-active')
    const result = await harness({ sessions: [header('busy', dir, 100), header('quiet', dir, 200)] })
    const asked: SessionId[] = []
    result.ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      asked.push(sessionId)
      const rest = await next()
      return sessionId === 'busy'
        ? [{ kind: 'probe' }, { kind: 'probe-items', items: [{ id: 'item-1', label: 'build' }] }, ...rest]
        : rest
    })

    await expect(result.registry.archiveSession(SessionId('busy'))).rejects.toMatchObject({
      name: 'WorkspaceActiveSessionError',
      sessionId: 'busy',
      activity: [{ kind: 'probe' }, { kind: 'probe-items', items: [{ id: 'item-1', label: 'build' }] }],
    })
    expect(result.registry.archivedSessionIds).toEqual([])
    expect(storedState(result.pool).archivedSessionIds).toEqual([])
    expect(result.changes.filter(change => change.table === '')).toEqual([])

    await result.registry.archiveSession(SessionId('quiet'))
    expect(result.registry.archivedSessionIds).toEqual(['quiet'])
    expect(asked).toEqual(['busy', 'quiet'])

    // The idempotent repeat resolves before any activity question is asked.
    await result.registry.archiveSession(SessionId('quiet'))
    expect(asked).toEqual(['busy', 'quiet'])
  })

  it('with stopActivity, writes the archive and then asks providers to stop, even when one of them fails', async () => {
    const dir = await makeDir('archive-stop')
    const result = await harness({ sessions: [header('busy', dir, 100)] })
    const order: string[] = []
    result.ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      order.push(`activity:${sessionId}`)
      return [{ kind: 'probe' }, ...(await next())]
    })
    result.ctx.on('workspace/session-stop', ({ sessionId }) => { order.push(`stop:${sessionId}`) })
    result.ctx.on('workspace/session-stop', () => { throw new Error('job kill exploded') })
    result.ctx.on('domain/changed', (change) => { if (change.table === '') order.push('write') })
    const warn = vi.spyOn(result.ctx.logger, 'warn').mockImplementation(() => {})

    await result.registry.archiveSession(SessionId('busy'), { stopActivity: true })
    expect(result.registry.archivedSessionIds).toEqual(['busy'])
    expect(storedState(result.pool).archivedSessionIds).toEqual(['busy'])
    // The archive write lands first, so a provider's gate sees the archived
    // set before any stop-induced wake; the activity question is not asked
    // because the caller already chose to stop what runs.
    expect(order).toEqual(['write', 'stop:busy'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('job kill exploded'))

    // A repeat resolves before stopping anything again.
    order.length = 0
    await result.registry.archiveSession(SessionId('busy'), { stopActivity: true })
    expect(order).toEqual([])
    // An unknown session is still refused before any provider is asked to stop.
    await expect(result.registry.archiveSession(SessionId('ghost'), { stopActivity: true }))
      .rejects.toThrow(/cannot archive session 'ghost'/)
    expect(order).toEqual([])
  })

  it('asks about activity only after the session is known, and archives when every listener delegates', async () => {
    const dir = await makeDir('archive-quiet')
    const result = await harness({ sessions: [header('known', dir, 100)] })
    const asked: SessionId[] = []
    result.ctx.on('workspace/session-activity', ({ sessionId }, next) => {
      asked.push(sessionId)
      return next()
    })
    await expect(result.registry.archiveSession(SessionId('ghost')))
      .rejects.toThrow(/cannot archive session 'ghost'/)
    expect(asked).toEqual([])

    await result.registry.archiveSession(SessionId('known'))
    expect(asked).toEqual(['known'])
    expect(result.registry.archivedSessionIds).toEqual(['known'])
  })

  it('restores the archive set across restarts and defaults it for pre-field media', async () => {
    const dir = await makeDir('archive-restart')
    const pool = new MemoryMediaPool()
    const first = await harness({ pool, sessions: [header('s1', dir, 100)] })
    await first.registry.archiveSession(SessionId('s1'))
    await first.fiber.dispose()

    const second = await harness({ pool, sessions: [header('s1', dir, 100)] })
    expect(second.registry.archivedSessionIds).toEqual(['s1'])
    await second.fiber.dispose()

    // A medium written before the field existed parses through the schema default.
    const legacyId = WorkspaceId('00000000-0000-4000-8000-00000000000a')
    const legacy = storedPool(
      [[legacyId, record(dir, [])]],
      { initialized: true, workspaceIds: [legacyId] },
    )
    const upgraded = await harness({ pool: legacy })
    expect(upgraded.registry.archivedSessionIds).toEqual([])
  })
})

describe('permanent session deletion', () => {
  it('erases the stored session, then scrubs the archive set, membership, and header caches', async () => {
    const dir = await makeDir('delete-session')
    const result = await harness({ sessions: [header('keep', dir, 100), header('gone', dir, 200)] })
    const workspace = result.registry.list()[0]!
    await result.registry.archiveSession(SessionId('gone'))

    await result.registry.deleteSession(SessionId('gone'))

    expect(result.remove).toHaveBeenCalledWith('gone')
    expect(result.registry.archivedSessionIds).toEqual([])
    expect(workspace.sessionIds).toEqual(['keep'])
    expect(storedState(result.pool).archivedSessionIds).toEqual([])
    await expect(result.registry.archiveSession(SessionId('gone'))).rejects.toBeInstanceOf(WorkspaceUnknownSessionError)
  })

  it('scrubs the registry when persistence no longer holds the session', async () => {
    const dir = await makeDir('delete-vanished')
    const result = await harness({ sessions: [header('vanished', dir, 100)] })
    await result.registry.archiveSession(SessionId('vanished'))
    result.remove.mockRejectedValueOnce(new SessionPersistenceNotFoundError(SessionId('vanished')))

    await result.registry.deleteSession(SessionId('vanished'))

    expect(result.registry.archivedSessionIds).toEqual([])
  })

  it('scrubs a session that was never archived without rewriting the archive set', async () => {
    const dir = await makeDir('delete-unarchived')
    const result = await harness({ sessions: [header('plain', dir, 100)] })
    const workspace = result.registry.list()[0]!
    expect(result.registry.archivedSessionIds).toEqual([])

    await result.registry.deleteSession(SessionId('plain'))

    expect(result.remove).toHaveBeenCalledWith('plain')
    expect(workspace.sessionIds).toEqual([])
    expect(result.registry.archivedSessionIds).toEqual([])
    expect(storedState(result.pool).archivedSessionIds).toEqual([])
  })

  it('scrubs a permanently deleted Session from its logical Folder', async () => {
    const dir = await makeDir('delete-filed')
    const result = await harness({ sessions: [header('filed', dir, 100)] })
    const workspace = result.registry.list()[0]!
    const folder = await workspace.createFolder('Current work')
    await workspace.moveSessionToFolder(SessionId('filed'), folder.id)

    await result.registry.deleteSession(SessionId('filed'))

    expect(workspace.sessionIds).toEqual([])
    expect(workspace.folders).toEqual([expect.objectContaining({ id: folder.id, sessionIds: [] })])
    expect(storedRecord(result.pool, workspace.id).folders[0]?.sessionIds).toEqual([])
  })

  it('keeps every registry reference when persistence refuses the delete', async () => {
    const dir = await makeDir('delete-refused')
    const result = await harness({ sessions: [header('busy', dir, 100)] })
    await result.registry.archiveSession(SessionId('busy'))
    result.remove.mockRejectedValueOnce(new SessionAlreadyOwnedError(SessionId('busy')))

    await expect(result.registry.deleteSession(SessionId('busy'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)

    expect(result.registry.archivedSessionIds).toEqual(['busy'])
    expect(result.registry.list()[0]!.sessionIds).toEqual(['busy'])
  })
})

describe('registry-global session unarchive', () => {
  it('unarchives durably in order, idempotently skips absent ids, and leaves accounting untouched', async () => {
    const dir = await makeDir('unarchive-home')
    const result = await harness({
      sessions: [header('one', dir, 100), header('two', dir, 200), header('three', dir, 300)],
    })
    const workspace = result.registry.list()[0]!
    await result.registry.archiveSession(SessionId('one'))
    await result.registry.archiveSession(SessionId('two'))
    await result.registry.archiveSession(SessionId('three'))
    expect(result.registry.archivedSessionIds).toEqual(['one', 'two', 'three'])

    await result.registry.unarchiveSession(SessionId('two'))
    // Removal keeps the survivors in archive order.
    expect(result.registry.archivedSessionIds).toEqual(['one', 'three'])
    // Unarchiving is a display-set write: the workspace account keeps the id.
    expect(workspace.sessionIds).toContain('two')
    expect(storedState(result.pool).archivedSessionIds).toEqual(['one', 'three'])
    const changesAfterFirst = result.changes.filter(change => change.table === '').length

    await result.registry.unarchiveSession(SessionId('two'))
    expect(result.registry.archivedSessionIds).toEqual(['one', 'three'])
    // The absent-id repeat neither rewrites the medium nor emits a change.
    expect(result.changes.filter(change => change.table === '').length).toBe(changesAfterFirst)

    await result.registry.unarchiveSession(SessionId('never-archived'))
    expect(result.registry.archivedSessionIds).toEqual(['one', 'three'])
    expect(result.changes.filter(change => change.table === '').length).toBe(changesAfterFirst)
  })

  it('unarchives an entry whose session is gone without consulting session persistence', async () => {
    const dir = await makeDir('unarchive-vanished')
    const result = await harness({ sessions: [header('vanished', dir, 100)] })
    await result.registry.archiveSession(SessionId('vanished'))
    result.setSessions([])
    const listingsBefore = result.list.mock.calls.length
    result.list.mockRejectedValueOnce(new Error('persistence backend down'))

    // Removing an id cannot introduce an unknown one, so the archive entry
    // resolves even though no session backs it and no listing runs.
    await expect(result.registry.unarchiveSession(SessionId('vanished'))).resolves.toBeUndefined()
    expect(result.registry.archivedSessionIds).toEqual([])
    expect(result.list.mock.calls.length).toBe(listingsBefore)
  })

  it('keeps the surviving archive set across restarts', async () => {
    const dir = await makeDir('unarchive-restart')
    const pool = new MemoryMediaPool()
    const sessions = [header('kept', dir, 100), header('restored', dir, 200)]
    const first = await harness({ pool, sessions })
    await first.registry.archiveSession(SessionId('kept'))
    await first.registry.archiveSession(SessionId('restored'))
    await first.registry.unarchiveSession(SessionId('restored'))
    await first.fiber.dispose()

    const second = await harness({ pool, sessions })
    expect(second.registry.archivedSessionIds).toEqual(['kept'])
  })
})

describe('registry-global session pin', () => {
  it('pins durably in prepend order, idempotently skips repeats, and leaves accounting untouched', async () => {
    const dir = await makeDir('pin-home')
    const result = await harness({ sessions: [header('first', dir, 100), header('second', dir, 200)] })
    const workspace = result.registry.list()[0]!
    expect(result.registry.pinnedSessionIds).toEqual([])

    await result.registry.pinSession(SessionId('first'))
    expect(result.registry.pinnedSessionIds).toEqual(['first'])
    const firstEntry = result.registry.pinnedSessionIds[0]!
    expect(firstEntry).toEqual(SessionId('first'))
    // Pinning is a display-set write: the workspace account keeps the id.
    expect(workspace.sessionIds).toContain('first')
    expect(storedState(result.pool).pinnedSessionIds).toEqual([firstEntry])
    const changesAfterFirst = result.changes.filter(change => change.table === '').length

    await result.registry.pinSession(SessionId('first'))
    expect(result.registry.pinnedSessionIds).toEqual([firstEntry])
    expect(result.changes.filter(change => change.table === '').length).toBe(changesAfterFirst)

    // The most recent pin lands first (display order).
    await result.registry.pinSession(SessionId('second'))
    expect(result.registry.pinnedSessionIds).toEqual(['second', 'first'])
    expect(storedState(result.pool).pinnedSessionIds).toEqual([
      SessionId('second'), SessionId('first'),
    ])
  })

  it('rejects pinning archived and unknown sessions without writing', async () => {
    const dir = await makeDir('pin-rejects')
    const result = await harness({ sessions: [header('stored', dir, 100)] })
    await result.registry.archiveSession(SessionId('stored'))

    await expect(result.registry.pinSession(SessionId('stored')))
      .rejects.toThrow(/cannot pin session 'stored': the session is archived/)
    await expect(result.registry.pinSession(SessionId('ghost')))
      .rejects.toThrow(/cannot pin session 'ghost'/)
    expect(storedState(result.pool).pinnedSessionIds).toEqual([])
  })

  it('propagates a persistence-listing failure instead of reporting an unknown session', async () => {
    const result = await harness({ sessions: [] })
    result.list.mockRejectedValueOnce(new Error('persistence backend down'))
    // The storage fault is the error — never WorkspaceUnknownSessionError,
    // which the API layer would misreport as session-not-found.
    await expect(result.registry.pinSession(SessionId('unlisted')))
      .rejects.toThrow(/persistence backend down/)
    expect(storedState(result.pool).pinnedSessionIds).toEqual([])
  })

  it('archiving drops the pin in the same durable write', async () => {
    const dir = await makeDir('pin-then-archive')
    const result = await harness({ sessions: [header('s1', dir, 100), header('s2', dir, 200)] })
    await result.registry.pinSession(SessionId('s1'))
    await result.registry.pinSession(SessionId('s2'))

    await result.registry.archiveSession(SessionId('s1'))
    expect(result.registry.pinnedSessionIds).toEqual(['s2'])
    expect(result.registry.archivedSessionIds).toEqual(['s1'])
    const stored = storedState(result.pool)
    expect(stored.pinnedSessionIds).toEqual(['s2'])
    expect(stored.archivedSessionIds).toEqual(['s1'])
  })

  it('restores the pin set across restarts', async () => {
    const dir = await makeDir('pin-restart')
    const pool = new MemoryMediaPool()
    const sessions = [header('kept', dir, 100)]
    const first = await harness({ pool, sessions })
    await first.registry.pinSession(SessionId('kept'))
    const pinned = [...first.registry.pinnedSessionIds]
    await first.fiber.dispose()

    const second = await harness({ pool, sessions })
    expect(second.registry.pinnedSessionIds).toEqual(pinned)
  })

})

describe('registry-global session unpin', () => {
  it('unpins durably in place and idempotently skips absent ids', async () => {
    const dir = await makeDir('unpin-home')
    const result = await harness({
      sessions: [header('one', dir, 100), header('two', dir, 200), header('three', dir, 300)],
    })
    await result.registry.pinSession(SessionId('one'))
    await result.registry.pinSession(SessionId('two'))
    await result.registry.pinSession(SessionId('three'))
    expect(result.registry.pinnedSessionIds).toEqual(['three', 'two', 'one'])

    await result.registry.unpinSession(SessionId('two'))
    // Removal keeps the survivors in pin order.
    expect(result.registry.pinnedSessionIds).toEqual(['three', 'one'])
    expect(storedState(result.pool).pinnedSessionIds).toEqual(['three', 'one'])
    const changesAfterFirst = result.changes.filter(change => change.table === '').length

    await result.registry.unpinSession(SessionId('two'))
    expect(result.registry.pinnedSessionIds).toEqual(['three', 'one'])
    // The absent-id repeat neither rewrites the medium nor emits a change.
    expect(result.changes.filter(change => change.table === '').length).toBe(changesAfterFirst)
  })

  it('unpins an entry whose session is gone without consulting session persistence', async () => {
    const dir = await makeDir('unpin-vanished')
    const result = await harness({ sessions: [header('vanished', dir, 100)] })
    await result.registry.pinSession(SessionId('vanished'))
    result.setSessions([])
    const listingsBefore = result.list.mock.calls.length
    result.list.mockRejectedValueOnce(new Error('persistence backend down'))

    // Removing an id cannot introduce an unknown one, so the pin entry
    // resolves even though no session backs it and no listing runs.
    await expect(result.registry.unpinSession(SessionId('vanished'))).resolves.toBeUndefined()
    expect(result.registry.pinnedSessionIds).toEqual([])
    expect(result.list.mock.calls.length).toBe(listingsBefore)
  })
})

describe('first-use Workspace preparation', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  })

  async function firstUse(options: HarnessOptions = {}) {
    const directoryRoot = await makeDir('first-use')
    const result = await harness({ liveSessions: [], ...options })
    contexts.push(result.ctx)
    const resolveDirectory = vi.fn(async () => join(directoryRoot, 'nested', 'Workspace'))
    return { ...result, directoryRoot, resolveDirectory }
  }

  it('creates parent directories and resolves only one directory for concurrent initialization', async () => {
    const h = await firstUse()
    const laterDirectory = vi.fn(async () => { throw new Error('directory lookup unavailable') })
    const [first, repeated] = await Promise.all([
      h.registry.initializeDefault(h.resolveDirectory), h.registry.initializeDefault(laterDirectory),
    ])
    expect(first).toBeDefined()
    expect(repeated).toBe(first)
    expect(h.resolveDirectory).toHaveBeenCalledOnce()
    expect(laterDirectory).not.toHaveBeenCalled()
    expect(first?.path).toBe(await realpath(join(h.directoryRoot, 'nested', 'Workspace')))
    // The caller supplies no title: the initial one is the directory's final segment.
    expect(first?.title).toBe('Workspace')
    expect(h.registry.list()).toEqual([first])
    expect(storedState(h.pool).defaultWorkspaceId).toBe(first?.id)
    expect(h.ctx.sessions.list()).toEqual([])
    expect(h.open).not.toHaveBeenCalled()
  })

  it('reuses an existing directory without changing its contents', async () => {
    const h = await firstUse()
    const directory = join(h.directoryRoot, 'nested', 'Workspace')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'keep.txt'), 'keep')
    expect((await h.registry.initializeDefault(h.resolveDirectory))?.path).toBe(directory)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('leaves initialization retryable when directory resolution fails', async () => {
    const h = await firstUse()
    h.resolveDirectory.mockRejectedValueOnce(new Error('lookup unavailable'))
    await expect(h.registry.initializeDefault(h.resolveDirectory)).rejects.toThrow('lookup unavailable')
    expect(storedState(h.pool).defaultWorkspaceId).toBeUndefined()
    expect(await h.registry.initializeDefault(h.resolveDirectory)).toBeDefined()
  })

  it('rejects a relative candidate before creating its directory', async () => {
    const h = await firstUse()
    const candidate = join(h.directoryRoot, 'relative')
    h.resolveDirectory.mockResolvedValueOnce(relative(h.directoryRoot, candidate))
    await expect(h.registry.initializeDefault(h.resolveDirectory)).rejects.toThrow('fully qualified')
    await expect(realpath(candidate)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.registry.list()).toEqual([])
    expect(storedState(h.pool).defaultWorkspaceId).toBeUndefined()
  })

  it('keeps the initialization marker across deletion and restart', async () => {
    const h = await firstUse()
    const workspace = (await h.registry.initializeDefault(h.resolveDirectory))!
    await workspace.setTitle('Renamed')
    expect((await h.registry.initializeDefault(h.resolveDirectory))?.title).toBe('Renamed')
    await h.registry.delete(workspace.id)
    await h.ctx.fiber.dispose()
    const restarted = await firstUse({ pool: h.pool })
    await expect(restarted.registry.initializeDefault(restarted.resolveDirectory)).resolves.toBeUndefined()
    expect(storedState(h.pool).defaultWorkspaceId).toBe(workspace.id)
    expect(restarted.registry.list()).toEqual([])
    expect(restarted.resolveDirectory).not.toHaveBeenCalled()
  })

  it.each(['persisted', 'live', 'archived'] as const)('refuses automatic creation for a %s cwd-less Session', async (kind) => {
    const history = header('old')
    const h = await firstUse(kind === 'persisted' ? { sessions: [history] } : { liveSessions: [history] })
    if (kind === 'archived') await h.registry.archiveSession(history.id)
    await expect(h.registry.initializeDefault(h.resolveDirectory)).resolves.toBeUndefined()
    expect(h.registry.list()).toEqual([])
    expect(storedState(h.pool).defaultWorkspaceId).toBeUndefined()
    expect(h.resolveDirectory).not.toHaveBeenCalled()
  })

  it('refuses a non-empty Workspace list and newly persisted history', async () => {
    const h = await firstUse()
    const explicit = await h.registry.create(h.directoryRoot)
    await expect(h.registry.initializeDefault(h.resolveDirectory)).resolves.toBeUndefined()
    await h.registry.delete(explicit.id)
    h.setSessions([header('arrived')])
    await expect(h.registry.initializeDefault(h.resolveDirectory)).resolves.toBeUndefined()
  })

  it('fails on a same-path file and remains eligible after it is removed', async () => {
    const h = await firstUse()
    const parent = join(h.directoryRoot, 'nested')
    await mkdir(parent)
    const path = join(parent, 'Workspace')
    await writeFile(path, 'occupied')
    await expect(h.registry.initializeDefault(h.resolveDirectory)).rejects.toThrow()
    expect(storedState(h.pool).defaultWorkspaceId).toBeUndefined()
    expect(h.registry.list()).toEqual([])
    await rm(path)
    expect((await h.registry.initializeDefault(h.resolveDirectory))?.path).toBe(path)
  })

  it('titles the Workspace after the requested directory when that path is a symlink', async () => {
    const h = await firstUse()
    const target = join(h.directoryRoot, 'elsewhere')
    await mkdir(target)
    await mkdir(join(h.directoryRoot, 'nested'))
    await symlink(target, join(h.directoryRoot, 'nested', 'Workspace'))
    const workspace = await h.registry.initializeDefault(h.resolveDirectory)
    expect(workspace?.path).toBe(await realpath(target))
    // Not 'elsewhere': the title names the directory the caller asked for, so
    // the caller can still recognize a Workspace it has not renamed.
    expect(workspace?.title).toBe('Workspace')
  })

  it.each(['persisted', 'live'] as const)('refuses registration when a %s Session appears during directory preparation', async (kind) => {
    const h = await firstUse()
    const arrived = header('arrived-during-preparation')
    if (kind === 'persisted') {
      h.list.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { header: arrived, revision: SessionPersistenceRevision('arrived-revision') },
      ])
    } else {
      vi.spyOn(h.ctx.sessions, 'list').mockReturnValueOnce([]).mockReturnValueOnce([{ header: arrived }] as never)
    }
    await expect(h.registry.initializeDefault(h.resolveDirectory)).resolves.toBeUndefined()
    expect(h.registry.list()).toEqual([])
    expect(storedState(h.pool).defaultWorkspaceId).toBeUndefined()
  })

  it('does not infer an empty live Session store when the peer is unavailable', async () => {
    const h = await harness()
    contexts.push(h.ctx)
    const resolveDirectory = vi.fn(async () => { throw new Error('unexpected directory lookup') })
    await expect(h.registry.initializeDefault(resolveDirectory)).rejects.toThrow('Session store')
    expect(resolveDirectory).not.toHaveBeenCalled()
    expect(storedState(h.pool).defaultWorkspaceId).toBeUndefined()
  })

  it('rolls back a failed final marker write and allows a retry', async () => {
    const pool = new MemoryMediaPool()
    const h = await firstUse({ pool, backend: selectiveFailureBackend(pool, { globalAt: 3 }) })
    await expect(h.registry.initializeDefault(h.resolveDirectory)).rejects.toThrow('marker failure')
    expect(h.registry.list()).toEqual([])
    expect(storedState(pool).defaultWorkspaceId).toBeUndefined()
    await expect(realpath(join(h.directoryRoot, 'nested', 'Workspace'))).resolves.toBe(join(h.directoryRoot, 'nested', 'Workspace'))
    expect(await h.registry.initializeDefault(h.resolveDirectory)).toBeDefined()
  })
})

// The registry knows no family: the providers merge theirs, and this suite merges its own.
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    probe: true
    'probe-items': true
  }
}
describe('workspace groups', () => {
  it('creates groups newest-first and restores them across restarts', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    const alpha = await first.registry.createGroup('alpha')
    const beta = await first.registry.createGroup('beta')
    expect(alpha.title).toBe('alpha')
    expect(alpha.createdAt).toBe(alpha.updatedAt)
    expect(alpha.workspaceIds).toEqual([])
    expect(first.registry.listGroups()).toEqual([beta, alpha])
    expect(storedState(pool).groupIds).toEqual([beta.id, alpha.id])
    expect(storedGroupRecord(pool, alpha.id).title).toBe('alpha')

    await first.fiber.dispose()
    const second = await harness({ pool })
    expect(second.registry.listGroups().map(group => group.title)).toEqual(['beta', 'alpha'])
    expect(second.registry.getGroup(beta.id)!.id).toBe(beta.id)
    expect(second.registry.getGroup(GroupId('00000000-0000-4000-8000-0000000000f0'))).toBeUndefined()
  })

  it('renames through setTitle, updating the snapshot only after durability', async () => {
    const result = await harness()
    const group = await result.registry.createGroup('before')
    const createdAt = group.createdAt

    await group.setTitle('after')
    expect(group.title).toBe('after')
    expect(group.createdAt).toBe(createdAt)
    expect(Date.parse(group.updatedAt)).toBeGreaterThanOrEqual(Date.parse(createdAt))
    expect(storedGroupRecord(result.pool, group.id).title).toBe('after')

    // A same-title rename is a no-op: no table write, no domain change.
    const changesCount = result.changes.length
    await group.setTitle('after')
    expect(result.changes).toHaveLength(changesCount)

    result.pool.failNextWrites = 1
    await expect(group.setTitle('lost')).rejects.toThrow(/injected/)
    expect(group.title).toBe('after')
    expect(storedGroupRecord(result.pool, group.id).title).toBe('after')
  })

  it('appends when filing into a group and resurfaces at the head when moving out', async () => {
    const alphaDir = await makeDir('group-move-alpha')
    const betaDir = await makeDir('group-move-beta')
    const gammaDir = await makeDir('group-move-gamma')
    const deltaDir = await makeDir('group-move-delta')
    const result = await harness()
    const alpha = await result.registry.create(alphaDir)
    const beta = await result.registry.create(betaDir)
    const gamma = await result.registry.create(gammaDir)
    const delta = await result.registry.create(deltaDir)
    const group = await result.registry.createGroup('dest')

    // Filing appends to the group in move order.
    await result.registry.moveToGroup(beta.id, group.id)
    await result.registry.moveToGroup(delta.id, group.id)
    expect(group.workspaceIds).toEqual([beta.id, delta.id])
    expect(storedGroupRecord(result.pool, group.id).workspaceIds).toEqual([beta.id, delta.id])
    expect(result.registry.list()).toEqual([gamma, alpha])
    expect(storedState(result.pool).workspaceIds).toEqual([gamma.id, alpha.id])

    // Moving out resurfaces at the top-level head, not the original position.
    await result.registry.moveToGroup(beta.id)
    expect(group.workspaceIds).toEqual([delta.id])
    expect(result.registry.list().map(workspace => workspace.id)).toEqual([beta.id, gamma.id, alpha.id])
    expect(storedState(result.pool).workspaceIds).toEqual([beta.id, gamma.id, alpha.id])
    expect(storedGroupRecord(result.pool, group.id).workspaceIds).toEqual([delta.id])
  })

  it('appends when transferring directly between groups', async () => {
    const alphaDir = await makeDir('transfer-alpha')
    const betaDir = await makeDir('transfer-beta')
    const gammaDir = await makeDir('transfer-gamma')
    const result = await harness()
    const alpha = await result.registry.create(alphaDir)
    const beta = await result.registry.create(betaDir)
    const gamma = await result.registry.create(gammaDir)
    const source = await result.registry.createGroup('source')
    const target = await result.registry.createGroup('target')

    await result.registry.moveToGroup(beta.id, source.id)
    await result.registry.moveToGroup(gamma.id, source.id)
    await result.registry.moveToGroup(alpha.id, target.id)
    expect(source.workspaceIds).toEqual([beta.id, gamma.id])
    expect(target.workspaceIds).toEqual([alpha.id])

    await result.registry.moveToGroup(beta.id, target.id)
    expect(source.workspaceIds).toEqual([gamma.id])
    expect(target.workspaceIds).toEqual([alpha.id, beta.id])
    expect(storedGroupRecord(result.pool, source.id).workspaceIds).toEqual([gamma.id])
    expect(storedGroupRecord(result.pool, target.id).workspaceIds).toEqual([alpha.id, beta.id])
    expect(result.registry.list()).toEqual([])
    expect(storedState(result.pool).workspaceIds).toEqual([])
  })

  it('reorders Group members durably at named anchors and the Group end', async () => {
    const alphaDir = await makeDir('group-order-alpha')
    const betaDir = await makeDir('group-order-beta')
    const gammaDir = await makeDir('group-order-gamma')
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    const alpha = await first.registry.create(alphaDir)
    const beta = await first.registry.create(betaDir)
    const gamma = await first.registry.create(gammaDir)
    const group = await first.registry.createGroup('ordered')
    await first.registry.moveToGroup(alpha.id, group.id)
    await first.registry.moveToGroup(beta.id, group.id)
    await first.registry.moveToGroup(gamma.id, group.id)

    await first.registry.moveToGroup(gamma.id, group.id, beta.id)
    expect(group.workspaceIds).toEqual([alpha.id, gamma.id, beta.id])
    expect(storedGroupRecord(pool, group.id).workspaceIds).toEqual([alpha.id, gamma.id, beta.id])

    await first.registry.moveToGroup(alpha.id, group.id, null)
    expect(group.workspaceIds).toEqual([gamma.id, beta.id, alpha.id])
    expect(storedGroupRecord(pool, group.id).workspaceIds).toEqual([gamma.id, beta.id, alpha.id])

    await first.fiber.dispose()
    const second = await harness({ pool })
    expect(second.registry.getGroup(group.id)!.workspaceIds).toEqual([gamma.id, beta.id, alpha.id])
  })

  it('resolves a same-slot move without writing, and rejects unknown ids', async () => {
    const alphaDir = await makeDir('move-noop-alpha')
    const result = await harness()
    const alpha = await result.registry.create(alphaDir)
    const group = await result.registry.createGroup('noop')
    await result.registry.moveToGroup(alpha.id, group.id)

    // A move to the current slot writes nothing at all, so it survives an
    // injected write failure untouched — checked in both slots. A same-slot
    // move consumes no write, so the failure injected here stays pending for
    // the real move below.
    result.pool.failNextWrites = 1
    await result.registry.moveToGroup(alpha.id, group.id)
    expect(group.workspaceIds).toEqual([alpha.id])
    expect(result.pool.failNextWrites).toBe(1)
    result.pool.failNextWrites = 0

    // Explicit self and adjacent anchors also preserve the stored order without
    // consuming a write.
    result.pool.failNextWrites = 1
    await result.registry.moveToGroup(alpha.id, group.id, alpha.id)
    await result.registry.moveToGroup(alpha.id, group.id, null)
    expect(group.workspaceIds).toEqual([alpha.id])
    expect(result.pool.failNextWrites).toBe(1)
    result.pool.failNextWrites = 0

    await result.registry.moveToGroup(alpha.id)
    expect(result.registry.list()).toEqual([alpha])
    result.pool.failNextWrites = 1
    await result.registry.moveToGroup(alpha.id)
    expect(result.registry.list()).toEqual([alpha])
    expect(result.pool.failNextWrites).toBe(1)
    result.pool.failNextWrites = 0
    await result.registry.moveToGroup(alpha.id, group.id)

    const unknownWorkspace = WorkspaceId('00000000-0000-4000-8000-0000000000f1')
    const unknownGroup = GroupId('00000000-0000-4000-8000-0000000000f2')
    await expect(result.registry.moveToGroup(unknownWorkspace, group.id))
      .rejects.toBeInstanceOf(WorkspaceOrderInvalidError)
    await expect(result.registry.moveToGroup(alpha.id, unknownGroup))
      .rejects.toBeInstanceOf(WorkspaceGroupUnknownError)
    await expect(result.registry.moveToGroup(alpha.id, group.id, unknownWorkspace))
      .rejects.toBeInstanceOf(WorkspaceOrderInvalidError)
    expect(group.workspaceIds).toEqual([alpha.id])
  })

  it('keeps both slots and the pending marker durable after a mid-transfer failure', async () => {
    const alphaDir = await makeDir('move-rollback')
    const pool = new MemoryMediaPool()
    // Write ledger on the fresh pool: boot global 1; create(alpha) globals 2-3,
    // put 1; createGroup globals 4-5, put 2; case-1 transfer marker global 6,
    // source global 7, target put 3, rollback global 8; recovery source global 9,
    // target put 4, clear global 10; createGroup globals 11-12, put 5;
    // case-2 marker global 13, source put 6, target put 7, rollback put 8,
    // clear global 14; case-3 marker global 15, source put 9, target put 10,
    // clear global 16, rollback puts 11-12, rollback global 17; restart
    // recovery puts 13-14 and clear global 18.
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { putAt: 7, globalAt: [7, 8, 16, 17] }),
    })
    const alpha = await result.registry.create(alphaDir)
    const group = await result.registry.createGroup('half-move')

    // The source slot write and the rollback write both fail: the marker stays
    // and no slot changed.
    await expect(result.registry.moveToGroup(alpha.id, group.id)).rejects.toThrow(/transfer and rollback both failed/)
    expect(storedState(result.pool).pendingMutation).toEqual({
      operation: 'group-move', workspaceId: alpha.id, source: '', target: group.id, from: [], to: [alpha.id],
    })
    expect(storedState(result.pool).workspaceIds).toEqual([alpha.id])
    expect(storedGroupRecord(result.pool, group.id).workspaceIds).toEqual([])
    expect(result.registry.list().map(workspace => workspace.id)).toEqual([alpha.id])

    // The next serialized registry operation retries the marker recovery
    // first: a no-op re-filing of the already filed workspace completes the
    // transfer forward, then the rename lands through the view.
    await result.registry.moveToGroup(alpha.id, group.id)
    await group.setTitle('recovered')
    expect(storedState(result.pool).pendingMutation).toBeUndefined()
    expect(storedState(result.pool).workspaceIds).toEqual([])
    expect(storedGroupRecord(result.pool, group.id).workspaceIds).toEqual([alpha.id])
    expect(group.workspaceIds).toEqual([alpha.id])
    expect(result.registry.list()).toEqual([])

    // The target slot write fails (marker, source-put, failing target-put): the
    // rollback restores the source and clears the marker, leaving the original
    // filing intact.
    const target = await result.registry.createGroup('second-target')
    await expect(result.registry.moveToGroup(alpha.id, target.id)).rejects.toThrow(/selected bootstrap put failure/)
    expect(storedState(result.pool).pendingMutation).toBeUndefined()
    expect(storedGroupRecord(result.pool, group.id).workspaceIds).toEqual([alpha.id])
    expect(storedGroupRecord(result.pool, target.id).workspaceIds).toEqual([])
    expect(group.workspaceIds).toEqual([alpha.id])
    expect(target.workspaceIds).toEqual([])

    // A failure on the marker clear, with the rollback clear failing too,
    // leaves the completed transfer and its marker behind; the rolled-back
    // slots keep their pre-transfer contents until a restart replays the
    // marker's recorded arrays forward.
    await expect(result.registry.moveToGroup(alpha.id, target.id)).rejects.toThrow(/transfer and rollback both failed/)
    expect(storedState(result.pool).pendingMutation).toMatchObject({
      operation: 'group-move',
      workspaceId: alpha.id,
      source: group.id,
      target: target.id,
      from: [],
      to: [alpha.id],
    })
    expect(storedGroupRecord(result.pool, group.id).workspaceIds).toEqual([alpha.id])
    expect(storedGroupRecord(result.pool, target.id).workspaceIds).toEqual([])
    await result.fiber.dispose()

    const reopened = await harness({ pool: result.pool })
    expect(storedState(result.pool).pendingMutation).toBeUndefined()
    expect(storedGroupRecord(result.pool, group.id).workspaceIds).toEqual([])
    expect(storedGroupRecord(result.pool, target.id).workspaceIds).toEqual([alpha.id])
    expect(reopened.registry.getGroup(target.id)!.workspaceIds).toEqual([alpha.id])
    expect(reopened.registry.getGroup(group.id)!.workspaceIds).toEqual([])
    expect(reopened.registry.list()).toEqual([])
  })

  it('resurfaces members at the top-level head in group order on deleteGroup', async () => {
    const alphaDir = await makeDir('dissolve-alpha')
    const betaDir = await makeDir('dissolve-beta')
    const gammaDir = await makeDir('dissolve-gamma')
    const result = await harness()
    const alpha = await result.registry.create(alphaDir)
    const beta = await result.registry.create(betaDir)
    const gamma = await result.registry.create(gammaDir)
    const group = await result.registry.createGroup('dissolved')
    await result.registry.moveToGroup(beta.id, group.id)
    await result.registry.moveToGroup(gamma.id, group.id)

    await result.registry.deleteGroup(group.id)
    expect(result.registry.listGroups()).toEqual([])
    expect(result.registry.getGroup(group.id)).toBeUndefined()
    expect(result.registry.list().map(workspace => workspace.id)).toEqual([beta.id, gamma.id, alpha.id])
    expect(storedState(result.pool).groupIds).toEqual([])
    expect(storedState(result.pool).workspaceIds).toEqual([beta.id, gamma.id, alpha.id])
    expect(result.pool.media.get('workspace')!.tables.get('groups')!.size).toBe(0)
    expect(result.registry.get(beta.id)).toBe(beta)
    expect(result.registry.get(gamma.id)).toBe(gamma)

    await expect(result.registry.deleteGroup(group.id)).rejects.toBeInstanceOf(WorkspaceGroupUnknownError)
  })

  it('deletes an empty group without touching the top-level order', async () => {
    const alphaDir = await makeDir('dissolve-empty')
    const result = await harness()
    const alpha = await result.registry.create(alphaDir)
    const group = await result.registry.createGroup('empty')

    await result.registry.deleteGroup(group.id)
    expect(result.registry.listGroups()).toEqual([])
    expect(result.registry.list()).toEqual([alpha])
    expect(storedState(result.pool).workspaceIds).toEqual([alpha.id])
    expect(result.pool.media.get('workspace')!.tables.get('groups')!.size).toBe(0)
  })

  it('restarts with the members resurfaced after an interrupted group deletion', async () => {
    const alphaDir = await makeDir('dissolve-crash-alpha')
    const betaDir = await makeDir('dissolve-crash-beta')
    const alphaId = WorkspaceId('00000000-0000-4000-8000-0000000000e2')
    const betaId = WorkspaceId('00000000-0000-4000-8000-0000000000e3')
    const groupId = GroupId('00000000-0000-4000-8000-0000000000e1')
    // Deletion commits the order write and the marker in one setState: the
    // resurfaced members and the dropped group id land together, so the
    // surviving marker always accompanies groupIds already without the id.
    const pool = storedPool(
      [[alphaId, record(alphaDir, [])], [betaId, record(betaDir, [])]],
      {
        initialized: true,
        workspaceIds: [alphaId, betaId],
        groupIds: [],
        pendingMutation: { operation: 'group-delete', groupId },
      },
      [[groupId, groupRecord('gone', [alphaId])]],
    )
    const result = await harness({ pool })
    expect(result.registry.listGroups()).toEqual([])
    expect(result.pool.media.get('workspace')!.tables.get('groups')!.size).toBe(0)
    expect(storedState(pool).pendingMutation).toBeUndefined()
    expect(storedState(pool).groupIds).toEqual([])
    // The resurfaced order was committed alongside the marker, so it stands.
    expect(storedState(pool).workspaceIds).toEqual([alphaId, betaId])
    expect(result.registry.list().map(workspace => workspace.id)).toEqual([alphaId, betaId])
    expect(result.registry.get(alphaId)).toBeDefined()
    expect(result.registry.get(betaId)).toBeDefined()
  })

  it('rejects a group-delete marker whose group order still contains the group', async () => {
    const alphaDir = await makeDir('dissolve-orphan')
    const groupId = GroupId('00000000-0000-4000-8000-0000000000e4')
    // A delete marker with the id still in the group order cannot be a real
    // crash window (deletion drops the id alongside the marker), so it fails
    // loud as unexplained divergence.
    const pool = storedPool(
      [[WorkspaceId('00000000-0000-4000-8000-0000000000e5'), record(alphaDir, [])]],
      {
        initialized: true,
        workspaceIds: [WorkspaceId('00000000-0000-4000-8000-0000000000e5')],
        groupIds: [groupId],
        pendingMutation: { operation: 'group-delete', groupId },
      },
      [[groupId, groupRecord('orphan', [])]],
    )
    await expect(harness({ pool })).rejects.toThrow(/still present in registry group order/)
  })

  it('completes an interrupted group move forward from every crash window', async () => {
    const alphaDir = await makeDir('recover-move-alpha')
    const betaDir = await makeDir('recover-move-beta')
    const alphaId = WorkspaceId('00000000-0000-4000-8000-0000000000d1')
    const betaId = WorkspaceId('00000000-0000-4000-8000-0000000000d2')
    const groupId = GroupId('00000000-0000-4000-8000-0000000000d3')

    // Crash before either slot write landed: the id still sits in the source.
    const beforeWrites = storedPool(
      [[alphaId, record(alphaDir, [])], [betaId, record(betaDir, [])]],
      {
        initialized: true,
        workspaceIds: [betaId, alphaId],
        groupIds: [groupId],
        pendingMutation: { operation: 'group-move', workspaceId: betaId, source: '', target: groupId, from: [alphaId], to: [betaId] },
      },
      [[groupId, groupRecord('dest', [])]],
    )
    const first = await harness({ pool: beforeWrites })
    expect(storedState(beforeWrites).pendingMutation).toBeUndefined()
    expect(storedState(beforeWrites).workspaceIds).toEqual([alphaId])
    expect(storedGroupRecord(beforeWrites, groupId).workspaceIds).toEqual([betaId])
    expect(first.registry.list().map(workspace => workspace.id)).toEqual([alphaId])
    expect(first.registry.getGroup(groupId)!.workspaceIds).toEqual([betaId])

    // Crash between the slot writes: the id sits in neither slot.
    const midWrites = storedPool(
      [[alphaId, record(alphaDir, [])], [betaId, record(betaDir, [])]],
      {
        initialized: true,
        workspaceIds: [alphaId],
        groupIds: [groupId],
        pendingMutation: { operation: 'group-move', workspaceId: betaId, source: '', target: groupId, from: [alphaId], to: [betaId] },
      },
      [[groupId, groupRecord('dest', [])]],
    )
    const second = await harness({ pool: midWrites })
    expect(storedState(midWrites).pendingMutation).toBeUndefined()
    expect(storedState(midWrites).workspaceIds).toEqual([alphaId])
    expect(storedGroupRecord(midWrites, groupId).workspaceIds).toEqual([betaId])
    expect(second.registry.getGroup(groupId)!.workspaceIds).toEqual([betaId])

    // Crash on the marker clear: both slot writes already landed.
    const afterWrites = storedPool(
      [[alphaId, record(alphaDir, [])], [betaId, record(betaDir, [])]],
      {
        initialized: true,
        workspaceIds: [alphaId],
        groupIds: [groupId],
        pendingMutation: { operation: 'group-move', workspaceId: betaId, source: '', target: groupId, from: [alphaId], to: [betaId] },
      },
      [[groupId, groupRecord('dest', [betaId])]],
    )
    const third = await harness({ pool: afterWrites })
    expect(storedState(afterWrites).pendingMutation).toBeUndefined()
    expect(storedState(afterWrites).workspaceIds).toEqual([alphaId])
    expect(storedGroupRecord(afterWrites, groupId).workspaceIds).toEqual([betaId])
    expect(third.registry.getGroup(groupId)!.workspaceIds).toEqual([betaId])

    // The id sitting in an unrelated slot is unexplained divergence.
    const otherId = GroupId('00000000-0000-4000-8000-0000000000d4')
    const diverged = storedPool(
      [[alphaId, record(alphaDir, [])], [betaId, record(betaDir, [])]],
      {
        initialized: true,
        workspaceIds: [alphaId],
        groupIds: [groupId, otherId],
        pendingMutation: { operation: 'group-move', workspaceId: betaId, source: '', target: groupId, from: [alphaId], to: [betaId] },
      },
      [[groupId, groupRecord('dest', [])], [otherId, groupRecord('other', [betaId])]],
    )
    await expect(harness({ pool: diverged })).rejects.toThrow(/outside its recorded transfer slots/)
  })

  it('finishes the group-membership scrub when recovering an interrupted workspace delete', async () => {
    const alphaDir = await makeDir('scrub-alpha')
    const betaDir = await makeDir('scrub-beta')
    const alphaId = WorkspaceId('00000000-0000-4000-8000-0000000000c1')
    const betaId = WorkspaceId('00000000-0000-4000-8000-0000000000c2')
    const firstGroup = GroupId('00000000-0000-4000-8000-0000000000c3')
    const secondGroup = GroupId('00000000-0000-4000-8000-0000000000c4')
    // An interrupted delete left the id filed in both groups; recovery scrubs every filing.
    const pool = storedPool(
      [[alphaId, record(alphaDir, [])], [betaId, record(betaDir, [])]],
      {
        initialized: true,
        workspaceIds: [],
        groupIds: [firstGroup, secondGroup],
        pendingMutation: { operation: 'delete', workspaceId: betaId },
      },
      [
        [firstGroup, groupRecord('one', [betaId, alphaId])],
        [secondGroup, groupRecord('two', [betaId])],
      ],
    )
    const result = await harness({ pool })
    expect(result.registry.list()).toEqual([])
    expect(result.pool.media.get('workspace')!.tables.get('workspaces')!.has(betaId)).toBe(false)
    expect(storedState(pool).pendingMutation).toBeUndefined()
    expect(storedGroupRecord(pool, firstGroup).workspaceIds).toEqual([alphaId])
    expect(storedGroupRecord(pool, secondGroup).workspaceIds).toEqual([])
    expect(result.registry.getGroup(firstGroup)!.workspaceIds).toEqual([alphaId])
    expect(result.registry.getGroup(secondGroup)!.workspaceIds).toEqual([])
  })

  it('unfiles a deleted workspace from its group', async () => {
    const alphaDir = await makeDir('delete-grouped-alpha')
    const betaDir = await makeDir('delete-grouped-beta')
    const result = await harness()
    const alpha = await result.registry.create(alphaDir)
    const beta = await result.registry.create(betaDir)
    const group = await result.registry.createGroup('holder')
    await result.registry.moveToGroup(beta.id, group.id)

    await result.registry.delete(beta.id)
    expect(result.registry.get(beta.id)).toBeUndefined()
    expect(group.workspaceIds).toEqual([])
    expect(storedGroupRecord(result.pool, group.id).workspaceIds).toEqual([])
    expect(result.pool.media.get('workspace')!.tables.get('workspaces')!.has(beta.id)).toBe(false)
    expect(result.registry.list()).toEqual([alpha])
  })

  it('recovers an interrupted group creation on restart', async () => {
    const groupId = GroupId('00000000-0000-4000-8000-0000000000b1')
    // Creation marks before the record write, so a surviving marker always
    // accompanies groupIds without the id: recovery drops the orphan record.
    const pool = storedPool(
      [],
      {
        initialized: true,
        workspaceIds: [],
        groupIds: [],
        pendingMutation: { operation: 'group-create', groupId },
      },
      [[groupId, groupRecord('half-made', [])]],
    )
    const result = await harness({ pool })
    expect(result.pool.media.get('workspace')!.tables.get('groups')!.size).toBe(0)
    expect(storedState(pool).pendingMutation).toBeUndefined()
    expect(storedState(pool).groupIds).toEqual([])
    expect(result.registry.listGroups()).toEqual([])
    expect(result.registry.getGroup(groupId)).toBeUndefined()
  })

  it('rolls back the record when the group-create order write fails', async () => {
    // Case 1: marker global 2, record put 1, order global 3 fails; record
    // rollback delete 1 lands, but marker rollback global 4 fails too, so the
    // committed marker keeps the orphan record recoverable.
    const lostPool = new MemoryMediaPool()
    const lost = await harness({
      pool: lostPool,
      backend: selectiveFailureBackend(lostPool, { globalAt: [3, 4] }),
    })
    await expect(lost.registry.createGroup('lost')).rejects.toThrow(/both failed/)
    expect(lost.registry.listGroups()).toEqual([])
    expect(lostPool.media.get('workspace')!.tables.get('groups')!.size).toBe(0)
    expect(storedState(lostPool).pendingMutation).toMatchObject({ operation: 'group-create' })
    expect(storedState(lostPool).groupIds).toEqual([])

    // The next serialized operation recovers by dropping the already dropped
    // orphan record and clearing the marker, then creates cleanly.
    const orphaned = await lost.registry.createGroup('orphaned')
    expect(lostPool.media.get('workspace')!.tables.get('groups')!.size).toBe(1)
    expect(storedGroupRecord(lostPool, orphaned.id).title).toBe('orphaned')
    expect(storedState(lostPool).pendingMutation).toBeUndefined()
    expect(storedState(lostPool).groupIds).toEqual([orphaned.id])
    expect(lost.registry.listGroups()).toEqual([orphaned])

    // Case 2: marker global 2, record put 1, order global 3 fails; record
    // rollback delete 1 fails too, so the marker and the orphan record both
    // stay for recovery.
    const stuckPool = new MemoryMediaPool()
    const stuck = await harness({
      pool: stuckPool,
      backend: selectiveFailureBackend(stuckPool, { globalAt: [3], deleteAt: 1 }),
    })
    await expect(stuck.registry.createGroup('stuck')).rejects.toThrow(/both failed/)
    expect(storedState(stuckPool).pendingMutation).toMatchObject({ operation: 'group-create' })
    expect(storedState(stuckPool).groupIds).toEqual([])
    expect(stuckPool.media.get('workspace')!.tables.get('groups')!.size).toBe(1)

    const recovered = await stuck.registry.createGroup('recovered')
    expect(stuckPool.media.get('workspace')!.tables.get('groups')!.size).toBe(1)
    expect(storedGroupRecord(stuckPool, recovered.id).title).toBe('recovered')
    expect(storedState(stuckPool).pendingMutation).toBeUndefined()
    expect(storedState(stuckPool).groupIds).toEqual([recovered.id])
    expect(stuck.registry.listGroups()).toEqual([recovered])
  })

  it('rejects createGroup when its marker cannot be written and publishes nothing', async () => {
    const pool = new MemoryMediaPool()
    // Boot writes global 1; createGroup's marker write global 2 fails before any
    // record write, so nothing about the group is durable.
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: [2] }),
    })

    await expect(result.registry.createGroup('marker-blocked')).rejects.toThrow(/selected bootstrap marker failure/)
    expect(result.registry.listGroups()).toEqual([])
    expect(storedState(pool).groupIds).toEqual([])
    expect(storedState(pool).pendingMutation).toBeUndefined()
    expect(storedGroupCount(pool)).toBe(0)
  })

  it('rolls createGroup back when its record write fails', async () => {
    const pool = new MemoryMediaPool()
    // createGroup marker = global 2; record put 1 fails; the marker rollback
    // global 3 lands and restores the pre-create state.
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { putAt: 1 }),
    })

    await expect(result.registry.createGroup('record-blocked')).rejects.toThrow(/selected bootstrap put failure/)
    expect(result.registry.listGroups()).toEqual([])
    expect(storedState(pool).groupIds).toEqual([])
    expect(storedState(pool).pendingMutation).toBeUndefined()
    expect(storedGroupCount(pool)).toBe(0)
  })

  it('keeps a createGroup record written when its marker rollback also fails', async () => {
    const pool = new MemoryMediaPool()
    // createGroup marker = global 2; record put 1 fails; the marker rollback
    // global 3 fails too, so the committed marker keeps the failed creation
    // recoverable and the un-rolled-back record survives for recovery to drop.
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { putAt: 1, globalAt: [3] }),
    })

    const failure = await result.registry.createGroup('rollback-blocked').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toMatch(/record write and pending-marker rollback both failed/)
    expect(result.registry.listGroups()).toEqual([])
    expect(storedState(pool).groupIds).toEqual([])
    const marker = storedState(pool).pendingMutation
    expect(marker).toMatchObject({ operation: 'group-create' })
    // The failed put never reached the medium, so the row was never written;
    // recovery only needs to clear the marker.
    expect(storedGroupCount(pool)).toBe(0)

    await result.fiber.dispose()
    const restarted = await harness({ pool })
    expect(restarted.registry.listGroups()).toEqual([])
    expect(storedState(pool).pendingMutation).toBeUndefined()
  })

  it('rolls createGroup back when its order write fails', async () => {
    const pool = new MemoryMediaPool()
    // createGroup marker = global 2; record put 1 lands; the order write
    // global 3 fails, so the record delete and marker rollback restore the
    // pre-create state.
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: [3] }),
    })

    await expect(result.registry.createGroup('order-blocked')).rejects.toThrow(/selected bootstrap marker failure/)
    expect(result.registry.listGroups()).toEqual([])
    expect(storedState(pool).groupIds).toEqual([])
    expect(storedState(pool).pendingMutation).toBeUndefined()
    expect(storedGroupCount(pool)).toBe(0)
  })

  it('rejects deleteGroup when its marker cannot be written and keeps the group published', async () => {
    const alphaDir = await makeDir('dissolve-marker-alpha')
    const pool = new MemoryMediaPool()
    // create = global 2, put 1, global 3; createGroup = global 4, put 2,
    // global 5; deleteGroup's marker write global 6 fails.
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: [6] }),
    })
    const alpha = await result.registry.create(alphaDir)
    const group = await result.registry.createGroup('marker-blocked')

    await expect(result.registry.deleteGroup(group.id)).rejects.toThrow(/selected bootstrap marker failure/)
    expect(result.registry.listGroups()).toEqual([group])
    expect(result.registry.getGroup(group.id)).toBe(group)
    expect(storedState(pool).groupIds).toEqual([group.id])
    expect(storedState(pool).pendingMutation).toBeUndefined()
    expect(storedState(pool).workspaceIds).toEqual([alpha.id])
    expect(pool.media.get('workspace')!.tables.get('groups')!.size).toBe(1)
  })

  it('keeps a group deleted when its record deletion and order rollback both fail', async () => {
    const pool = new MemoryMediaPool()
    // createGroup = global 2, put 1, global 3; deleteGroup marker = global 4;
    // record delete 1 fails; the order rollback global 5 fails too, so the
    // committed marker keeps the deletion recoverable and the cache must
    // agree with that durable direction.
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { deleteAt: 1, globalAt: [5] }),
    })
    const group = await result.registry.createGroup('double-failure')

    const failure = await result.registry.deleteGroup(group.id).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toMatch(/record deletion and registry-order rollback both failed/)
    expect(result.registry.getGroup(group.id)).toBeUndefined()
    expect(result.registry.listGroups()).toEqual([])
    expect(storedState(pool).groupIds).toEqual([])
    expect(storedState(pool).pendingMutation).toMatchObject({ operation: 'group-delete', groupId: group.id })
    // The record delete failed, so the row survives for recovery to finish.
    expect(storedGroupRecord(pool, group.id).title).toBe('double-failure')

    await result.fiber.dispose()
    const restarted = await harness({ pool })
    expect(restarted.registry.listGroups()).toEqual([])
    expect(pool.media.get('workspace')!.tables.get('groups')!.size).toBe(0)
    expect(storedState(pool).pendingMutation).toBeUndefined()
  })

  it('rolls deleteGroup back when its record deletion fails', async () => {
    const alphaDir = await makeDir('dissolve-rollback-alpha')
    const pool = new MemoryMediaPool()
    // create = global 2, put 1, global 3; createGroup = global 4, put 2,
    // global 5; deleteGroup marker = global 6; record delete 1 fails, so the
    // order rollback global 7 lands and restores the pre-delete state.
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { deleteAt: 1 }),
    })
    const alpha = await result.registry.create(alphaDir)
    const group = await result.registry.createGroup('rollback-kept')

    await expect(result.registry.deleteGroup(group.id)).rejects.toThrow(/selected rollback delete failure/)
    // The rollback republishes the group: a fresh view over the restored
    // durable record, in the restored group order.
    expect(result.registry.getGroup(group.id)).toMatchObject({ id: group.id, title: 'rollback-kept' })
    expect(result.registry.listGroups().map(view => view.id)).toEqual([group.id])
    expect(storedState(pool).groupIds).toEqual([group.id])
    expect(storedState(pool).workspaceIds).toEqual([alpha.id])
    // The rollback restored the pre-delete state, so no marker survives.
    expect(storedState(pool).pendingMutation).toBeUndefined()
    expect(storedGroupRecord(pool, group.id).title).toBe('rollback-kept')
  })

  it('deletes a group and warns when its marker cannot be cleared', async () => {
    const alphaDir = await makeDir('dissolve-warn-alpha')
    const pool = new MemoryMediaPool()
    // create = global 2, put 1, global 3; createGroup = global 4, put 2,
    // global 5; deleteGroup marker = global 6; record delete 1 lands; the
    // marker clear global 7 fails, so the deletion commits and warns.
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: [7] }),
    })
    const alpha = await result.registry.create(alphaDir)
    const group = await result.registry.createGroup('clear-blocked')

    await expect(result.registry.deleteGroup(group.id)).resolves.toBeUndefined()
    expect(result.registry.listGroups()).toEqual([])
    expect(result.registry.getGroup(group.id)).toBeUndefined()
    expect(pool.media.get('workspace')!.tables.get('groups')!.size).toBe(0)
    expect(storedState(pool).groupIds).toEqual([])
    expect(storedState(pool).workspaceIds).toEqual([alpha.id])
    // The clear failed, so the committed deletion's marker survives for recovery.
    expect(storedState(pool).pendingMutation).toMatchObject({ operation: 'group-delete', groupId: group.id })

    await result.fiber.dispose()
    const restarted = await harness({ pool })
    expect(restarted.registry.listGroups()).toEqual([])
    expect(storedState(pool).pendingMutation).toBeUndefined()
  })

  it('fails loud on group-order and membership divergence at startup', async () => {
    const alphaDir = await makeDir('validate-alpha')
    const betaDir = await makeDir('validate-beta')
    const alphaId = WorkspaceId('00000000-0000-4000-8000-0000000000a1')
    const betaId = WorkspaceId('00000000-0000-4000-8000-0000000000a2')
    const firstGroup = GroupId('00000000-0000-4000-8000-0000000000a3')
    const secondGroup = GroupId('00000000-0000-4000-8000-0000000000a4')

    const repeatedGroup = storedPool(
      [[alphaId, record(alphaDir, [])]],
      { initialized: true, workspaceIds: [alphaId], groupIds: [firstGroup, firstGroup] },
      [[firstGroup, groupRecord('one', [])]],
    )
    await expect(harness({ pool: repeatedGroup })).rejects.toThrow(/registry group order repeats group/)

    const missingGroup = storedPool(
      [[alphaId, record(alphaDir, [])]],
      { initialized: true, workspaceIds: [alphaId], groupIds: [firstGroup] },
    )
    await expect(harness({ pool: missingGroup })).rejects.toThrow(/references missing group/)

    const orphanGroup = storedPool(
      [[alphaId, record(alphaDir, [])]],
      { initialized: true, workspaceIds: [alphaId], groupIds: [] },
      [[firstGroup, groupRecord('one', [])]],
    )
    await expect(harness({ pool: orphanGroup })).rejects.toThrow(/absent from registry group order/)

    const memberGhost = storedPool(
      [[alphaId, record(alphaDir, [])]],
      { initialized: true, workspaceIds: [alphaId], groupIds: [firstGroup] },
      [[firstGroup, groupRecord('one', [betaId])]],
    )
    await expect(harness({ pool: memberGhost })).rejects.toThrow(/references missing workspace/)

    const doubleFiled = storedPool(
      [[alphaId, record(alphaDir, [])], [betaId, record(betaDir, [])]],
      { initialized: true, workspaceIds: [], groupIds: [firstGroup, secondGroup] },
      [[firstGroup, groupRecord('one', [betaId])], [secondGroup, groupRecord('two', [betaId, alphaId])]],
    )
    await expect(harness({ pool: doubleFiled })).rejects.toThrow(/filed by two groups/)

    const topAndFiled = storedPool(
      [[alphaId, record(alphaDir, [])]],
      { initialized: true, workspaceIds: [alphaId], groupIds: [firstGroup] },
      [[firstGroup, groupRecord('one', [alphaId])]],
    )
    await expect(harness({ pool: topAndFiled })).rejects.toThrow(/sits in both registry order and group/)

    const orphanWorkspace = storedPool(
      [[alphaId, record(alphaDir, [])], [betaId, record(betaDir, [])]],
      { initialized: true, workspaceIds: [alphaId], groupIds: [firstGroup] },
      [[firstGroup, groupRecord('one', [])]],
    )
    await expect(harness({ pool: orphanWorkspace })).rejects.toThrow(/absent from registry order/)

    // A repeated group member folds into a regular double-filing rejection.
    const repeatedMember = storedPool(
      [[alphaId, record(alphaDir, [])]],
      { initialized: true, workspaceIds: [], groupIds: [firstGroup] },
      [[firstGroup, groupRecord('one', [alphaId, alphaId])]],
    )
    await expect(harness({ pool: repeatedMember })).rejects.toThrow(/filed by two groups/)
  })

  it('keeps cached group views fresh when the registry refiles their members', async () => {
    const alphaDir = await makeDir('adopt-alpha')
    const betaDir = await makeDir('adopt-beta')
    const result = await harness()
    const alpha = await result.registry.create(alphaDir)
    const beta = await result.registry.create(betaDir)
    const group = await result.registry.createGroup('watched')
    const listed = result.registry.listGroups()[0]!

    await result.registry.moveToGroup(alpha.id, group.id)
    await result.registry.moveToGroup(beta.id, group.id)
    expect(group.workspaceIds).toEqual([alpha.id, beta.id])
    expect(listed.workspaceIds).toEqual([alpha.id, beta.id])

    await result.registry.moveToGroup(alpha.id)
    expect(group.workspaceIds).toEqual([beta.id])
    expect(listed.workspaceIds).toEqual([beta.id])
  })
})
