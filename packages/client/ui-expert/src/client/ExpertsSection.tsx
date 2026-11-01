/**
 * Experts Settings page: the roster of persistent Experts with an enable
 * switch, edit and delete actions, a create/edit form, and the private
 * document and knowledge-base library the Experts select from.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExpertValue } from '@deepseek-ai/dsh-api-remotes/client'
import type { ExpertsFace } from './controller.ts'
import { ExpertForm } from './ExpertForm.tsx'
import { LibraryPanel } from './LibraryPanel.tsx'
import css from './ExpertsSection.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type ExpertsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.experts'>
  & InjectFace<ExpertsFace>

/** Which form is open: none, a new Expert, or the Expert being edited. */
type Editing = { kind: 'none' } | { kind: 'new' } | { kind: 'edit'; expert: ExpertValue }

/**
 * Render the Experts page.
 * @param props - composed slot props (see {@link ExpertsSectionProps}).
 * @returns the settings page element tree.
 */
export function ExpertsSection(props: ExpertsSectionProps): ReactNode {
  const { t, load, saveExpert, deleteExpert, createDocument, deleteDocument, saveKnowledgeBase, deleteKnowledgeBase, useExperts } = props
  const state = useExperts(snapshot => snapshot)
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })
  const library = state.library

  useEffect(() => {
    load().catch((reason: unknown) => { console.error('expert library load rejected:', reason) })
  }, [load])

  const save: Parameters<typeof ExpertForm>[0]['onSave'] = async (request) => {
    const saved = await saveExpert(request)
    if (saved) {
      setEditing({ kind: 'none' })
    }
    return saved
  }
  const toggle = (expert: ExpertValue, enabled: boolean): void => {
    saveExpert({
      id: expert.id,
      name: expert.name,
      enabled,
      soul: expert.soul,
      skills: expert.skills,
      documentIds: expert.documentIds,
      knowledgeBaseIds: expert.knowledgeBaseIds,
    }).catch((reason: unknown) => { console.error('expert toggle rejected:', reason) })
  }

  return (
    <div className={css.section}>
      <div className={css.toolbar}>
        <Button
          variant="outline"
          size="sm"
          disabled={editing.kind !== 'none' || library === undefined}
          onClick={() => { setEditing({ kind: 'new' }) }}
        >
          {t('newExpert')}
        </Button>
      </div>
      {state.actionError === undefined ? null : <p className={css.error}>{state.actionError}</p>}
      {state.phase === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.phase === 'error' ? (
        <p className={css.error}>
          {t('loadFailed', { reason: state.error ?? '' })}
          {' '}
          <Button variant="outline" size="sm" onClick={() => { load().catch((reason: unknown) => { console.error('expert library load rejected:', reason) }) }}>
            {t('retry')}
          </Button>
        </p>
      ) : null}
      {library !== undefined && editing.kind !== 'none' ? (
        <ExpertForm
          key={editing.kind === 'edit' ? editing.expert.id : 'new'}
          t={t}
          expert={editing.kind === 'edit' ? editing.expert : undefined}
          library={library}
          skills={state.skills}
          busy={state.busy}
          onSave={save}
          onCancel={() => { setEditing({ kind: 'none' }) }}
        />
      ) : null}
      {library !== undefined && library.experts.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
      {library !== undefined && library.experts.length > 0 ? (
        <ul className={css.list}>
          {library.experts.map(expert => (
            <li key={expert.id} className={css.row}>
              <span className={css.identity}>
                <span className={css.title}>
                  {`@${expert.name}`}
                  {expert.enabled ? null : <span className={css.badge}>{t('disabledBadge')}</span>}
                </span>
                <span className={css.meta}>
                  {t('summary', {
                    skills: expert.skills.length,
                    documents: expert.documentIds.length,
                    bases: expert.knowledgeBaseIds.length,
                  })}
                </span>
              </span>
              <Switch
                checked={expert.enabled}
                label={t('enabledNamed', { name: expert.name })}
                disabled={state.busy || editing.kind !== 'none'}
                onChange={(next) => { toggle(expert, next) }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={state.busy || editing.kind !== 'none'}
                aria-label={`${t('edit')} @${expert.name}`}
                onClick={() => { setEditing({ kind: 'edit', expert }) }}
              >
                {t('edit')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={state.busy}
                aria-label={`${t('delete')} @${expert.name}`}
                onClick={() => { deleteExpert(expert.id).catch((reason: unknown) => { console.error('expert delete rejected:', reason) }) }}
              >
                {t('delete')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {library === undefined ? null : (
        <LibraryPanel
          t={t}
          library={library}
          busy={state.busy}
          locked={editing.kind !== 'none'}
          createDocument={createDocument}
          deleteDocument={deleteDocument}
          saveKnowledgeBase={saveKnowledgeBase}
          deleteKnowledgeBase={deleteKnowledgeBase}
        />
      )}
    </div>
  )
}
