/**
 * skill-injector-plugin — auto-load configured external skills into memory.
 *
 * Reads the `skillPaths` config field, which names the
 * directories whose skills should be available. It does two things:
 *
 *  1. Registers the discovered skills as a standard `ctx.skills` provider, so
 *     they also appear in the DSH skill catalog and can be loaded with the
 *     `skill` tool.
 *  2. At the first `agent/pre-step` of each new session, reads the full body
 *     of every configured-path skill and injects it as one durable
 *     `<system-reminder>` user message — so the agent already has the skill
 *     instructions in memory and needs no per-session prompting.
 *
 * @module skill-injector-plugin
 */

import { basename, dirname, join } from 'node:path'
import { readFile, readdir, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillProvider,
} from '@deepseek-ai/dsh-skill'

/** Durable message source tag for the auto-loaded skill payload. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-injector-memory': {
      kind: 'skill-injector-memory'
      form: 'instructions'
      paths: readonly string[]
      count: number
    }
  }
}

/** Cordis plugin identity. */
export const name = 'skill-injector-plugin'

/** Services this plugin requires to mount. */
export const inject = ['skills']

/** Plugin configuration (set in the profile's cordis.patch.yml). */
export interface Config {
  /** Master switch; when false the plugin loads but does nothing. */
  enabled?: boolean
  /** Upper byte budget for the auto-loaded memory message. */
  maxBytes?: number
  /** Directories whose skills should be discovered and injected. */
  skillPaths?: string[]
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  maxBytes: Schema.number().default(131072),
  skillPaths: Schema.array(Schema.string()).default([]),
})

const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/** A skill discovered under a configured root. */
interface DiscoveredSkill {
  name: string
  description: string
  content: string
  /** Path to the instruction file actually read. */
  path: string
  /** Directory that owns the skill (resource base). */
  dir: string
}

/** Strip one leading YAML-style `---` frontmatter block and read `name`/`description`. */
function parseFrontmatter(raw: string): { body: string; name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (match === null) {
    return { body: raw }
  }
  const full = match[0]
  const front = match[1]
  if (full === undefined || front === undefined) {
    return { body: raw }
  }
  const fields: Record<string, string> = {}
  for (const line of front.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '')
    if (value !== '') fields[key] = value
  }
  return {
    body: raw.slice(full.length).replace(/^\s+/, ''),
    name: fields.name,
    description: fields.description,
  }
}

/** Read one candidate file, or `undefined` when it does not exist or cannot be read. */
async function readSkillBody(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Build a {@link DiscoveredSkill} from an instruction file, deriving the name
 * from frontmatter with the caller's filename fallback.
 */
async function skillFromFile(file: string, fallbackName: string): Promise<DiscoveredSkill | undefined> {
  const raw = await readSkillBody(file)
  if (raw === undefined) return undefined
  const { body, name, description } = parseFrontmatter(raw)
  const strip = body.trim()
  if (strip === '') return undefined
  return {
    name: (name ?? fallbackName).trim(),
    description: (description ?? `Skill loaded from ${file}`).trim(),
    content: strip,
    path: file,
    dir: dirname(file),
  }
}

/**
 * Discover skills under one configured root. A root is either itself a skill
 * (has `SKILL.md`/`README.md` or is a `.md` file) or a directory of skills
 * (subdirectories with `SKILL.md`/`README.md`, plus flat `.md` files).
 */
async function discoverInRoot(root: string): Promise<DiscoveredSkill[]> {
  const found: DiscoveredSkill[] = []
  let statResult
  try {
    statResult = await stat(root)
  } catch {
    return found
  }
  if (statResult.isFile()) {
    const name = basename(root).replace(/\.md$/i, '')
    const skill = await skillFromFile(root, name)
    if (skill !== undefined) found.push(skill)
    return found
  }
  if (!statResult.isDirectory()) return found

  // A single-skill directory: `<root>/SKILL.md` or `<root>/README.md`.
  const ownSkill = (await skillFromFile(join(root, 'SKILL.md'), basename(root)))
    ?? await skillFromFile(join(root, 'README.md'), basename(root))
  if (ownSkill !== undefined) {
    found.push(ownSkill)
    return found
  }

  // Otherwise the root is a collection; scan its direct children one level deep.
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skill = (await skillFromFile(join(root, entry.name, 'SKILL.md'), entry.name))
        ?? await skillFromFile(join(root, entry.name, 'README.md'), entry.name)
      if (skill !== undefined) found.push(skill)
    } else if (entry.isFile() && /\.md$/i.test(entry.name) && entry.name.toLowerCase() !== 'readme.md') {
      const skill = await skillFromFile(join(root, entry.name), entry.name.replace(/\.md$/i, ''))
      if (skill !== undefined) found.push(skill)
    }
  }
  return found
}

