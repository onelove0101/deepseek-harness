# Agent Note: Workspace Groups and Session Folders

Status: implemented

English | [中文](2026-11-01-workspace-groups-and-session-folders.zh.md)

## Problem

The Workspace registry already retained groups, but the controller reconnect baseline listed only top-level Workspaces and the browser had no durable group layout. A Workspace moved into a group consequently disappeared from the browser after a stream reconnect or reload.

The sidebar also had no durable presentation structure beneath a Workspace. Users could neither group related Workspaces through an explicit browser action nor file Workspace-owned Sessions without changing their working directories or persistence.

## Decision

`ctx.workspaceRegistry` exposes durable Workspace Groups and Workspace-local logical Session Folders. A Group owns ordered Workspace ids. Registry `workspaceIds` holds the top-level Workspace order, and each Workspace is in that order or in exactly one Group. Moving a Workspace changes only this layout; dissolving a Group returns its Workspaces to the top level without changing directories, files, Sessions, or Session histories.

A Workspace record embeds ordered Folder records. A Folder contains only Session ids already accounted by its enclosing Workspace; a Session may occur in at most one Folder. A Session absent from every Folder remains at the Workspace root. Filing changes neither Workspace ownership, Session cwd, Session log, nor filesystem state. Deleting a Folder returns its Sessions to the Workspace root instead of deleting Session data.

The controller publishes an authoritative layout containing every Workspace, the top-level Workspace order, ordered Groups, and Folder membership. Structural Group and root-layout mutations replace that layout; Folder-only mutations update the affected Workspace. The browser uses this layout for a Group → Workspace → Folder hierarchy and provides localized, keyboard-accessible menus and dialogs for Group and Folder operations. Existing drag ordering retains its established local/root behavior and does not become durable cross-Group or cross-Folder movement.

## Durability and recovery

Group transfers continue to use the registry pending-mutation record because their state spans the global registry record and Group records. Restart recovery completes a named interrupted transfer. Folder changes update one Workspace record, and normal Workspace-record writes preserve exclusive, owned Folder membership. Legacy version-two Workspace records with no `folders` field read as an empty Folder list; the storage-domain version remains two because record defaults do not migrate a separately versioned storage medium.

## Alternatives considered

**Keep the existing flat controller baseline.** Rejected because `list()` intentionally returns only top-level Workspaces, making grouped Workspaces invisible and preventing clients from reconstructing Group membership after reconnect.

**Represent folders as filesystem directories.** Rejected because filing is presentation organization, not source-tree management. Creating, moving, or deleting directories would change a Session's execution context and introduce destructive filesystem semantics the Workspace record does not own.

**Make drag and drop persist Group or Folder movement.** Rejected because existing drag behavior has narrower ordering semantics. Explicit menu actions make layout changes discoverable and accessible without silently changing established drag behavior.

**Bump the Workspace storage-domain version for folders.** Rejected because the storage layer verifies the domain version before record parsing. Keeping version two with an empty-array record default reads existing raw records safely without claiming a media migration.

## Verification

Workspace tests cover Folder creation, rename, filing, return to root, exclusive membership, deletion, invalid ownership and Folder references, timestamps, permanent Session deletion cleanup, corruption rejection, and legacy raw version-two records. Controller and client tests cover authoritative Group layouts, reconnect state, Group and Folder commands, and stream/unary convergence. Component tests cover localized Group and Folder actions, confirmation flows, and hierarchy rendering. A real-composition test on `SlotTestRuntime` covers Group creation through the assembled browser: the view-options dialog fires the injected `createGroup` controller hop and the Group row renders from the authoritative layout.

## Consequences

A Group or Folder is durable user organization, but neither is a filesystem object. The hierarchy gains state and explicit operations in exchange for leaving physical directory layout, Session execution context, and prior drag semantics untouched. Grouped Workspaces now remain visible across browser reload and reconnect.
