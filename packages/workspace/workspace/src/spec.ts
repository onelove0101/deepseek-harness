/**
 * The workspace domain declaration: record schema and the `defineDomain` spec
 * the registry opens. The zod schema validates the shipped format at the
 * durability boundary and is the direct source of a future RPC wire projection.
 * @module @deepseek-ai/dsh-workspace/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { FolderId, GroupId, WorkspaceId } from './types.ts'

/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)

const sessionId = z.string().transform(value => brandString<SessionId>(value))

/** Group id schema at the durable boundary; branding has no runtime representation. */
const groupId = z.string().transform(value => value as GroupId)

/** Folder id schema at the durable boundary; branding has no runtime representation. */
const folderId = z.string().transform(value => value as FolderId)

/**
 * Durable logical Session folder. Its session ids remain members of the
 * enclosing Workspace's account; this record only files their presentation.
 */
export const workspaceFolderRecord = z.object({
  id: folderId,
  title: z.string(),
  sessionIds: z.array(sessionId),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored Workspace-local logical Session folder. */
export type WorkspaceFolderRecord = z.infer<typeof workspaceFolderRecord>

/**
 * Durable shape of one workspace record. `path` is the `fs.realpath` canon
 * stamped at create; `sessionIds` is the ordered ownership account (array
 * order is display order); timestamps are ISO-8601 strings. Group filing
 * lives on the group record, never here. Folders are a single-level display
 * partition over that session account. The current format requires it; Zod supplies
 * an empty value for records that omit the field within the same domain version.
 */
export const workspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionId),
  folders: z.array(workspaceFolderRecord).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored workspace record, inferred from {@link workspaceRecord}. */
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

/**
 * Durable shape of one workspace group record: a display folder that files
 * workspaces without touching their session accounting. `workspaceIds` is the
 * group's authoritative membership and display order — the workspace record
 * stays group-free, so filing is one table write with no two-write marker.
 */
export const workspaceGroupRecord = z.object({
  title: z.string(),
  workspaceIds: z.array(workspaceId),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored workspace group record, inferred from {@link workspaceGroupRecord}. */
export type WorkspaceGroupRecord = z.infer<typeof workspaceGroupRecord>

/** A filing slot: a group id, or the empty string for the top-level order. */
const filingSlot = z.string().transform(value => value as GroupId | '')

/**
 * Recoverable multi-write mutation marker. The marker is persisted before the
 * records/order pair can diverge, so startup can distinguish an interrupted
 * registry operation from unexplained medium corruption. Create/delete
 * markers recover by dropping the named row (the id must already be absent
 * from its order array); a `delete` recovery also scrubs the id from every
 * group record still filing it. `group-create` and `group-delete` recover the
 * same way: creation marks before the record write and deletion marks
 * alongside the committed order write, so both markers only ever survive with
 * the id absent from the group order. `group-move` marks an
 * interrupted filing transfer: `source`/`target` are filing slots; `from`/`to`
 * are the source and target member arrays as they must look after the
 * transfer, and recovery completes it.
 */
const workspacePendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId }),
  z.object({ operation: z.literal('delete'), workspaceId }),
  z.object({ operation: z.literal('group-create'), groupId }),
  z.object({ operation: z.literal('group-delete'), groupId }),
  z.object({
    operation: z.literal('group-move'),
    workspaceId,
    source: filingSlot,
    target: filingSlot,
    from: z.array(workspaceId),
    to: z.array(workspaceId),
  }),
])

/** Recoverable multi-write marker variants, inferred from the schema above. */
export type WorkspacePendingMutation = z.infer<typeof workspacePendingMutation>

/**
 * Durable registry state. `initialized` distinguishes a valid empty registry
 * from one that still needs the header-only history bootstrap;
 * `workspaceIds` is the authoritative display order of top-level (ungrouped)
 * workspaces. `archivedSessionIds` is the registry-global archive set layered
 * over workspace accounting: an archived session keeps its `sessionIds` slot
 * (unarchiving must restore the position), so the set never participates in
 * the one-owner accounting invariant. `pinnedSessionIds` is the registry-global
 * pin set in pin order (most recently pinned first); pinning and archival are
 * mutually exclusive, so archiving drops the session's pin. `groupIds` is the
 * authoritative group display order. These arrays are defaulted so records
 * written before the fields parse unchanged.
 */
export const workspaceDomainState = z.object({
  initialized: z.boolean(),
  /** First-use Workspace identity, retained after its registration is deleted. */
  defaultWorkspaceId: workspaceId.optional(),
  workspaceIds: z.array(workspaceId),
  archivedSessionIds: z.array(sessionId).default([]),
  pinnedSessionIds: z.array(sessionId).default([]),
  groupIds: z.array(groupId).default([]),
  pendingMutation: workspacePendingMutation.optional(),
})

/** Durable registry state inferred from {@link workspaceDomainState}. */
export type WorkspaceDomainState = z.infer<typeof workspaceDomainState>

/**
 * The workspace domain spec: a `workspaces` table keyed by
 * {@link WorkspaceId}, a `groups` table keyed by {@link GroupId}, plus the
 * bootstrap/order singleton. The registry opens this through
 * `ctx.storage.domain`; the spec object is the single source of the domain's
 * identity, version, and schemas.
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: {
    schema: workspaceDomainState,
    initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], groupIds: [] },
  },
  tables: {
    workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord),
    groups: domainTable<GroupId, WorkspaceGroupRecord>(workspaceGroupRecord),
  },
})
