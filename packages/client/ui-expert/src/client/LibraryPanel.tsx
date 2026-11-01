/** Expert library panel: stored text documents and knowledge bases, with create and delete actions. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ExpertDocumentCreateRequest, ExpertDocumentId, ExpertKnowledgeBaseId, ExpertKnowledgeBaseSaveRequest, ExpertLibraryValue,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ExpertTranslate } from './ExpertForm.tsx'
import css from './ExpertsSection.module.css'

/** Props of {@link LibraryPanel}. */
export interface LibraryPanelProps {
  t: ExpertTranslate
  library: ExpertLibraryValue
  busy: boolean
  /** True while an Expert form is open; deleting a document or knowledge base is disabled so the form cannot keep a stale selection. */
  locked: boolean
  createDocument: (request: ExpertDocumentCreateRequest) => Promise<boolean>
  deleteDocument: (id: ExpertDocumentId) => Promise<boolean>
  saveKnowledgeBase: (request: ExpertKnowledgeBaseSaveRequest) => Promise<boolean>
  deleteKnowledgeBase: (id: ExpertKnowledgeBaseId) => Promise<boolean>
}

/**
 * Report a rejected action without surfacing an unhandled rejection.
 * @param action - action name for the log line.
 * @returns a rejection handler.
 */
function warnRejected(action: string): (reason: unknown) => void {
  return (reason) => { console.error(`${action} rejected:`, reason) }
}

/**
 * Render the library panel.
 * @param props - see {@link LibraryPanelProps}.
 * @returns the panel element tree.
 */
export function LibraryPanel(props: LibraryPanelProps): ReactNode {
  const { t, library, busy, locked, createDocument, deleteDocument, saveKnowledgeBase, deleteKnowledgeBase } = props
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [baseName, setBaseName] = useState('')
  const [members, setMembers] = useState<readonly ExpertDocumentId[]>([])
  const used = library.documents.reduce((sum, document) => sum + document.bytes, 0)

  const addDocument = (): void => {
    createDocument({ title: title.trim(), text }).then((added) => {
      if (added) {
        setTitle('')
        setText('')
      }
    }, warnRejected('document create'))
  }
  const addBase = (): void => {
    saveKnowledgeBase({ name: baseName.trim(), documentIds: members }).then((saved) => {
      if (saved) {
        setBaseName('')
        setMembers([])
      }
    }, warnRejected('knowledge base save'))
  }

  return (
    <section className={css.library} aria-label={t('libraryTitle')}>
      <h3 className={css.heading}>{t('libraryTitle')}</h3>
      <p className={css.status}>{t('libraryHint')}</p>
      <p className={css.status}>{t('libraryUsage', { bytes: used, max: library.limits.maxLibraryBytes })}</p>
      <ul className={css.list}>
        {library.documents.map(document => (
          <li key={document.id} className={css.row}>
            <span className={css.identity}>
              <span className={css.title}>{document.title}</span>
              <span className={css.meta}>{t('documentBytes', { bytes: document.bytes })}</span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || locked}
              aria-label={t('deleteDocumentNamed', { title: document.title })}
              onClick={() => { deleteDocument(document.id).catch(warnRejected('document delete')) }}
            >
              {t('delete')}
            </Button>
          </li>
        ))}
      </ul>
      <div className={css.form}>
        <input
          type="text"
          value={title}
          placeholder={t('documentTitle')}
          aria-label={t('documentTitle')}
          onChange={(event) => { setTitle(event.currentTarget.value) }}
        />
        <textarea
          rows={5}
          value={text}
          placeholder={t('documentText')}
          aria-label={t('documentText')}
          onChange={(event) => { setText(event.currentTarget.value) }}
        />
        <div className={css.actions}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || title.trim().length === 0 || text.trim().length === 0}
            onClick={addDocument}
          >
            {t('documentAdd')}
          </Button>
        </div>
      </div>
      <ul className={css.list}>
        {library.knowledgeBases.map(base => (
          <li key={base.id} className={css.row}>
            <span className={css.identity}>
              <span className={css.title}>{base.name}</span>
              <span className={css.meta}>{t('knowledgeBaseDocs', { count: base.documentIds.length })}</span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || locked}
              aria-label={t('deleteKnowledgeBaseNamed', { name: base.name })}
              onClick={() => { deleteKnowledgeBase(base.id).catch(warnRejected('knowledge base delete')) }}
            >
              {t('delete')}
            </Button>
          </li>
        ))}
      </ul>
      <div className={css.form}>
        <input
          type="text"
          value={baseName}
          placeholder={t('knowledgeBaseName')}
          aria-label={t('knowledgeBaseName')}
          onChange={(event) => { setBaseName(event.currentTarget.value) }}
        />
        <fieldset className={css.choices}>
          <legend className={css.label}>{t('formDocuments')}</legend>
          {library.documents.map(document => (
            <label key={document.id} className={css.choice}>
              <input
                type="checkbox"
                checked={members.includes(document.id)}
                onChange={() => {
                  setMembers(members.includes(document.id)
                    ? members.filter(entry => entry !== document.id)
                    : [...members, document.id])
                }}
              />
              {document.title}
            </label>
          ))}
        </fieldset>
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={busy || baseName.trim().length === 0} onClick={addBase}>
            {t('knowledgeBaseSave')}
          </Button>
        </div>
      </div>
    </section>
  )
}
