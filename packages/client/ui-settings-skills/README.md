---
description: "Skills Settings page for the dsh web client: every loaded skill with an enable switch, plus an Add skill action for a local skill directory."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-skills

English | [中文](README.zh.md)

## Summary

The **Skills** Settings page shows every skill the Host loaded and lets the user turn each one off or on. A disabled skill stays in the list but disappears from the model's skill catalog, from the `skill` tool, and from the `/` menu in every session. **Add skill** registers a local directory that contains `SKILL.md`, so a user can bring in a skill without editing configuration files. The enable state and the added directories live in the Host user settings, so they survive a restart and apply to every client of the same Host.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open Settings and select **Skills**. Mount `@deepseek-ai/dsh-client-ui-settings-skills` in a Web composition that already provides the settings shell, the settings scope service, and the `skills` Remote from `@deepseek-ai/dsh-api-session-controller`; the page registers its own navigation entry and needs no configuration.

### Reading the list

Each row shows the skill name, its description, and the discovery source (`user-dsh`, `project-dsh`, `custom`, `bundled`, and so on). The page reads the inventory when it opens, not at startup, so a session that never opens Settings makes no skills request. The list covers the skills visible without a workspace: user, added, custom, and bundled roots. It omits project skills, which depend on a workspace directory.

### Enabling and disabling

The switch on each row writes the skill name into the `disabled` list of the `skills` settings namespace as one revision-fenced write. The row follows the live settings value, so the switch flips without waiting for another inventory read. When the connection cannot write settings (a remote browser in memory mode), every switch and Add skill are disabled and the page says so.

### Adding a skill

Add skill opens a path field. Enter the absolute path of a directory that contains `SKILL.md` and confirm. The Host checks that the path is absolute, that `SKILL.md` exists, that the file parses as a skill with a name and a description, and that the directory is not already added. A refusal appears under the toolbar and keeps the form open. On success the form closes and the new skill appears enabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page is one localized `settings.section` contribution with id `skills`, ordered after Agent presets and before Archived sessions. The Settings shell owns the navigation entry, the modal, and the mounted section.

### State and data sources

`SkillsController` owns one snapshot store. It joins two sources: the `skills.inventory` Remote result (every skill including disabled ones, read on demand) and the bound `skills` settings scope (the `disabled` list and writability). The `enabled` flag of a row is recomputed from the scope on every scope change, so toggling never depends on a second Remote read. `reload()` re-reads the inventory after `connection/reset`, and only when the page has read it before. A read superseded by a newer one is aborted and its result dropped.

### Host counterpart

The `skills` Remote namespace lives in `@deepseek-ai/dsh-api-session-controller` (`SessionSkillCatalog`). It registers the `skills` settings namespace (`disabled`, `dirs`), a `user-added` filesystem provider fed by `dirs`, and the registry hidden-name source that applies `disabled` to every consumer. The client spells the namespace name locally because a client package must not depend on a Host package.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host loader entry: the page is browser-only, so the plugin body is empty |
| [`src/client/index.ts`](src/client/index.ts) | Browser plugin: locale namespace, controller, section registration |
| [`src/client/controller.ts`](src/client/controller.ts) | Inventory and settings join, toggle write, Add skill request |
| [`src/client/SkillsSection.tsx`](src/client/SkillsSection.tsx) | The page component: list, switches, Add skill form |
| [`src/client/locales.ts`](src/client/locales.ts) | Chinese and English dictionaries for every visible and accessible string |
| [`src/client/SkillsSection.module.css`](src/client/SkillsSection.module.css) | Page styles |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.section` and the namespace scope service.
- [ui-settings-general](../ui-settings-general/README.md) — the Settings shell that renders the navigation and mounts the section.
- [ui-skill](../ui-skill/README.md) — the `/` menu and skill call card that honor the disabled list.
- [Session Controller](../../api/session-controller/README.md) — the `skills` Remote methods behind this page.
- [Skills subsystem](../../../docs/subsystems/skills.md) — the registry, providers, and the hidden-name filter.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing. The setting it writes changes which skills the model catalog lists; that effect is owned and documented by [dsh-tool-skill](../../skill/tool-skill/README.md).

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the page can manage; they are current package constraints.

- **Project skills are not listed** — the inventory is read without a workspace directory, so skills discovered under a project's `.dsh/skills` or `.agents/skills` do not appear here, though a name listed here as disabled also hides a project skill of the same name.
- **Added directories cannot be removed from the page** — Add skill appends to the `dirs` list of the `skills` settings namespace; removing an entry means editing the settings document.
- **Adding needs a path on the Host machine** — the path is read by the Host, not uploaded from the browser.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A browser-side settings page that registers one localized `settings.section` contribution and its locale namespace; it emits no Cordis events and owns no cross-plugin mutable relation.
