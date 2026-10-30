import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
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

async function bench(withSettings: boolean) {
  const home = await tempDir()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  const settings = withSettings
    ? ctx.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
    : undefined
  await settings
  const catalog = new SessionSkillCatalog(ctx)
  return { ctx, catalog, home, settings }
}

describe('SessionSkillCatalog inventory and add', () => {
  it('adds a skill directory, lists it enabled, and hides it once disabled', async () => {
    const { ctx, catalog, home } = await bench(true)
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
    expect(ctx.settings.get('skills')).toMatchObject({ dirs: [dir], disabled: [] })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['my-skill'])

    await ctx.settings.update('skills', { disabled: ['my-skill'] })
    await new Promise(resolve => setImmediate(resolve))
    expect((await catalog.inventory({}, signal)).skills.map(skill => [skill.name, skill.enabled])).toEqual([['my-skill', false]])
    expect(await ctx.skills.list()).toEqual([])
    expect(await ctx.skills.get('my-skill')).toBeUndefined()
    expect((await ctx.skills.list({ includeHidden: true })).map(skill => skill.name)).toEqual(['my-skill'])
  })

  it('refuses relative paths, missing SKILL.md, invalid skills, and duplicates', async () => {
    const { ctx, catalog, home } = await bench(true)
    await expect(catalog.add({ path: 'relative/dir' }, signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(catalog.add({ path: join(home, 'missing') }, signal)).rejects.toThrow(/no SKILL.md found/)
    const invalid = await skillDir(home, 'invalid', 'no frontmatter')
    await expect(catalog.add({ path: invalid }, signal)).rejects.toThrow(/not a valid skill/)
    expect(ctx.settings.get('skills')).toMatchObject({ dirs: [] })

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

  it('stops using the settings scope when the provider goes away', async () => {
    const { catalog, home, settings } = await bench(true)
    const dir = await skillDir(home, 'my-skill')
    await settings?.dispose()
    await expect(catalog.add({ path: dir }, signal)).rejects.toThrow(/no settings provider/)
  })
})
