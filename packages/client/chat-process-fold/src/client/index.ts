/**
 * chat-process-fold plugin, browser half: registers the process-fold
 * Conversation Definition and its keyed chat-node renderer, plus a General
 * Settings toggle. Composing this plugin out removes the fold surface
 * entirely, leaving the chat's native turn-process disclosure unchanged.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { FoldProcessView } from './FoldProcessView.tsx'
import { en, NS, zh, type ChatProcessFoldKey } from './locales.ts'
import { processFoldDefinition } from './process-fold.ts'
import { ProcessFoldToggleRow, type ProcessFoldRowInjected } from './ProcessFoldToggleRow.tsx'
import { NAMESPACE, ProcessFoldPolicy, type ChatProcessFoldSettings } from './settings.ts'
import type { ChatProcessFoldPreference } from '@deepseek-ai/dsh-client-ui-chat/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Process-fold box and settings copy. */
    'chat-process-fold': ChatProcessFoldKey
  }
}

/** Plugin configuration (set in the profile's cordis.patch.yml). */
export interface Config {
  /** Master switch; when false the plugin folds nothing regardless of settings. */
  readonly enabled?: boolean
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
})

/** Services required for the fold box and its settings row. */
export const inject = ['slots', 'uiConversation', 'locale', 'configForms']

/**
 * Mount the process-fold surface and its settings toggle.
 * @param ctx - client root context.
 * @param config - plugin configuration.
 */
export function apply(ctx: ClientContext, config: Config): void {
  if (config.enabled === false) return
  const policy = new ProcessFoldPolicy(
    ctx.configForms.get<ChatProcessFoldSettings>(NAMESPACE),
  )
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chat-process-fold: dictionaries')

  // Publish the live fold preference so the native chat target can fold its
  // process rows during open Turns too. The chat target reads this service via
  // ctx.get, so its absence — this plugin composed out — keeps native behavior.
  const preference: ChatProcessFoldPreference = { live: policy.enabled }
  const disposePreference = ctx.provide('chatProcessFold', preference)

  // Install and uninstall the fold surface to follow the persisted toggle.
  let disposeInstall: (() => void) | undefined
  const installIfEnabled = (): void => {
    disposeInstall?.()
    disposeInstall = undefined
    if (!policy.enabled.getSnapshot()) return
    const disposeDefinition = ctx.uiConversation.events.register(processFoldDefinition)
    const disposeView = ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
      { name: 'conversation.chat.node', key: 'process-fold', locale: NS }, FoldProcessView))
    disposeInstall = () => { disposeDefinition(); disposeView() }
  }
  installIfEnabled()
  const watch = policy.enabled.subscribe(installIfEnabled)

  const disposeRow = ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'chat-process-fold',
    order: 20,
    locale: NS,
    inject: (): ProcessFoldRowInjected => ({
      hooks: { enabled: policy.enabled },
      setEnabled: (value) => { policy.setEnabled(value) },
    }),
  }, ProcessFoldToggleRow))

  ctx.effect(() => () => { watch(); disposeInstall?.(); disposeRow(); disposePreference() })
}
