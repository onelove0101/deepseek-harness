/** Skills Settings page, browser half. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SKILLS_NS, SkillsController, type SkillsSettings } from './controller.ts'
import { SkillsSection } from './SkillsSection.tsx'
import { en, zh, type SkillsLocaleKey } from './locales.ts'

export type { SkillsFace, SkillsState, SkillRow } from './controller.ts'
export type { SkillsSectionProps } from './SkillsSection.tsx'
export type { SkillsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skills page copy. */
    'settings.skills': SkillsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.skills'

/** Services required by the Settings registration, the inventory Remote, and the settings scope. */
export const inject = ['slots', 'locale', 'remote', 'remote.skills', 'configForms']

/** Contribute the Skills page to Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-skills: dictionaries')

  const t = ctx.locale.bind(NS)
  const controller = new SkillsController(
    ctx.remote.skills,
    ctx.configForms.get<SkillsSettings>(SKILLS_NS),
  )
  ctx.effect(() => controller.start(), 'ui-settings-skills: controller')
  ctx.on('connection/reset', () => { void controller.reload() })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skills',
    order: 22,
    label: () => t('nav'),
    locale: NS,
    inject: () => controller.inject(),
  }, SkillsSection))
}
