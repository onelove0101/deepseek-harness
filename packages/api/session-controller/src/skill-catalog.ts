/** Session-addressed, cold-readable skill catalog Remote and the host-wide skill inventory. */

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SkillAddRequest,
  SkillInventoryEntry,
  SkillInventoryRequest,
  SkillInventoryValue,
  SkillListRequest,
  SkillListValue,
} from './types.ts'

/** Settings namespace holding the user's disabled skill names and added skill directories. */
const SKILLS_SETTINGS_NAMESPACE = 'skills'

/** Stored user skill preferences. */
interface SkillsSettings {
  disabled: string[]
  dirs: string[]
}

const SKILLS_SETTINGS_SCHEMA: z<SkillsSettings> = z.object({
  disabled: z.array(z.string()).default([]),
  dirs: z.array(z.string()).default([]),
})

/** Provider name of skills the user added from a directory. */
const USER_ADDED_PROVIDER = 'user-added'

/** Live handle over the settings-backed skill preferences. */
interface UserSkills {
  readonly scope: SettingsScope<SkillsSettings>
  /** Rescan the user-added directories. */
  readonly invalidate: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Session-addressed `skills` Remote namespace. */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
export class SessionSkillCatalog extends TypertRemoteService {
  static inject = ['agents', 'sessionQuery', 'typert', 'workingDirectory']

  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx: Context) {
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
    ctx.inject(['skills', 'settings'], (inner) => {
      const scope = inner.settings.register(SKILLS_SETTINGS_NAMESPACE, SKILLS_SETTINGS_SCHEMA, {
        base: { disabled: [], dirs: [] },
      })
      let invalidate!: () => void
      inner.skills.registerProvider((control) => {
        invalidate = control.invalidate
        return new FileSystemSkillProvider(
          inner,
          control,
          { providerName: USER_ADDED_PROVIDER, includeDefaultRoots: false, watch: false },
          { singleSkillDirs: () => scope.get().dirs },
        )
      })
      inner.effect(() => inner.skills.setHiddenNames(() => new Set(scope.get().disabled)), 'session-controller: hidden skills')
      inner.effect(() => scope.watch((next, prev) => {
        if (next.dirs.join('\n') !== prev.dirs.join('\n')) invalidate()
        inner.skills.notifyHiddenChanged()
      }), 'session-controller: skills settings watcher')
      this.user = { scope, invalidate: () => { invalidate() } }
      inner.effect(() => () => { this.user = undefined }, 'session-controller: user skills')
    })
  }

  private user: UserSkills | undefined

  /**
   * List every skill of the host composition, including skills the user disabled.
   * @param request - optional workspace directory whose project skill roots are included.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns skills sorted by name with their enabled state.
   * @throws RemoteError when no skill registry is mounted or discovery fails.
   */
  @Remote
  async inventory(request: SkillInventoryRequest, signal: AbortSignal): Promise<SkillInventoryValue> {
    const registry = this.ctx.get('skills')
    if (registry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: the host composition does not mount @deepseek-ai/dsh-skill',
        {},
      )
    }
    const disabled = new Set(this.user?.scope.get().disabled ?? [])
    try {
      const scope = await this.ctx.get('agentPresets')?.standingKeyFor(undefined)
      const skills = await registry.list({
        ...request.cwd === undefined ? {} : { cwd: request.cwd },
        scope,
        includeHidden: true,
        signal,
      })
      return {
        skills: skills.map((skill): SkillInventoryEntry => ({
          name: skill.name,
          description: skill.description,
          provider: skill.provider,
          source: skill.source,
          ...skill.path === undefined ? {} : { path: skill.path },
          enabled: !disabled.has(skill.name),
        })),
      }
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill inventory failed: ${String(error)}`, {})
    }
  }

  /**
   * Register a directory that contains `SKILL.md` as a user-added skill.
   * @param request - absolute directory path.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns the inventory after the directory was added.
   * @throws RemoteError when settings are unavailable, the path is not an absolute directory with a valid
   *   `SKILL.md`, or the directory is already registered.
   */
  @Remote
  async add(request: SkillAddRequest, signal: AbortSignal): Promise<SkillInventoryValue> {
    const user = this.user
    if (user === undefined) {
      throw new RemoteError('gateway/internal', 'skills cannot be added: no settings provider is mounted', {})
    }
    if (!isAbsolute(request.path)) {
      throw new RemoteError('gateway/bad-request', 'skill path must be absolute', {})
    }
    const dir = resolve(request.path)
    let file: string
    try {
      // Providers report the resolved path, so compare against that.
      file = await realpath(join(dir, 'SKILL.md'))
      if (!(await stat(file)).isFile()) throw new Error('not a file')
    } catch {
      throw new RemoteError('gateway/bad-request', `no SKILL.md found in ${dir}`, {})
    }
    const dirs = user.scope.get().dirs
    if (dirs.includes(dir)) {
      throw new RemoteError('gateway/bad-request', `${dir} is already added`, {})
    }
    await user.scope.update({ dirs: [...dirs, dir] })
    // The scope watcher runs asynchronously; the response below must already see the new directory.
    user.invalidate()
    const inventory = await this.inventory({}, signal)
    if (!inventory.skills.some(skill => skill.path === file)) {
      await user.scope.update({ dirs })
      user.invalidate()
      throw new RemoteError('gateway/bad-request', `${file} is not a valid skill (name and description are required)`, {})
    }
    return inventory
  }

  /**
   * List the user-invocable skills visible to one Session composition.
   * @param request - Session identity whose cwd and preset select the catalog view.
   * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
   * @returns user-invocable skill metadata without loading skill bodies.
   * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    const { sessionId } = request
    let cwd: string
    let agentPreset: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (observation.projections === undefined) {
        throw new Error('skill catalog requires a projected Session observation')
      }
      cwd = observation.projections.values.workingDirectory
        ?? observation.header.cwd
        ?? this.ctx.workingDirectory.defaultDirectory
      agentPreset = observation.projections.values.agentPreset ?? undefined
      const live = this.ctx.agents.get(sessionId)
      if (live !== undefined) cwd = await this.ctx.workingDirectory.ensure(live, signal)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }

    const live = this.ctx.agents.get(sessionId)
    const presets = this.ctx.get('agentPresets')
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    const skillRegistry = scoped ?? this.ctx.get('skills')
    if (skillRegistry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
        {},
      )
    }

    await using lease = live === undefined ? await this.scopeFor(agentPreset) : undefined
    const scope = live ?? lease?.key
    try {
      const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
      return {
        skills: skills.map(skill => ({
          name: skill.name,
          ...skill.path === undefined ? {} : { path: skill.path },
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable,
        })),
      }
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /** Resolve a live or standing preset scope without creating an Agent. */
  private async scopeFor(
    agentPreset: string | undefined,
  ): Promise<({ key: ScopeKey } & AsyncDisposable) | undefined> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.acquireScope(agentPreset)
    } catch {
      // An unknown or unusable recorded preset falls back to the global registry.
      return undefined
    }
  }
}

export default SessionSkillCatalog
