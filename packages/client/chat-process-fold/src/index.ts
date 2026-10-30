/**
 * chat-process-fold plugin, node half. The browser-only fold box ships via
 * exports["./client"]; this half exists so the Loader mounts a named row and
 * carries no Host behavior.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable plugin id, matching the package name. */
export const name = '@deepseek-ai/dsh-client-chat-process-fold'

/**
 * Register an empty Host contribution.
 * @param _ctx - Host context (unused; every feature is browser-side).
 */
export function apply(_ctx: Context): void {
  // Intentionally empty: the process fold is a browser-only surface.
}
