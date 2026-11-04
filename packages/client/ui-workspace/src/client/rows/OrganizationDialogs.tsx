/** Workspace Group and Session Folder dialogs, keyed by their captured request. */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { WorkspaceGroupView, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceBrowserProps, WorkspaceOrganizationRequest } from '../contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

/** Request kinds this module renders; Workspace rename and delete belong to the Workspace dialogs. */
export type OrganizationRequest = WorkspaceOrganizationRequest

type Translate = WorkspaceBrowserProps['t']

type Props = Pick<
  WorkspaceBrowserProps,
  'createGroup' | 'renameGroup' | 'deleteGroup' | 'createFolder' | 'renameFolder' | 'deleteFolder' | 'settleWorkspaceAction' | 't'
> & {
  request: OrganizationRequest
  workspaces: readonly WorkspaceView[]
  groups: readonly WorkspaceGroupView[]
  /** Expand a Workspace branch so a freshly created Folder renders. */
  expandWorkspace: (workspaceId: WorkspaceView['workspaceId']) => void
}

function describeFailure(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** One name-entry dialog: trimmed, non-blank, unchanged and duplicate names stay blocked. */
function NameDialog({ title, fieldLabel, confirmLabel, initial, conflict, onSubmit, onClose, t }: {
  title: string
  fieldLabel: string
  confirmLabel: string
  /** Seed text; the confirm action stays blocked while the draft equals it. */
  initial: string
  /** Inline conflict copy for a trimmed draft that collides with a sibling, or null. */
  conflict: (name: string) => string | null
  onSubmit: (name: string) => Promise<void>
  /** Close the dialog without submitting. */
  onClose: () => void
  t: Translate
}) {
  const composingRef = useRef(false)
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const trimmed = draft.trim()
  const conflictText = trimmed === '' ? null : conflict(trimmed)
  const blocked = busy || trimmed === '' || trimmed === initial || conflictText !== null
  const close = () => { if (!busy) onClose() }
  const confirm = () => {
    if (blocked) return
    setBusy(true)
    setFailure(null)
    onSubmit(trimmed).catch((reason: unknown) => {
      setBusy(false)
      setFailure(describeFailure(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={title}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={confirm}>{confirmLabel}</Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={draft}
        aria-label={fieldLabel}
        data-modal-autofocus
        disabled={busy}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setDraft(e.target.value); setFailure(null) }}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composingRef.current) {
            e.preventDefault()
            confirm()
          }
        }}
      />
      {conflictText !== null && <div className={css.renameError} role="alert">{conflictText}</div>}
      {failure !== null && <div className={css.renameError} role="alert">{failure}</div>}
    </Modal>
  )
}

/**
 * One destructive confirmation. A successful call keeps the dialog open until
 * `committed` reports that the projection no longer holds the target.
 */
function ConfirmDialog({ title, description, confirmLabel, pendingLabel, committed, onConfirm, onClose, t }: {
  title: string
  description: string
  confirmLabel: string
  pendingLabel: string
  /** True once the browser projection dropped the target; closes the dialog after a successful call. */
  committed: boolean
  onConfirm: () => Promise<void>
  /** Close the dialog without confirming. */
  onClose: () => void
  t: Translate
}) {
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (accepted && committed) onClose()
  }, [accepted, committed, onClose])
  const close = () => { if (!busy) onClose() }
  const confirm = () => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    onConfirm().then(() => { setAccepted(true) }).catch((reason: unknown) => {
      setBusy(false)
      setFailure(describeFailure(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={title}
      description={description}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={css.deleteAction} disabled={busy} onClick={confirm}>{confirmLabel}</Button>
        </>
      )}
    >
      {busy && <div className={css.deleteStatus} role="status">{pendingLabel}</div>}
      {failure !== null && <div className={css.renameError} role="alert">{failure}</div>}
    </Modal>
  )
}

/**
 * @param props - captured request, current Workspace and Group projections, and the durable mutations.
 * @returns the dialog that request names.
 */
export function OrganizationDialogs({
  request, workspaces, groups, expandWorkspace, createGroup, renameGroup, deleteGroup, createFolder, renameFolder,
  deleteFolder, settleWorkspaceAction, t,
}: Props) {
  switch (request.action) {
    case 'createGroup':
      return (
        <NameDialog
          title={t('group.create')} fieldLabel={t('field.groupName')} confirmLabel={t('group.create')} initial=""
          conflict={name => groups.some(group => group.title === name) ? t('conflict.groupNamed', { name }) : null}
          onSubmit={async (name) => { await createGroup(name); settleWorkspaceAction() }}
          onClose={settleWorkspaceAction} t={t}
        />
      )
    case 'renameGroup': {
      const { groupId } = request
      return (
        <NameDialog
          title={t('group.rename.title')} fieldLabel={t('field.groupName')} confirmLabel={t('rename')}
          initial={request.displayTitle}
          conflict={name => groups.some(group => group.groupId !== groupId && group.title === name)
            ? t('conflict.groupNamed', { name })
            : null}
          onSubmit={async (name) => { await renameGroup(groupId, name); settleWorkspaceAction() }}
          onClose={settleWorkspaceAction} t={t}
        />
      )
    }
    case 'deleteGroup': {
      const { groupId } = request
      return (
        <ConfirmDialog
          title={t('group.delete')} description={t('group.delete.desc', { name: request.displayTitle })}
          confirmLabel={t('group.delete')} pendingLabel={t('group.delete.pending')}
          committed={!groups.some(group => group.groupId === groupId)}
          onConfirm={() => deleteGroup(groupId)} onClose={settleWorkspaceAction} t={t}
        />
      )
    }
    case 'createFolder': {
      const { workspaceId } = request
      const siblings = workspaces.find(workspace => workspace.workspaceId === workspaceId)?.folders ?? []
      return (
        <NameDialog
          title={t('folder.create')} fieldLabel={t('field.folderName')} confirmLabel={t('folder.create')} initial=""
          conflict={name => siblings.some(folder => folder.title === name) ? t('conflict.folderNamed', { name }) : null}
          onSubmit={async (name) => {
            await createFolder(workspaceId, name)
            expandWorkspace(workspaceId)
            settleWorkspaceAction()
          }}
          onClose={settleWorkspaceAction} t={t}
        />
      )
    }
    case 'renameFolder': {
      const { workspaceId, folderId } = request
      const siblings = workspaces.find(workspace => workspace.workspaceId === workspaceId)?.folders ?? []
      return (
        <NameDialog
          title={t('folder.rename.title')} fieldLabel={t('field.folderName')} confirmLabel={t('rename')}
          initial={request.displayTitle}
          conflict={name => siblings.some(folder => folder.folderId !== folderId && folder.title === name)
            ? t('conflict.folderNamed', { name })
            : null}
          onSubmit={async (name) => { await renameFolder(workspaceId, folderId, name); settleWorkspaceAction() }}
          onClose={settleWorkspaceAction} t={t}
        />
      )
    }
    case 'deleteFolder': {
      const { workspaceId, folderId } = request
      return (
        <ConfirmDialog
          title={t('folder.delete')} description={t('folder.delete.desc', { name: request.displayTitle })}
          confirmLabel={t('folder.delete')} pendingLabel={t('folder.delete.pending')}
          committed={!(workspaces.find(workspace => workspace.workspaceId === workspaceId)?.folders ?? [])
            .some(folder => folder.folderId === folderId)}
          onConfirm={() => deleteFolder(workspaceId, folderId)} onClose={settleWorkspaceAction} t={t}
        />
      )
    }
    default:
      return assertNever(request)
  }
}
