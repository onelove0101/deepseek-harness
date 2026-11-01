// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExpertDocumentId, ExpertKnowledgeBaseId, ExpertLibraryValue, ExpertValue } from '@deepseek-ai/dsh-api-remotes/client'
import { ExpertsSection, type ExpertsSectionProps } from '../src/client/ExpertsSection.tsx'
import type { ExpertsState } from '../src/client/controller.ts'
import { en, type ExpertLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: ExpertLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key],
  )) as ExpertsSectionProps['t']

const limits = {
  maxExperts: 5, maxSoulBytes: 100, maxSkillsPerExpert: 3, maxDocuments: 5, maxDocumentBytes: 100,
  maxKnowledgeBases: 5, maxDocumentsPerKnowledgeBase: 5, maxLibraryBytes: 500, maxInvocationLibraryBytes: 200,
}

const doc = (id: string, title: string, bytes = 10) => ({ id: id as ExpertDocumentId, title, bytes, createdAt: 1 })

const expert = (name: string, patch: Partial<ExpertValue> = {}): ExpertValue => ({
  id: `id-${name}` as ExpertValue['id'], name, enabled: true, soul: `${name} soul`, skills: [], documentIds: [],
  knowledgeBaseIds: [], createdAt: 1, updatedAt: 1, ...patch,
})

const library = (patch: Partial<ExpertLibraryValue> = {}): ExpertLibraryValue => ({
  experts: [], documents: [], knowledgeBases: [], limits, ...patch,
})

type Actions = Partial<Pick<ExpertsSectionProps,
  'load' | 'saveExpert' | 'deleteExpert' | 'createDocument' | 'deleteDocument' | 'saveKnowledgeBase' | 'deleteKnowledgeBase'>>

function props(state: Partial<ExpertsState>, actions: Actions = {}): ExpertsSectionProps {
  const full: ExpertsState = {
    phase: 'ready', library: library(), skills: [], error: undefined, busy: false, actionError: undefined, ...state,
  }
  return {
    t,
    load: actions.load ?? (async () => {}),
    saveExpert: actions.saveExpert ?? (async () => true),
    deleteExpert: actions.deleteExpert ?? (async () => true),
    createDocument: actions.createDocument ?? (async () => true),
    deleteDocument: actions.deleteDocument ?? (async () => true),
    saveKnowledgeBase: actions.saveKnowledgeBase ?? (async () => true),
    deleteKnowledgeBase: actions.deleteKnowledgeBase ?? (async () => true),
    useExperts: ((select: (value: ExpertsState) => unknown) => select(full)),
  } as unknown as ExpertsSectionProps
}

