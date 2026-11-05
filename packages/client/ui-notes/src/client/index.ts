/**
 * Notes surface plugin, browser half: the **📓 笔记 / 便签** entry of the
 * left sidebar and the panel it opens in the main column. The panel lets the
 * user add, view, edit and delete notes and sticky notes, persisted in the
 * browser's localStorage (no Host service needed).
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the id brand of the root `main` keyed slot declared by ui-layout.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the renderer-owned slots service onto the Cordis Context.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `sidebar.panellist` list slot and its owner props.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NotesPanel } from './NotesPanel.tsx'
import { NotesIcon } from './NotesIcon.tsx'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'notes' as MainPanelId

/** Services required by the sidebar registration and the main panel. */
export const inject = ['slots']

/**
 * Register the notes entry into the sidebar with the panel it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, NotesPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 1000,
    label: () => '笔记',
  }, NotesIcon))
}
