/**
 * Fold process view: one compact, independently collapsible block for a single
 * process step (a tool call or a reasoning segment). Collapsed it shows just
 * the header (arrow + kind glyph + title). Expanded it reveals the step's
 * summary; error steps are highlighted. The header toggles open state.
 */

import { useState } from 'react'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatProcessFoldKey } from './locales.ts'
import type { ProcessFoldChatData, ProcessFoldKind } from './process-fold.ts'
import css from './ProcessFold.module.css'

/** Full props of the keyed chat-node renderer, localized to this namespace. */
export type FoldProcessViewProps = Omit<ChatNodeViewProps<'process-fold'>, 't'> & {
  readonly t: (key: ChatProcessFoldKey) => string
}

/** Decorative per-kind glyph without localized copy. */
function kindGlyph(kind: ProcessFoldKind): string {
  return kind === 'tool' ? '⚙' : '…'
}

/** Compact header title in the plugin's own copy. */
function headerTitle(kind: ProcessFoldKind, t: (key: ChatProcessFoldKey) => string): string {
  return kind === 'tool' ? t('title') : t('thought')
}

/**
 * Render the collapsible block for one process step.
 * @param props - chat node payload and localized chat-process-fold copy.
 * @returns the fold block.
 */
export function FoldProcessView({ node, t }: FoldProcessViewProps) {
  const [open, setOpen] = useState(false)
  const data: ProcessFoldChatData = node.data
  const toggle = () => { setOpen(value => !value) }
  return (
    <div
      className={css.box}
      data-open={open || undefined}
      data-process-fold
      data-process-fold-kind={data.kind}
      data-process-fold-error={data.error || undefined}
      data-process-fold-turn={data.turn}
    >
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={open ? t('collapse') : t('expand')}
        onClick={toggle}
      >
        <span className={css.arrow} aria-hidden>▶</span>
        <span className={css.kindGlyph} aria-hidden>{kindGlyph(data.kind)}</span>
        <span className={css.title}>{headerTitle(data.kind, t)}</span>
      </button>
      {open && (
        <div className={`${css.summary}${data.error ? ` ${css.error}` : ''}`}>
          {data.summary}
        </div>
      )}
    </div>
  )
}