/** Discover all skills across the configured roots. */
async function discoverSkills(paths: readonly string[]): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = []
  for (const root of paths) {
    out.push(...await discoverInRoot(root))
  }
  return out
}

const PROVIDER_NAME = 'skill-injector-configured'

const INVOCATION = { modelInvocable: true, userInvocable: true } as const

/** Escape a literal closing tag so skill content cannot close our frame. */
function escapeFrame(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

/** Render all configured skills into one bounded `<system-reminder>` message. */
function renderInjection(skills: readonly DiscoveredSkill[], maxBytes: number): string | undefined {
  const sections = skills.map(skill => {
    return [
      `<skill name="${skill.name}">`,
      `Source: ${skill.path}`,
      '',
      escapeFrame(skill.content),
      `</skill>`,
    ].join('\n')
  })
  const text = [
    '<system-reminder>',
    'The following configured skills were auto-loaded into memory at the start of this session. Apply their instructions in this session without being prompted to load them.',
    '',
    `<configured_skills count="${skills.length}">`,
    ...sections,
    '</configured_skills>',
    ...(Buffer.byteLength(sections.join('\n'), 'utf8') > maxBytes
      ? ['', 'Some skill bodies were truncated to fit the configured byte budget.']
      : []),
    '</system-reminder>',
  ].join('\n')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  // Truncate the whole payload at a code-point-boundary within the budget.
  const bytes = Buffer.from(text, 'utf8')
  let end = Math.min(bytes.length, Math.max(64, Math.trunc(maxBytes)))
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return `${bytes.subarray(0, end).toString('utf8')}\n</system-reminder>`
}

/** Register lifecycle, provider, and per-session injection behavior. */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const maxBytes = config.maxBytes ?? 131072

  const skillPaths = config.skillPaths ?? []

  // 1. Standard skill provider over the configured roots.
  const disposeProvider = ctx.skills.registerProvider(() => {
    const provider: SkillProvider = {
      name: PROVIDER_NAME,
      async list() {
        const paths = skillPaths
        const skills = await discoverSkills(paths)
        return skills.map<SkillCandidate>(skill => ({
          name: skill.name,
          description: skill.description,
          invocation: INVOCATION,
          rank: 100,
          provider: PROVIDER_NAME,
          source: 'custom',
          resourceBase: { kind: 'directory', path: skill.dir },
          locator: { path: skill.path, name: skill.name },
        }))
      },
      async get(candidate): Promise<SkillDefinition | undefined> {
        const locator = candidate.locator as { path: string; name: string }
        const skill = await skillFromFile(locator.path, locator.name)
        if (skill === undefined) return undefined
        return {
          name: skill.name,
          description: skill.description,
          invocation: INVOCATION,
          provider: PROVIDER_NAME,
          source: 'custom',
          resourceBase: { kind: 'directory', path: skill.dir },
          content: skill.content,
        }
      },
    }
    return provider
  })

  // 2. Auto-load into memory at the first step of each new session.
  const injected = new Set<string>()
  ctx.on('agent/pre-step', async (
    { agent, signal }: { agent: Agent; signal: AbortSignal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const sessionKey = String(agent.session.id)
    if (injected.has(sessionKey)) return decision
    signal.throwIfAborted()
    const paths = skillPaths
    if (paths.length === 0) return decision
    const skills = (await discoverSkills(paths)).filter(skill => skill.name !== '')
    if (skills.length === 0) return decision
    signal.throwIfAborted()
    const text = renderInjection(skills, maxBytes)
    if (text === undefined) return decision
    injected.add(sessionKey)
    const memory = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'skill-injector-memory',
        form: 'instructions',
        paths,
        count: skills.length,
      },
    })
    return { ...decision, messages: [...decision.messages, memory] }
  })

  ctx.effect(() => () => {
    disposeProvider()
  })
}