const logErrorSilently = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('ExpertsSection roster', () => {
  it('loads once on mount and warns when the load rejects', async () => {
    const load = vi.fn<ExpertsSectionProps['load']>(async () => {})
    render(<ExpertsSection {...props({}, { load })} />)
    expect(load).toHaveBeenCalledTimes(1)
    cleanup()
    const warn = logErrorSilently()
    render(<ExpertsSection {...props({}, { load: async () => { throw new Error('x') } })} />)
    await waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })

  it('shows loading, empty, and failure states, and retries a failed load', async () => {
    render(<ExpertsSection {...props({ phase: 'loading', library: undefined })} />)
    expect(screen.getByText('Reading Experts…')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New Expert' }).disabled).toBe(true)
    cleanup()
    render(<ExpertsSection {...props({})} />)
    expect(screen.getByText('No Experts yet.')).toBeTruthy()
    cleanup()
    const load = vi.fn<ExpertsSectionProps['load']>(async () => {})
    render(<ExpertsSection {...props({ phase: 'error', library: undefined, error: 'offline' }, { load })} />)
    expect(screen.getByText(/Could not read Experts: offline/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(load).toHaveBeenCalledTimes(2)
    cleanup()
    const warn = logErrorSilently()
    const rejecting = vi.fn<ExpertsSectionProps['load']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('x'))
    render(<ExpertsSection {...props({ phase: 'error', library: undefined, error: 'offline' }, { load: rejecting })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })

  it('renders a failed load without a reason as an empty reason', () => {
    render(<ExpertsSection {...props({ phase: 'error', library: undefined, error: undefined })} />)
    expect(screen.getByText(/Could not read Experts:/)).toBeTruthy()
  })

  it('shows an action failure', () => {
    render(<ExpertsSection {...props({ actionError: 'name taken' })} />)
    expect(screen.getByText('name taken')).toBeTruthy()
  })

  it('lists Experts with a summary, a disabled badge, and the enable switch', async () => {
    const saveExpert = vi.fn<ExpertsSectionProps['saveExpert']>(async () => true)
    const alpha = expert('alpha', { skills: ['review'], documentIds: ['d1' as ExpertDocumentId] })
    const beta = expert('beta', { enabled: false })
    render(<ExpertsSection {...props({ library: library({ experts: [alpha, beta] }) }, { saveExpert })} />)
    expect(screen.getByText('@alpha')).toBeTruthy()
    expect(screen.getByText('1 skills · 1 documents · 0 knowledge bases')).toBeTruthy()
    expect(screen.getByText('Disabled')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Enable @alpha' }))
    expect(saveExpert).toHaveBeenLastCalledWith({
      id: alpha.id, name: 'alpha', enabled: false, soul: 'alpha soul', skills: ['review'],
      documentIds: ['d1'], knowledgeBaseIds: [],
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable @beta' }))
    expect(saveExpert).toHaveBeenLastCalledWith(expect.objectContaining({ id: beta.id, enabled: true }))
  })

  it('warns when a toggle or delete is rejected', async () => {
    const warn = logErrorSilently()
    const saveExpert = vi.fn<ExpertsSectionProps['saveExpert']>(async () => { throw new Error('x') })
    const deleteExpert = vi.fn<ExpertsSectionProps['deleteExpert']>(async () => { throw new Error('y') })
    render(<ExpertsSection {...props({ library: library({ experts: [expert('alpha')] }) }, { saveExpert, deleteExpert })} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable @alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete @alpha' }))
    await waitFor(() => { expect(warn).toHaveBeenCalledTimes(2) })
    expect(deleteExpert).toHaveBeenCalledWith('id-alpha')
    warn.mockRestore()
  })

  it('disables row actions while a mutation is in flight', () => {
    render(<ExpertsSection {...props({ busy: true, library: library({ experts: [expert('alpha')] }) })} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit @alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delete @alpha' }).disabled).toBe(true)
  })
})

describe('open Expert form conflicts', () => {
  const stocked = library({
    documents: [doc('d1', 'Guide')],
    knowledgeBases: [{
      id: 'k1' as ExpertKnowledgeBaseId, name: 'Handbook', documentIds: ['d1' as ExpertDocumentId], createdAt: 1, updatedAt: 1,
    }],
    experts: [expert('alpha', { documentIds: ['d1' as ExpertDocumentId], knowledgeBaseIds: ['k1' as ExpertKnowledgeBaseId] })],
  })

  it('disables library deletes and roster toggles while a form is open, and restores them on cancel', () => {
    render(<ExpertsSection {...props({ library: stocked })} />)
    const controls = (): HTMLElement[] => [
      screen.getByRole('button', { name: 'Delete document Guide' }),
      screen.getByRole('button', { name: 'Delete knowledge base Handbook' }),
      screen.getByRole('switch', { name: 'Enable @alpha' }),
    ]
    const disabled = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled
    expect(controls().map(disabled)).toEqual([false, false, false])
    fireEvent.click(screen.getByRole('button', { name: 'Edit @alpha' }))
    expect(controls().map(disabled)).toEqual([true, true, true])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(controls().map(disabled)).toEqual([false, false, false])
    fireEvent.click(screen.getByRole('button', { name: 'New Expert' }))
    expect(controls().map(disabled)).toEqual([true, true, true])
  })

  it('does not call the library delete or toggle actions while a form is open', () => {
    const deleteDocument = vi.fn<ExpertsSectionProps['deleteDocument']>(async () => true)
    const saveExpert = vi.fn<ExpertsSectionProps['saveExpert']>(async () => true)
    render(<ExpertsSection {...props({ library: stocked }, { deleteDocument, saveExpert })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit @alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete document Guide' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Enable @alpha' }))
    expect(deleteDocument).not.toHaveBeenCalled()
    expect(saveExpert).not.toHaveBeenCalled()
  })
})

describe('ExpertForm', () => {
  const stocked = library({
    documents: [doc('d1', 'Guide'), doc('d2', 'Policy')],
    knowledgeBases: [{
      id: 'k1' as ExpertKnowledgeBaseId, name: 'Handbook', documentIds: ['d1' as ExpertDocumentId], createdAt: 1, updatedAt: 1,
    }],
  })

  it('creates an Expert from the typed fields and the checked selections, then closes', async () => {
    const saveExpert = vi.fn<ExpertsSectionProps['saveExpert']>(async () => true)
    render(<ExpertsSection {...props({ library: stocked, skills: ['review', 'plan'] }, { saveExpert })} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Expert' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: ' tester ' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Soul' }), { target: { value: 'Be strict.' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'review' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'plan' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'plan' }))
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Guide' })[0]!)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull() })
    expect(saveExpert).toHaveBeenCalledWith({
      name: 'tester', enabled: false, soul: 'Be strict.', skills: ['review'],
      documentIds: ['d1'], knowledgeBaseIds: ['k1'],
    })
  })

  it('keeps the form open when the save is refused', async () => {
    const saveExpert = vi.fn<ExpertsSectionProps['saveExpert']>(async () => false)
    render(<ExpertsSection {...props({ library: stocked }, { saveExpert })} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Expert' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'tester' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(saveExpert).toHaveBeenCalled() })
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy()
  })

  it('warns when the save rejects', async () => {
    const warn = logErrorSilently()
    const saveExpert = vi.fn<ExpertsSectionProps['saveExpert']>(async () => { throw new Error('x') })
    render(<ExpertsSection {...props({ library: stocked }, { saveExpert })} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Expert' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'tester' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })

  it('edits an existing Expert with its current values and keeps its id', async () => {
    const saveExpert = vi.fn<ExpertsSectionProps['saveExpert']>(async () => true)
    const existing = expert('alpha', { skills: ['review'], documentIds: ['d2' as ExpertDocumentId] })
    render(<ExpertsSection {...props({ library: { ...stocked, experts: [existing] }, skills: ['review'] }, { saveExpert })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit @alpha' }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('alpha')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'review' }).checked).toBe(true)
    expect((screen.getAllByRole<HTMLInputElement>('checkbox', { name: 'Policy' })[0]!).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(saveExpert).toHaveBeenCalled() })
    expect(saveExpert).toHaveBeenCalledWith(expect.objectContaining({ id: existing.id, name: 'alpha', skills: ['review'] }))
  })

  it('keeps unavailable selected skills visible and removable', async () => {
    const saveExpert = vi.fn<ExpertsSectionProps['saveExpert']>(async () => true)
    const existing = expert('alpha', { skills: ['review', 'gone'] })
    render(<ExpertsSection {...props({ library: { ...stocked, experts: [existing] }, skills: ['review'] }, { saveExpert })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit @alpha' }))
    const gone = screen.getByRole<HTMLInputElement>('checkbox', { name: 'gone (unavailable)' })
    expect(gone.checked).toBe(true)
    expect(screen.queryByRole('checkbox', { name: 'review (unavailable)' })).toBeNull()
    fireEvent.click(gone)
    expect(screen.queryByRole('checkbox', { name: 'gone (unavailable)' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(saveExpert).toHaveBeenCalled() })
    expect(saveExpert).toHaveBeenCalledWith(expect.objectContaining({ skills: ['review'] }))
  })

  it('does not show the empty skills note while an unavailable skill is still selected', () => {
    const existing = expert('alpha', { skills: ['gone'] })
    render(<ExpertsSection {...props({ library: { ...stocked, experts: [existing] }, skills: [] })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit @alpha' }))
    expect(screen.queryByText('No skills are available to select.')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'gone (unavailable)' }))
    expect(screen.getByText('No skills are available to select.')).toBeTruthy()
  })

  it('cancels, and shows empty-selection notes and the busy label', () => {
    render(<ExpertsSection {...props({ library: library(), busy: true })} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Expert' }))
    expect(screen.getByText('No skills are available to select.')).toBeTruthy()
    expect(screen.getByText('The library has no documents yet.')).toBeTruthy()
    expect(screen.getByText('No knowledge bases yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy()
    cleanup()
    render(<ExpertsSection {...props({ library: library() })} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Expert' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull()
  })
})

describe('LibraryPanel', () => {
  const stocked = library({
    documents: [doc('d1', 'Guide', 12), doc('d2', 'Policy', 8)],
    knowledgeBases: [{
      id: 'k1' as ExpertKnowledgeBaseId, name: 'Handbook', documentIds: ['d1' as ExpertDocumentId], createdAt: 1, updatedAt: 1,
    }],
  })

  it('shows documents, knowledge bases, and the library usage', () => {
    render(<ExpertsSection {...props({ library: stocked })} />)
    expect(screen.getByText('20 / 500 bytes')).toBeTruthy()
    expect(screen.getByText('12 bytes')).toBeTruthy()
    expect(screen.getByText('1 documents')).toBeTruthy()
  })

  it('stores a pasted text document and clears the fields', async () => {
    const createDocument = vi.fn<ExpertsSectionProps['createDocument']>(async () => true)
    render(<ExpertsSection {...props({ library: stocked }, { createDocument })} />)
    const add = screen.getByRole('button', { name: 'Save document' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Document title' }), { target: { value: ' Notes ' } })
    expect(add.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Document text' }), { target: { value: 'hello' } })
    fireEvent.click(add)
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Document title' }).value).toBe('') })
    expect(createDocument).toHaveBeenCalledWith({ title: 'Notes', text: 'hello' })
  })

  it('keeps the document fields when the Host refuses, and warns on rejection', async () => {
    const createDocument = vi.fn<ExpertsSectionProps['createDocument']>().mockResolvedValueOnce(false)
    render(<ExpertsSection {...props({ library: stocked }, { createDocument })} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Document title' }), { target: { value: 'Notes' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Document text' }), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save document' }))
    await waitFor(() => { expect(createDocument).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Document title' }).value).toBe('Notes')
    const warn = logErrorSilently()
    createDocument.mockRejectedValueOnce(new Error('x'))
    fireEvent.click(screen.getByRole('button', { name: 'Save document' }))
    await waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })

  it('deletes a document and a knowledge base, warning on rejection', async () => {
    const deleteDocument = vi.fn<ExpertsSectionProps['deleteDocument']>(async () => true)
    const deleteKnowledgeBase = vi.fn<ExpertsSectionProps['deleteKnowledgeBase']>(async () => true)
    render(<ExpertsSection {...props({ library: stocked }, { deleteDocument, deleteKnowledgeBase })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete document Guide' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete knowledge base Handbook' }))
    expect(deleteDocument).toHaveBeenCalledWith('d1')
    expect(deleteKnowledgeBase).toHaveBeenCalledWith('k1')
    cleanup()
    const warn = logErrorSilently()
    deleteDocument.mockRejectedValueOnce(new Error('x'))
    deleteKnowledgeBase.mockRejectedValueOnce(new Error('y'))
    render(<ExpertsSection {...props({ library: stocked }, { deleteDocument, deleteKnowledgeBase })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete document Guide' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete knowledge base Handbook' }))
    await waitFor(() => { expect(warn).toHaveBeenCalledTimes(2) })
    warn.mockRestore()
  })

  it('creates a knowledge base from the checked documents and clears the form', async () => {
    const saveKnowledgeBase = vi.fn<ExpertsSectionProps['saveKnowledgeBase']>(async () => true)
    render(<ExpertsSection {...props({ library: stocked }, { saveKnowledgeBase })} />)
    const save = screen.getByRole('button', { name: 'Save knowledge base' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Knowledge base name' }), { target: { value: ' Team ' } })
    const [guide, policy] = ['Guide', 'Policy'].map(name => screen.getAllByRole('checkbox', { name })[0]!)
    fireEvent.click(guide!)
    fireEvent.click(policy!)
    fireEvent.click(policy!)
    fireEvent.click(save)
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Knowledge base name' }).value).toBe('') })
    expect(saveKnowledgeBase).toHaveBeenCalledWith({ name: 'Team', documentIds: ['d1'] })
  })

  it('keeps the knowledge base form when refused, and warns on rejection', async () => {
    const saveKnowledgeBase = vi.fn<ExpertsSectionProps['saveKnowledgeBase']>().mockResolvedValueOnce(false)
    render(<ExpertsSection {...props({ library: stocked }, { saveKnowledgeBase })} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Knowledge base name' }), { target: { value: 'Team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save knowledge base' }))
    await waitFor(() => { expect(saveKnowledgeBase).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Knowledge base name' }).value).toBe('Team')
    const warn = logErrorSilently()
    saveKnowledgeBase.mockRejectedValueOnce(new Error('x'))
    fireEvent.click(screen.getByRole('button', { name: 'Save knowledge base' }))
    await waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })
})
