/**
 * Skills Settings page: every skill the host loaded, each with an enable
 * switch, and an Add skill action that registers a directory containing
 * `SKILL.md`. A disabled skill stays listed but is hidden from the model
 * catalog, the `skill` tool, and the `/` menu.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillsFace } from './controller.ts'
import css from './SkillsSection.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type SkillsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.skills'>
  & InjectFace<SkillsFace>

/**
 * Render the Skills page.
 * @param props - composed slot props (see {@link SkillsSectionProps}).
 * @returns the settings page element tree.
 */
export function SkillsSection(props: SkillsSectionProps): ReactNode {
  const { t, setEnabled, add, load, useSkills } = props
  const state = useSkills(snapshot => snapshot)
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')

  useEffect(() => {
    load().catch((reason: unknown) => { console.warn('skill inventory load rejected:', reason) })
  }, [load])

  const confirm = (): void => {
    const trimmed = path.trim()
    if (trimmed.length === 0 || state.adding) return
    add(trimmed).then((added) => {
      if (added) {
        setAdding(false)
        setPath('')
      }
    }, (reason: unknown) => { console.warn('skill add rejected:', reason) })
  }

  return (
    <div className={css.section}>
      <div className={css.toolbar}>
        <Button variant="outline" size="sm" onClick={() => { setAdding(true) }} disabled={adding || !state.writable}>
          {t('add')}
        </Button>
      </div>
      {adding ? (
        <div className={css.addForm}>
          <input
            type="text"
            value={path}
            autoFocus
            placeholder={t('addPlaceholder')}
            aria-label={t('addLabel')}
            onChange={(event) => { setPath(event.currentTarget.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') confirm() }}
          />
          <Button variant="outline" size="sm" disabled={state.adding || path.trim().length === 0} onClick={confirm}>
            {state.adding ? t('adding') : t('addConfirm')}
          </Button>
          <Button variant="outline" size="sm" disabled={state.adding} onClick={() => { setAdding(false); setPath('') }}>
            {t('cancel')}
          </Button>
        </div>
      ) : null}
      {state.actionError === undefined ? null : <p className={css.error}>{state.actionError}</p>}
      {!state.writable && state.phase === 'ready' ? <p className={css.status}>{t('readOnly')}</p> : null}
      {state.phase === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.phase === 'error' ? (
        <p className={css.error}>{t('loadFailed', { reason: state.error ?? '' })}</p>
      ) : null}
      {state.phase === 'ready' && state.rows.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
      {state.rows.length > 0 ? (
        <ul className={css.list}>
          {state.rows.map(row => (
            <li key={row.name} className={css.row}>
              <span className={css.identity}>
                <span className={css.title}>{row.name}</span>
                <span className={css.meta}>{row.description}</span>
                <span className={css.meta}>{row.source}</span>
              </span>
              <Switch
                checked={row.enabled}
                label={t('toggleNamed', { name: row.name })}
                disabled={!state.writable}
                onChange={(next) => { setEnabled(row.name, next).catch((reason: unknown) => { console.warn('skill toggle rejected:', reason) }) }}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
