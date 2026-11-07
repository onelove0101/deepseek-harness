/** Confirmation dialog for permanently removing a Session. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionRemoveConfirmProps, SessionRemoveConfirmRequest } from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * The `shell.overlay` entry: nothing while no confirmation is pending,
 * otherwise one dialog per request (keyed by the Session).
 * @param props - the request hook, its settlement, the delete hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionRemoveConfirmDialog({
  useRemoveRequest, settleSessionRemove, removeSession, t,
}: SessionRemoveConfirmProps) {
  const request = useRemoveRequest(pending => pending)
  if (request === null) return null
  return (
    <RemoveConfirmForm
      key={request.sessionId}
      request={request}
      removeSession={removeSession}
      onSettle={settleSessionRemove}
      t={t}
    />
  )
}

/** One request's dialog: in-flight and error state die with it. */
function RemoveConfirmForm({ request, removeSession, onSettle, t }: {
  request: SessionRemoveConfirmRequest
  removeSession: SessionRemoveConfirmProps['removeSession']
  onSettle: () => void
  t: SessionRemoveConfirmProps['t']
}) {
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (removing) return
    onSettle()
  }
  const confirm = () => {
    setRemoving(true)
    setError(null)
    removeSession(request.sessionId).then(() => {
      setRemoving(false)
      onSettle()
    }).catch((reason: unknown) => {
      setRemoving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('remove.session')}
      description={t('remove.session.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={removing} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={browserCss.deleteAction} disabled={removing} onClick={confirm}>
            {t('remove.session.action')}
          </Button>
        </>
      )}
    >
      {removing && <div className={browserCss.deleteStatus} role="status">{t('remove.session.pending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
