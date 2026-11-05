---
description: "A sidebar notes entry and a sticky-note wall persisted in the browser."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-notes

English | [中文](README.zh.md)

## Summary

This package adds a Notes entry to the Web sidebar and the main-column panel it opens, where the user adds, views, edits and deletes notes and sticky notes. Notes are stored in the browser's `localStorage`; no Host service is involved.

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web composition mounts this plugin; no configuration exists. It registers one `sidebar.panellist` entry and one `main` panel keyed `notes`. Opening the entry shows the default sticky-note wall. Entries persist across reloads in the same browser profile.

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-sidebar](../ui-sidebar/README.md) — declares the `sidebar.panellist` slot the entry occupies.
- [ui-layout](../ui-layout/README.md) — declares the keyed `main` slot the panel occupies.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints, not a task backlog.

- **Browser-local storage** — notes are not shared across browsers or devices, and clearing site data deletes them.
- **No model access** — notes are never added to a Session or model request.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
