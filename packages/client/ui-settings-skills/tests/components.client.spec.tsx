// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillsSection, type SkillsSectionProps } from '../src/client/SkillsSection.tsx'
import type { SkillsState } from '../src/client/controller.ts'
import { en, type SkillsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: SkillsLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key],
  )) as SkillsSectionProps['t']

const row = (name: string, enabled: boolean) => ({
  name, description: `${name} desc`, provider: 'filesystem', source: 'user-dsh', enabled,
})

function props(
  state: Partial<SkillsState>,
  actions: { setEnabled?: SkillsSectionProps['setEnabled']; add?: SkillsSectionProps['add']; load?: SkillsSectionProps['load'] } = {},
): SkillsSectionProps {
  const full: SkillsState = {
    phase: 'ready', rows: [], writable: true, error: undefined, adding: false, actionError: undefined, ...state,
  }
  return {
    t,
    setEnabled: actions.setEnabled ?? (async () => {}),
    add: actions.add ?? (async () => true),
    load: actions.load ?? (async () => {}),
    useSkills: ((select: (value: SkillsState) => unknown) => select(full)),
  } as unknown as SkillsSectionProps
}

describe('SkillsSection', () => {
  it('loads the inventory once on mount and warns when the load rejects', async () => {
    const load = vi.fn<SkillsSectionProps['load']>(async () => {})
    const view = render(<SkillsSection {...props({}, { load })} />)
    expect(load).toHaveBeenCalledTimes(1)
    view.rerender(<SkillsSection {...props({ rows: [row('alpha', true)] }, { load })} />)
    expect(load).toHaveBeenCalledTimes(1)
    cleanup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<SkillsSection {...props({}, { load: async () => { throw new Error('x') } })} />)
    await waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })

  it('lists skills with a switch reflecting each enabled state', () => {
    render(<SkillsSection {...props({ rows: [row('alpha', true), row('beta', false)] })} />)
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'alphaalpha descuser-dsh', 'betabeta descuser-dsh',
    ])
    expect(screen.getByRole('switch', { name: 'Enable alpha' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Enable beta' }).getAttribute('aria-checked')).toBe('false')
  })

  it('requests the opposite state when a switch is clicked, and warns on rejection', async () => {
    const setEnabled = vi.fn<SkillsSectionProps['setEnabled']>(async () => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<SkillsSection {...props({ rows: [row('alpha', true)] }, { setEnabled })} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable alpha' }))
    expect(setEnabled).toHaveBeenCalledWith('alpha', false)
    cleanup()
    setEnabled.mockRejectedValueOnce(new Error('x'))
    render(<SkillsSection {...props({ rows: [row('alpha', true)] }, { setEnabled })} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable alpha' }))
    await waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })

  it('disables controls when the settings document is read-only', () => {
    render(<SkillsSection {...props({ rows: [row('alpha', true)], writable: false })} />)
    expect((screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable alpha' })).disabled).toBe(true)
    expect((screen.getByRole<HTMLButtonElement>('button', { name: 'Add skill' })).disabled).toBe(true)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
  })

  it('shows loading, error, and empty states', () => {
    const view = render(<SkillsSection {...props({ phase: 'loading', writable: false })} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
    view.rerender(<SkillsSection {...props({ phase: 'error', error: 'boom' })} />)
    expect(screen.getByText('Could not read skills: boom')).toBeTruthy()
    view.rerender(<SkillsSection {...props({ phase: 'error', error: undefined })} />)
    expect(screen.getByText(/^Could not read skills:/)).toBeTruthy()
    view.rerender(<SkillsSection {...props({})} />)
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('adds a skill directory and closes the form on success', async () => {
    const add = vi.fn<SkillsSectionProps['add']>(async () => true)
    render(<SkillsSection {...props({}, { add })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    const input = screen.getByLabelText(en.addLabel)
    fireEvent.change(input, { target: { value: '  /skills/new  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(add).toHaveBeenCalledWith('/skills/new')
    await waitFor(() => { expect(screen.queryByLabelText(en.addLabel)).toBeNull() })
  })

  it('keeps the form open when the Host refuses, shows the failure, and can cancel', async () => {
    const add = vi.fn<SkillsSectionProps['add']>(async () => false)
    const view = render(<SkillsSection {...props({}, { add })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    const input = screen.getByLabelText(en.addLabel)
    fireEvent.change(input, { target: { value: '/bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => { expect(add).toHaveBeenCalled() })
    expect(screen.getByLabelText(en.addLabel)).toBeTruthy()
    view.rerender(<SkillsSection {...props({ actionError: 'no SKILL.md found' }, { add })} />)
    expect(screen.getByText('no SKILL.md found')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText(en.addLabel)).toBeNull()
  })

  it('ignores an empty path, other keys, and a submit while adding', () => {
    const add = vi.fn<SkillsSectionProps['add']>(async () => true)
    const view = render(<SkillsSection {...props({}, { add })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    const input = screen.getByLabelText(en.addLabel)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: '/x' } })
    fireEvent.keyDown(input, { key: 'a' })
    view.rerender(<SkillsSection {...props({ adding: true }, { add })} />)
    fireEvent.keyDown(screen.getByLabelText(en.addLabel), { key: 'Enter' })
    expect(add).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: en.adding })).toBeTruthy()
  })

  it('warns when the add request rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const add = vi.fn<SkillsSectionProps['add']>(async () => { throw new Error('x') })
    render(<SkillsSection {...props({}, { add })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    fireEvent.change(screen.getByLabelText(en.addLabel), { target: { value: '/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })
})
