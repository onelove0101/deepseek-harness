import { Context } from '@deepseek-ai/cordis'
import * as plugin from './dist/index.js'

const SKILLS_ROOT = '/Users/jdong/AI-D/AI-D-OB/Zuora/Dz-agent/skills'

// --- capture the plugin's pre-step listener via Cordis internal hook ---
const preStepListeners = []
const ctx = new Context()
ctx.on('internal/listener', (name, listener) => {
  if (name === 'agent/pre-step') preStepListeners.push(listener)
})

// --- stub services ---
let skillPaths = [SKILLS_ROOT]
let providerCreate = null
ctx.provide('settings', {
  register(ns, schema) {
    if (ns !== 'skill-injector') throw new Error('unexpected ns ' + ns)
    return {
      get: () => ({ skillPaths }),
      watch: () => () => {},
      update: async () => {},
      replace: async () => {},
    }
  },
})
ctx.provide('skills', {
  registerProvider(create) {
    providerCreate = create
    return () => {}
  },
})

// --- mount (await the plugin fiber activation) ---
await ctx.plugin(plugin, { enabled: true, maxBytes: 100000 })
console.log('mounted OK; apply ran:', typeof providerCreate === 'function')

// --- test provider discovery/load against the real directory ---
const control = { signal: new AbortController().signal, invalidate: () => {} }
const provider = providerCreate(control)
const candidates = await provider.list({})
console.log('provider.list() found skills:', candidates.length)
const names = candidates.map(c => c.name).join(', ')
console.log('names:', names)
if (candidates.some(c => c.name === 'jumpbox-access') === false) {
  console.error('FAIL: expected jumpbox-access among candidates'); process.exit(1)
}
const one = candidates.find(c => c.name === 'jumpbox-access')
const def = await provider.get(one, {})
console.log('jumpbox-access body length:', (def?.content ?? '').length, '| desc:', JSON.stringify(def?.description))

// --- test pre-step injection ---
const listener = preStepListeners[preStepListeners.length - 1]
if (!listener) { console.error('FAIL: no pre-step listener captured'); process.exit(1) }
const payload = {
  agent: { session: { id: { toString: () => 'sess-1' } } },
  messages: [],
  turn: 1, step: 1,
  signal: new AbortController().signal,
}
const decided = await listener(payload, async () => ({ kind: 'enter', messages: [] }))
const injected = decided.messages?.find(m => m?.content?.[0]?.text?.includes('<configured_skills'))
console.log('injected message present:', Boolean(injected))
console.log('injected count tag:', injected?.content?.[0]?.text?.match(/count="(\d+)"/)?.[1])
console.log('source kind:', injected?.source?.kind)
if (!injected) { console.error('FAIL: auto-inject did not fire'); process.exit(1) }

// --- second session + same-session dedup ---
const decided2 = await listener({ ...payload, agent: { session: { id: { toString: () => 'sess-2' } } } }, async () => ({ kind: 'enter', messages: [] }))
console.log('second NEW session injected:', Boolean(decided2.messages?.find(m => m?.content?.[0]?.text?.includes('<configured_skills'))))
const decided3 = await listener(payload, async () => ({ kind: 'enter', messages: [] }))
console.log('SAME session re-inject suppressed:', decided3.messages?.length === 0)

console.log('ALL OK')
