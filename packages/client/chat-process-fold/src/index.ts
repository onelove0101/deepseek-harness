/**
 * chat-process-fold plugin, node half. The fold box ships via exports["./client"]; this half carries the
 * durable, live `enabled` toggle so the browser edits it through the Host settings document.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'

/** Stable plugin id, matching the package name. */
export const name = '@deepseek-ai/dsh-client-chat-process-fold'

/** Live fold preference. */
export interface Config {
  /** Whether the per-turn process fold box is enabled. */
  enabled: Volatile<boolean>
}

/** Live fold preference; the Settings row edits it without remounting. */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
})

/**
 * Keep the toggle out of the automatic plugin page: the General settings row owns it.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
