/** Create/edit form for one Expert: name, enabled, Soul, and the skill, document, and knowledge-base selections. */
import { useState, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ExpertDocumentId, ExpertId, ExpertKnowledgeBaseId, ExpertLibraryValue, ExpertSaveRequest, ExpertValue,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ExpertLocaleKey } from './locales.ts'
import css from './ExpertsSection.module.css'

/** Translate one page key with optional `{name}` parameters. */
export type ExpertTranslate = (key: ExpertLocaleKey, params?: Record<string, string | number>) => string

/** Props of {@link ExpertForm}. */
export interface ExpertFormProps {
  t: ExpertTranslate
  /** Expert being edited; absent for a new Expert. */
  expert: ExpertValue | undefined
  library: ExpertLibraryValue
  /** Selectable skill names. */
  skills: readonly string[]
  busy: boolean
  onSave: (request: ExpertSaveRequest) => Promise<boolean>
  onCancel: () => void
}

/**
 * Add `value` to `list` when absent, otherwise remove it.
 * @param list - current selection.
 * @param value - item to toggle.
 * @returns the new selection.
 */
function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter(entry => entry !== value) : [...list, value]
}

/**
 * Render the Expert form.
 * @param props - see {@link ExpertFormProps}.
 * @returns the form element tree.
 */
export function ExpertForm({ t, expert, library, skills, busy, onSave, onCancel }: ExpertFormProps): ReactNode {
  const [name, setName] = useState(expert?.name ?? '')
  const [enabled, setEnabled] = useState(expert?.enabled ?? true)
  const [soul, setSoul] = useState(expert?.soul ?? '')
  const [picked, setPicked] = useState<readonly string[]>(expert?.skills ?? [])
  const [documentIds, setDocumentIds] = useState<readonly ExpertDocumentId[]>(expert?.documentIds ?? [])
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<readonly ExpertKnowledgeBaseId[]>(expert?.knowledgeBaseIds ?? [])

  const unavailableSkills = picked.filter(skill => !skills.includes(skill))

  const save = (): void => {
    const id: ExpertId | undefined = expert?.id
    onSave({
      ...(id === undefined ? {} : { id }),
      name: name.trim(), enabled, soul, skills: picked, documentIds, knowledgeBaseIds,
    }).catch((reason: unknown) => { console.error('expert save rejected:', reason) })
  }

  return (
    <div className={css.form}>
      <label className={css.field}>
        <span className={css.label}>{t('formName')}</span>
        <input
          type="text"
          value={name}
          autoFocus
          aria-label={t('formName')}
          onChange={(event) => { setName(event.currentTarget.value) }}
        />
        <span className={css.meta}>{t('formNameHint')}</span>
      </label>
      <div className={css.field}>
        <span className={css.label}>{t('formEnabled')}</span>
        <Switch checked={enabled} label={t('formEnabled')} onChange={setEnabled} />
      </div>
      <label className={css.field}>
        <span className={css.label}>{t('formSoul')}</span>
        <textarea
          rows={8}
          value={soul}
          aria-label={t('formSoul')}
          onChange={(event) => { setSoul(event.currentTarget.value) }}
        />
        <span className={css.meta}>{t('formSoulHint')}</span>
      </label>
      <fieldset className={css.choices}>
        <legend className={css.label}>{t('formSkills')}</legend>
        {skills.length === 0 && unavailableSkills.length === 0 ? <p className={css.status}>{t('formSkillsEmpty')}</p> : null}
        {skills.map(skill => (
          <label key={skill} className={css.choice}>
            <input type="checkbox" checked={picked.includes(skill)} onChange={() => { setPicked(toggled(picked, skill)) }} />
            {skill}
          </label>
        ))}
        {unavailableSkills.map(skill => (
          <label key={skill} className={css.choice}>
            <input type="checkbox" checked onChange={() => { setPicked(toggled(picked, skill)) }} />
            {t('formSkillUnavailable', { name: skill })}
          </label>
        ))}
      </fieldset>
      <fieldset className={css.choices}>
        <legend className={css.label}>{t('formDocuments')}</legend>
        {library.documents.length === 0 ? <p className={css.status}>{t('formDocumentsEmpty')}</p> : null}
        {library.documents.map(document => (
          <label key={document.id} className={css.choice}>
            <input
              type="checkbox"
              checked={documentIds.includes(document.id)}
              onChange={() => { setDocumentIds(toggled(documentIds, document.id)) }}
            />
            {document.title}
          </label>
        ))}
      </fieldset>
      <fieldset className={css.choices}>
        <legend className={css.label}>{t('formKnowledgeBases')}</legend>
        {library.knowledgeBases.length === 0 ? <p className={css.status}>{t('formKnowledgeBasesEmpty')}</p> : null}
        {library.knowledgeBases.map(base => (
          <label key={base.id} className={css.choice}>
            <input
              type="checkbox"
              checked={knowledgeBaseIds.includes(base.id)}
              onChange={() => { setKnowledgeBaseIds(toggled(knowledgeBaseIds, base.id)) }}
            />
            {base.name}
          </label>
        ))}
      </fieldset>
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy || name.trim().length === 0} onClick={save}>
          {busy ? t('saving') : t('save')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  )
}
