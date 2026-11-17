/** Connections Settings page, browser half. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectorView } from '@deepseek-ai/dsh-connections/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ConnectionsController } from './controller.ts'
import { ConnectionsSection } from './ConnectionsSection.tsx'
import { en, zh, type ConnectionsLocaleKey } from './locales.ts'

export type { ConnectionsFace, ConnectionsState } from './controller.ts'
export type { ConnectionsSectionProps } from './ConnectionsSection.tsx'
export type { ConnectionsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Connections page copy. */
    'settings.connections': ConnectionsLocaleKey
  }
}

const NS = 'settings.connections'

export const inject = ['slots', 'locale', 'remote', 'remote.connections']

/** Contribute the Connections page to Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-connections: dictionaries')

  const t = ctx.locale.bind(NS)
  const watch = async function* (signal: AbortSignal) {
    const stream = ctx.remote.$stream<ConnectorView[]>({
      name: 'connections',
      open: openSignal => ctx.remote.connections.watch(openSignal),
      ended: () => new Error('connections watch ended'),
    })
    for await (const frame of stream) {
      if (signal.aborted) return
      frame.accept()
      yield frame.value
    }
  }
  const controller = new ConnectionsController(ctx.remote.connections, watch)
  ctx.effect(() => controller.start(), 'ui-settings-connections: controller')
  ctx.on('connection/reset', () => { void controller.reload() })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'connections',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    inject: () => controller.inject(),
  }, ConnectionsSection))
}
