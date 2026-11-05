# Agent Note: Permanent Session delete from the archived-sessions page

Status: implemented

English | [中文](2026-10-27-permanent-session-delete.zh.md)

## Problem

The archived-sessions Settings page could restore a Session but never remove one. No layer could delete a Session: `SessionPersistence` was create, open, flush, stat, and list only, and the Workspace registry could only add or drop an id from the archive set. Users with many archived Sessions had no way to discard the ones they would never restore.

## Decision

`SessionPersistence.delete(id)` is a new abstract method that erases the whole Session, every format generation included. It rejects with `SessionAlreadyOwnedError` while any write handle holds the id and with `SessionPersistenceNotFoundError` for an unknown id. The JSONL backend claims the in-process write claim, takes the cross-process lease, clears its cold-log memo and any migration preparation, renames the session directory to a `~trash-<token>` sibling, syncs the project directory, and removes the renamed directory. Encoded session ids escape `~` as `~` plus four uppercase hex digits, so no id can name a trash directory. A crash after the rename leaves only a trash directory, which listing ignores and the next startup sweeps; the rename is what prevents a crash from leaving an older generation standing as the Session's current log.

The migration rule that a committed generation is never moved, overwritten, or deleted governs format migration. `SessionPersistence.delete` is the one sanctioned remover and always removes the whole Session, never a single generation.

`WorkspaceRegistry.deleteSession(id)` runs on the registry operation chain: it deletes from persistence first, then detaches the id from every Workspace, drops the header and path caches, and removes the id from the archive set. A persistence miss still scrubs the registry. A failure before the scrub leaves the Session and its registry entries intact; a failure during the scrub leaves orphan ids that membership filtering already ignores.

`session.deleteSession` is a new Remote on the Session Controller, not on the Workspace Controller, because the Client must also drop the Session summary and the Session Controller already depends on the Workspace registry. It refuses a Session that is live in this Host with `session/active`, maps a persistence ownership conflict to the same code, calls the registry, forgets the `SessionProjectionCache` record on a best-effort basis, and emits the existing `api-session/removed` event so every connected Client drops the row. The Client manager also removes the row locally once the Host acknowledges, including for a durable subagent. The archive-set change reaches Clients through the existing `archived` follow increment.

`UiWorkspace.deleteSession` forwards to `ISessions.deleteSession`. The archived-sessions page adds a Remove button after Unarchive that opens a `Modal` confirmation with Cancel focused first; the dialog stays open and disabled while the call is pending and shows the failure text when the call rejects.

## Alternatives considered

**Hide the Session instead of deleting it.** A registry-only marker would keep the log on disk, so the action would not do what its label says.

**Delete the generation files in order, oldest first.** A crash partway through would leave the Session half deleted and readable; renaming the directory first makes the removal atomic from the listing's point of view.

**Dispose a running Agent and then delete.** Stopping an in-flight turn needs a cancel-and-drain protocol that no controller owns today. The first version refuses an active Session instead.

**Cascade to forked children.** A fork copies its inherited prefix into its own log, so a child never reads its parent. A child keeps a `parentSession` id that no longer resolves, which the Client list already tolerates.

## Consequences

Deletion is permanent and has no undo. The abstract `delete` method is a public API change that every `SessionPersistence` backend and test double implements. The projection-cache record of a deleted Session can outlive it if cache cleanup fails; the record is identity-guarded, so it is never served for a recreated id.

## Testing

`packages/session/session-persistence/tests/contract.ts` pins deletion, the ownership refusal, the not-found rejection, and id reuse for every backend. `packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` pins removal of every generation and the sweep of a leftover trash directory. `packages/workspace/workspace/tests/workspace.spec.ts` pins the registry scrub order and its failure cases. `packages/api/session-controller/tests/session-delete.host.spec.ts` pins the live refusal, error mapping, and removal notification, and `tests/sessions-service.client.spec.ts` pins the Client list update.

## Related
