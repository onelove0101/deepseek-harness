/** Experts Settings page and the leading `@` mention source, browser half. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ExpertsController } from './controller.ts'
import { ExpertsSection } from './ExpertsSection.tsx'
import { en, zh, type ExpertLocaleKey } from './locales.ts'
import { leadingMentionEdit, soulExcerpt, type LeadingMentionEdit } from './mention.ts'

export type { ExpertsFace, ExpertsState, ExpertsRemote, ExpertSkillsRemote } from './controller.ts'
export type { ExpertsSectionProps } from './ExpertsSection.tsx'
export type { ExpertLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Experts page copy. */
    'settings.experts': ExpertLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.experts'

/** Expert names are normalized by the Host and safe to preserve in an opaque flyout payload. */
const EXPERT_NAME = /^[a-z][a-z0-9-]*$/

/** Preserve the exact catalog response that produced a flyout row. */
function catalogValue(names: readonly string[]): string {
  return JSON.stringify(names)
}

/** Recover a response-local catalog without granting malformed data replacement authority. */
function catalogFromValue(value: string | undefined, selected: string): ReadonlySet<string> {
  if (value === undefined) {
    return new Set()
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length > 50 || !parsed.every(name => typeof name === 'string' && EXPERT_NAME.test(name))) {
      return new Set()
    }
    const names = new Set(parsed)
    return names.has(selected) ? names : new Set()
  } catch (_error: unknown) {
    return new Set()
  }
}

/** Services required by the Settings registration, both Remotes, the `@` source, and the Add menu's Expert flyout. */
export const inject = ['slots', 'locale', 'remote', 'remote.experts', 'remote.skills', 'inputTriggers', 'sessions', 'commandUi']

/**
 * Contribute the Experts page to Settings and register the `@` mention source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-expert: dictionaries')

  const t = ctx.locale.bind(NS)
  const controller = new ExpertsController(ctx.remote.experts, ctx.remote.skills)
  ctx.effect(() => controller.start(), 'ui-expert: controller')
  ctx.on('connection/reset', () => { void controller.reload() })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'experts',
    order: 23,
    label: () => t('nav'),
    locale: NS,
    inject: () => controller.inject(),
  }, ExpertsSection))

  const source: InputTriggerSource = {
    trigger: '@',
    name: 'expert',
    order: -1,
    async candidates(_session, { query, position, signal }) {
      // The host recognizes only a leading mention, so an inline `@` never offers Experts.
      if (position !== 'leading') {
        return []
      }
      const experts = await controller.rankedExperts(signal)
      if (signal.aborted) {
        return []
      }
      const normalizedQuery = query.toLowerCase()
      return experts.filter(expert => expert.name.toLowerCase().includes(normalizedQuery)).map(expert => ({
        name: expert.name,
        description: soulExcerpt(expert.soul),
      }))
    },
    onPick({ candidate }) {
      return { text: `@${candidate.name} ` }
    },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-expert: source')

  // The Add menu's Expert row lists the Host-ranked Experts in a flyout; a
  // pick inserts the same leading mention as the `@` menu and never sends.
  const command = ctx.get('commandUi') as CommandUiContract
  const sessions = ctx.sessions
  const insertAtStart = (sessionId: SessionId, edit: (draft: string) => LeadingMentionEdit): void => {
    const actx = sessions.scope(sessionId)
    const conversation = actx?.get('conversation')
    if (actx === undefined || conversation === undefined) {
      throw new Error('the composer for this session is unavailable')
    }
    const input = conversation.input.for(actx).state.getSnapshot()
    const { text, end } = edit(input.draft)
    const applied = actx.bail(actx, 'slash/input-insert-text', { text, span: { start: 0, end, draftRev: input.draftRev } })
    if (applied !== true) {
      throw new Error('the draft changed before the Expert could be inserted')
    }
  }
  ctx.effect(() => command.registerAdd({
    name: 'expert',
    label: () => t('addLabel'),
    description: () => t('addDescription'),
    icon: IconAgentPresetOutline16,
    available: session => sessions.subagentAddress(session.sessionId) === undefined,
    flyout: {
      options: async (_session, signal) => {
        const experts = await controller.rankedExperts(signal)
        const value = catalogValue(experts.map(expert => expert.name))
        return experts.map(expert => ({ id: expert.name, label: expert.name, value, detail: soulExcerpt(expert.soul) }))
      },
      onSelect: (option, session) => {
        const known = catalogFromValue(option.value, option.id)
        insertAtStart(session.sessionId, draft => leadingMentionEdit(draft, option.id, known))
      },
    },
  }), 'ui-expert: Add menu Expert row')
}
