# Agent Note: Skills Settings page

Status: implemented

English | [中文](2026-10-28-skills-settings-page.zh.md)

## Problem

Skills reached the model and the `/` menu only through discovery roots, and the only user control was editing files or composition config. A user could not see which skills the Host had loaded, turn one off, or bring in a skill directory from the browser. The registry had no user-level disable flag, `skills/list` was Session-addressed and listed user-invocable skills only, and `FileSystemSkillProvider` read `customSkillDirs` once at construction.

## Decision

A **Skills** Settings page, `@deepseek-ai/dsh-client-ui-settings-skills`, registers `settings.section` id `skills` at nav order 22, between Agent presets (20) and Archived sessions (25). It lists every loaded skill with an enable switch and offers Add skill, which takes the absolute path of a directory that contains `SKILL.md`.

State lives in the user settings namespace `skills` with `disabled: string[]` and `dirs: string[]`, global to the Host. `SessionSkillCatalog` registers the namespace when both `skills` and `settings` exist, so no new Host package is needed: it already owns the `skills` Remote namespace and depends on the registry.

`SkillRegistry.setHiddenNames(source)` is the single filter. `snapshot()`, `list()`, and `get()` drop hidden names after `collect()` and before returning, outside the collect cache, so a toggle needs no cache rebuild and the model catalog, the `skill` tool, `/name`, and the `/` menu agree. Filtering after the merge hides the name entirely; a lower-ranked same-name skill does not resurface. `includeHidden` lets the inventory list disabled skills. The registry stays settings-agnostic: the source is injected, and the owner calls `notifyHiddenChanged()` to emit `skills/change`.

Two new Remotes extend the existing `skills` namespace: `inventory` (no Session address; lists skills visible without a workspace, with `enabled`) and `add`. `add` requires an absolute path, resolves `SKILL.md` with `realpath` because providers report resolved paths, appends the directory to `dirs`, invalidates the provider explicitly because the scope watcher runs asynchronously, and rolls the write back when no skill with that file appears.

Added directories are served by a `user-added` `FileSystemSkillProvider` created with a new `singleSkillDirs` option: a function read on every lookup, each directory being one skill at the `custom` rank, with `control.invalidate()` called when the list changes.

The page reads the inventory when it mounts (`load`), not at plugin apply, because the cold-boot Remote count is pinned by the startup budget; a `connection/reset` re-reads only after a first load. The switch writes the whole `disabled` array through the bound settings scope, and each row's `enabled` is recomputed from the live scope value.

## Alternatives considered

**A new Host package `skill-settings`.** It would isolate the settings wiring, but needs package metadata, documentation, generated catalogs, and a roster entry for about forty lines that depend on the Remote's own service; `SessionSkillCatalog` already sits at that seam.

**Filtering at each consumer.** Three call sites in `tool-skill` and one in the Remote would each need the same filter, and a new consumer could forget it. One registry filter cannot be bypassed.

**Filtering inside `collectFresh`.** A hidden skill would be cached as absent and every toggle would rebuild catalogs; filtering after the cache keeps the cache invariant to user preference.

**Reading the inventory at startup.** It adds a Remote request to every cold boot for a page most sessions never open.

**Treating an added path as a parent of skills.** That mirrors `customSkillDirs`, but the request was to add one skill; a directory holding `SKILL.md` would have yielded no skill under the parent-scan rule.

## Consequences

Disabling is by name and global: a disabled name also hides a project skill with the same name, and the inventory omits project skills because it is read without a workspace. Added directories can be appended from the page but removed only by editing the settings document. The path is read on the Host, so a remote browser adds Host paths, not local files. Without a settings provider, disabling and adding are unavailable (`add` fails; the page shows read-only).

## Testing

`packages/skill/skill/tests/skill.spec.ts` pins hidden names across `snapshot`, `list`, `get`, `includeHidden`, the change event, and the disposer owning only its own source. `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` pins single-skill directories and rescanning after invalidation. `packages/api/session-controller/tests/session-skill-inventory.host.spec.ts` runs the Remote against a real registry and file settings provider: add, enable state, disabling, refusals, rollback, and provider loss. The client package tests pin the controller join, toggle writes, load-on-mount, and registration; `packages/client/ui-settings-general/tests` and `apps/web/tests/expected/settings-chrome/dialog-en.expected.md` pin the navigation entry.

## Related
