import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionSkillCatalog } from '../src/skill-catalog.ts'

const dirs: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-inventory-'))
  dirs.push(dir)
  return dir
}

async function skillDir(root: string, name: string, body = `---\nname: ${name}\ndescription: ${name} description\n---\nBody.\n`) {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), body)
  return dir
}

/** Skill preferences the registry reads per lookup, with a settings stand-in that writes them like the Host document. */
async function bench(withSettings: boolean) {
  const home = await tempDir()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const prefs = { disabled: [] as string[], dirs: [] as string[] }
  // The Loader would resolve these through the Config schema; the registry reads the live references per lookup.
  new SkillRegistry(ctx, { disabled: { get: () => prefs.disabled }, dirs: { get: () => prefs.dirs } })
  const settings = withSettings
    ? ctx.provide('settings', {
      update: async (ns: string, patch: Partial<typeof prefs>) => {
        Object.assign(prefs, patch)
        ctx.emit('settings/document-updated', ns as never, 1)
      },
    } as never)
    : undefined
  const catalog = new SessionSkillCatalog(ctx)
  return { ctx, catalog, home, prefs, settings }
}

describe('SessionSkillCatalog inventory and add', () => {
  it('adds a skill directory, lists it enabled, and hides it once disabled', async () => {
    const { ctx, catalog, home, prefs } = await bench(true)
    expect((await catalog.inventory({}, signal)).skills).toEqual([])

    const dir = await skillDir(home, 'my-skill')
    const added = await catalog.add({ path: dir }, signal)
    expect(added.skills).toEqual([{
      name: 'my-skill',
      description: 'my-skill description',
      provider: 'user-added',
      source: 'custom',
      path: await realpath(join(dir, 'SKILL.md')),
      enabled: true,
    }])
    expect(prefs).toMatchObject({ dirs: [dir], disabled: [] })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['my-skill'])

    prefs.disabled = ['my-skill']
    ctx.skills.notifyHiddenChanged()
    expect((await catalog.inventory({}, signal)).skills.map(skill => [skill.name, skill.enabled])).toEqual([['my-skill', false]])
    expect(await ctx.skills.list()).toEqual([])
    expect(await ctx.skills.get('my-skill')).toBeUndefined()
    expect((await ctx.skills.list({ includeHidden: true })).map(skill => skill.name)).toEqual(['my-skill'])
  })

  it('refuses relative paths, missing SKILL.md, invalid skills, and duplicates', async () => {
    const { catalog, home, prefs } = await bench(true)
    await expect(catalog.add({ path: 'relative/dir' }, signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(catalog.add({ path: join(home, 'missing') }, signal)).rejects.toThrow(/no SKILL.md found/)
    const invalid = await skillDir(home, 'invalid', 'no frontmatter')
    await expect(catalog.add({ path: invalid }, signal)).rejects.toThrow(/not a valid skill/)
    expect(prefs).toMatchObject({ dirs: [] })

    const good = await skillDir(home, 'good')
    await catalog.add({ path: good }, signal)
    await expect(catalog.add({ path: good }, signal)).rejects.toThrow(/already added/)
  })

  it('reports a missing settings provider and a missing registry', async () => {
    const { catalog, home } = await bench(false)
    const dir = await skillDir(home, 'my-skill')
    await expect(catalog.add({ path: dir }, signal)).rejects.toThrow(/no settings provider/)
    expect((await catalog.inventory({}, signal)).skills).toEqual([])

    const bare = new Context()
    await bare.plugin(SessionStore)
    await bare.plugin(AgentRegistry)
    const noRegistry = new SessionSkillCatalog(bare)
    await expect(noRegistry.inventory({}, signal)).rejects.toThrow(/skill registry is absent/)
  })

  it('wraps discovery failures', async () => {
    const { ctx, catalog } = await bench(true)
    ctx.skills.list = () => Promise.reject(new Error('disk gone'))
    await expect(catalog.inventory({}, signal)).rejects.toThrow(/skill inventory failed: Error: disk gone/)
  })

  it('lists skills without a file path and passes the workspace cwd to discovery', async () => {
    const { ctx, catalog, home } = await bench(true)
    ctx.skills.register({ name: 'virtual', description: 'Runtime skill.', content: 'Body.', source: 'runtime' })
    const list = ctx.skills.list.bind(ctx.skills)
    const seen: Array<string | undefined> = []
    ctx.skills.list = (options) => { seen.push(options?.cwd); return list(options) }
    const { skills } = await catalog.inventory({ cwd: home }, signal)
    expect(skills).toEqual([{ name: 'virtual', description: 'Runtime skill.', provider: 'runtime', source: 'runtime', enabled: true }])
    expect(seen).toEqual([home])
  })

  it('refuses a SKILL.md that is not a file', async () => {
    const { catalog, home } = await bench(true)
    const dir = join(home, 'odd')
    await mkdir(join(dir, 'SKILL.md'), { recursive: true })
    await expect(catalog.add({ path: dir }, signal)).rejects.toThrow(/no SKILL.md found/)
  })
})
