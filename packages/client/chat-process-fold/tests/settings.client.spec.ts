/**
 * ProcessFoldPolicy lives over the durable chat-process-fold settings scope:
 * defaults to enabled, adopts Host acceptance, and persists explicit choices.
 */
import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { ProcessFoldPolicy, type ChatProcessFoldSettings } from '../src/client/settings.ts'

describe('ProcessFoldPolicy', () => {
  it('defaults to enabled before Host settings arrive', () => {
    const stub = stubSettingsScope<ChatProcessFoldSettings>()
    const policy = new ProcessFoldPolicy(stub.scope)
    expect(policy.enabled.getSnapshot()).toBe(true)
  })

  it('adopts a Host-published disabled value', () => {
    const stub = stubSettingsScope<ChatProcessFoldSettings>()
    const policy = new ProcessFoldPolicy(stub.scope)
    stub.publish({ status: 'ready', value: { enabled: false } })
    expect(policy.enabled.getSnapshot()).toBe(false)
  })

  it('persists an explicit choice and skips redundant writes', () => {
    const stub = stubSettingsScope<ChatProcessFoldSettings>()
    const policy = new ProcessFoldPolicy(stub.scope)
    policy.setEnabled(false)
    expect(policy.enabled.getSnapshot()).toBe(false)
    expect(stub.set).toHaveBeenCalledWith('enabled', false)
    const before = stub.set.mock.calls.length
    policy.setEnabled(false)
    expect(stub.set.mock.calls.length).toBe(before)
  })
})
