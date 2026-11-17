/**
 * Connections settings page: built-in OAuth connectors with connect and
 * disconnect actions.
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectorId } from '@deepseek-ai/dsh-connections/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionsFace } from './controller.ts'
import { ConnectorBrowserLogin } from './browser-login.ts'
import css from './ConnectionsSection.module.css'

export type ConnectionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.connections'>
  & InjectFace<ConnectionsFace>

/** Render the Connections settings section. */
export function ConnectionsSection(props: ConnectionsSectionProps): ReactNode {
  const { t, connect, disconnect, load, useConnections } = props
  const state = useConnections(snapshot => snapshot)
  const browser = useMemo(() => new ConnectorBrowserLogin(), [])

  useEffect(() => {
    load().catch((reason: unknown) => { console.warn('connections load rejected:', reason) })
    return () => { browser.dispose() }
  }, [browser, load])

  useEffect(() => {
    browser.update(state.rows)
  }, [browser, state.rows])

  useEffect(() => {
    if (state.actionError !== undefined) browser.dispose()
  }, [browser, state.actionError])

  const oauthRedirectUri = `${window.location.protocol}//${window.location.host}/connections/oauth/callback`

  const phaseLabel = (phase: string): string => {
    if (phase === 'connected') return t('connected')
    if (phase === 'connecting') return t('connecting')
    if (phase === 'failed') return t('failed')
    return t('disconnected')
  }

  const onConnect = (id: ConnectorId, oauthConfigured: boolean): void => {
    if (!oauthConfigured) return
    browser.begin()
    browser.follow(id)
    connect(id).catch((reason: unknown) => {
      browser.dispose()
      console.warn('connect rejected:', reason)
    })
  }

  return (
    <div className={css.section}>
      {state.phase === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.phase === 'error' ? (
        <p className={css.error}>{t('loadFailed', { reason: state.error ?? '' })}</p>
      ) : null}
      {state.actionError === undefined ? null : (
        <p className={css.error}>{t('actionError', { reason: state.actionError })}</p>
      )}
      <ul className={css.list}>
        {state.rows.map(row => (
          <li key={row.id} className={css.row}>
            <div className={css.identity}>
              <span className={css.title}>{row.label}</span>
              <span className={css.status}>{phaseLabel(row.phase)}</span>
              {row.error === undefined ? null : <span className={css.error}>{row.error}</span>}
              {row.oauthConfigured ? null : (
                <span className={css.hint}>{t('oauthSetupHint', { redirectUri: oauthRedirectUri })}</span>
              )}
            </div>
            <div className={css.actions}>
              {row.phase === 'connected' ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.busyId !== undefined}
                  onClick={() => { disconnect(row.id).catch((reason: unknown) => { console.warn('disconnect rejected:', reason) }) }}
                >
                  {t('disconnect')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.busyId !== undefined || row.phase === 'connecting' || !row.oauthConfigured}
                  onClick={() => { onConnect(row.id, row.oauthConfigured) }}
                >
                  {row.phase === 'connecting' ? t('connecting') : t('connect')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
