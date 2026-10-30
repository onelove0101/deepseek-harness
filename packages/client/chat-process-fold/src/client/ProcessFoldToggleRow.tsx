/**
 * General Settings row toggling the process-fold box. Reads the reactive
 * enable state through the registered inject face and persists each choice.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './ProcessFoldToggleRow.module.css'

/** Registration-side fold-toggle face. */
export interface ProcessFoldRowInjected {
  hooks: {
    /** Persisted fold-box preference bound as useEnabled. */
    enabled: SnapshotStore<boolean>
  }
  /** Change the persisted fold-box preference. */
  setEnabled: (value: boolean) => void
}

/** Full Settings-row props. */
export type ProcessFoldToggleRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<typeof NS>
  & InjectFace<ProcessFoldRowInjected>

/**
 * Render the process-fold enable switch.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function ProcessFoldToggleRow({ useEnabled, setEnabled, t }: ProcessFoldToggleRowProps) {
  const enabled = useEnabled(value => value)
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.title')}</div>
        <div className={css.desc}>{t('settings.description')}</div>
      </div>
      <button
        type="button"
        className={css.switch}
        data-on={enabled || undefined}
        aria-pressed={enabled}
        onClick={() => { setEnabled(!enabled) }}
      >
        {enabled ? t('settings.on') : t('settings.off')}
      </button>
    </div>
  )
}
