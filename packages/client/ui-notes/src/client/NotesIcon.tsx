/**
 * The sidebar's notes entry icon; the sidebar owns the button, label, and
 * selected state around it.
 */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the notes glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and selection.
 * @returns the icon element.
 */
export function NotesIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <span style={{ fontSize: size, lineHeight: 1 }}>📓</span>
}
