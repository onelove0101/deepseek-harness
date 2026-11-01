---
description: "Experts Settings page and the leading @ mention source for the dsh web client: roster, edit form, and private document library."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-expert

English | [中文](README.zh.md)

## Summary

The **Experts** Settings page lists the Host user's Experts and edits them: name, enabled switch, Soul, selected skills, documents, and knowledge bases. A library panel under the roster stores pasted text documents and groups them into knowledge bases. The package also registers the leading `@` menu source, so typing `@` at the start of a prompt offers enabled Experts and a pick lands the literal `@name `. The Host injects the Expert when the prompt is sent. Everything persists on the Host through the `experts` Remote from [`dsh-expert`](../../preset/expert/README.md).

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

Mount `@deepseek-ai/dsh-client-ui-expert` in a Web composition that provides the settings shell, the input-trigger service, and the `experts` and `skills` Remotes; the page registers its own navigation entry and needs no configuration.

### Managing Experts

Open Settings and select **Experts**. **New Expert** opens the form; **Edit** reopens it for an existing Expert. The name field takes lowercase letters, digits, and hyphens. The switch on each row enables or disables the Expert without opening the form. A disabled Expert stays listed and is not offered by the `@` menu. Host refusals, such as a taken name or an exceeded limit, appear above the roster and keep the form open.

### The library

Under the roster, **Add document** stores a title and pasted text; the Host stores text only and accepts no file path or URL. Each document row shows its size, and the panel shows library usage against the Host bound. A knowledge base is a name plus checked documents. Deleting a document or knowledge base removes it from every Expert that selects it.

### The `@` menu

The source is leading-only: it offers Experts when the `@` token starts the prompt and nothing at an inline position. Candidates are the enabled Experts the Host ranks by successful use (`experts.ranked`, read afresh on each open), filtered by the typed query without changing that usage order, and with the first line of the Soul as the description.

The composer's `+` menu also carries an **Expert** row in its Add section. Hovering it, or pressing Enter, Tab, or a click on it, opens a flyout of the enabled Experts the Host ranks by successful use (`experts.ranked`, read afresh on each open). A pick inserts `@name ` at the start of the draft, replacing an existing leading mention of a listed Expert, and never sends. A typed `/expert` opens the `@` menu by inserting `@`. The row is hidden in addressed subagent sessions.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page is one localized `settings.section` contribution with id `experts` and order 23, between Skills and Archived sessions.

### State and data sources

`ExpertsController` owns one snapshot store holding the latest library and the skill names. The page reads the library and the skill inventory together when it opens; an inventory failure leaves the skill list empty without failing the library. Every mutation returns the whole library, which replaces the store value. `reload()` re-reads after `connection/reset`, and only when a read happened before. A read superseded by a newer one is aborted and dropped.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host loader entry: the package is browser-only, so the plugin body is empty |
| [`src/client/index.ts`](src/client/index.ts) | Browser plugin: locale namespace, controller, section registration, `@` source |
| [`src/client/controller.ts`](src/client/controller.ts) | Library and inventory reads, mutations, enabled-Expert lookup |
| [`src/client/ExpertsSection.tsx`](src/client/ExpertsSection.tsx) | The page: roster, switches, edit and delete actions |
| [`src/client/ExpertForm.tsx`](src/client/ExpertForm.tsx) | Create and edit form |
| [`src/client/LibraryPanel.tsx`](src/client/LibraryPanel.tsx) | Documents and knowledge bases |
| [`src/client/locales.ts`](src/client/locales.ts) | Chinese and English dictionaries |
| [`src/client/ExpertsSection.module.css`](src/client/ExpertsSection.module.css) | Page styles |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-expert](../../preset/expert/README.md) — the Host service, storage, limits, and invocation message.
- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.section`.
- [ui-settings-skills](../ui-settings-skills/README.md) — the neighbouring Skills page this package follows.
- [ui-skill](../ui-skill/README.md) — the `/` menu source the `@` source mirrors.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing. The `@name ` text a pick inserts is ordinary prompt text; the Host-side Expert injection is owned and documented by [dsh-expert](../../preset/expert/README.md).

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the page can do; they are current package constraints.

- **Host-ranked menus** — the plus menu's Expert flyout and the `@` menu read the Host's usage ranking on every open; typing after `@` filters without changing that order.
- **Documents are pasted text** — the page has no file picker, path, or URL import.
- **Skill choices come from the inventory** — project skills that depend on a workspace directory are not listed in the picker.
- **Settings data can be stale** — the page's cached library metadata from another client appears after a reconnect or page reload; the selection menus always read a fresh ranking.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A browser-side settings page and input-trigger source that register one localized `settings.section` contribution, one locale namespace, and one `@` source; they emit no Cordis events and own no cross-plugin mutable relation.
