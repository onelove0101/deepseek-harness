// @vitest-environment jsdom
/**
 * MenuView rendering spec, props-direct: closed store
 * renders null, groups render in roster order under localized title rows
 * (unknown sources fall back to the raw name) with pending rows as skeleton
 * placeholders, pointer picks route (source, index) back without stealing
 * focus, the highlight is exposed through aria-activedescendant +
 * aria-selected, and the list height clamps to the space above the composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import type {
  FlyoutState, InputTriggerCrumb, MenuState, TriggerHit,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { MenuView } from '../src/client/MenuView.tsx'

const hit: TriggerHit = {
  trigger: '/',
  query: 'g',
  quoted: false,
  position: 'leading',
  span: { start: 0, end: 2, draftRev: 1 },
}

const CLOSED: MenuState = { open: false, hit: null, generation: 0, groups: [], highlight: null }

function openState(partial?: Partial<MenuState>): MenuState {
  return {
    open: true,
    hit,
    generation: 1,
    groups: [
      { source: 'command', status: 'ready', items: [{ name: 'goal', description: 'Set up a goal', icon: 'file' }, { name: 'plan' }] },
      { source: 'skill', status: 'pending', items: [] },
    ],
    highlight: { source: 'command', index: 0 },
    ...partial,
  }
}

// jsdom has no scrollIntoView; the view calls it on the highlighted option.
const scrollIntoView = vi.fn()
beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// The framework-injected t seat, stubbed over the zh dictionaries (the
// default locale); the stub mirrors the LocaleRuntime key fallback, so an
// unknown source comes back verbatim (its raw name).
const t = makeTranslate(zh, commonZh)

function mount(
  state: MenuState,
  crumbs: ReadonlyMap<string, readonly InputTriggerCrumb[]> = new Map(),
  flyoutState: FlyoutState | null = null,
) {
  const menu = createSnapshotStore<MenuState>(state)
  const flyout = createSnapshotStore<FlyoutState | null>(flyoutState)
  const onFlyoutPick = vi.fn()
  const onFlyoutHover = vi.fn()
  const headers = createSnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>(crumbs)
  const onPick = vi.fn()
  const onCrumb = vi.fn()
  const onHover = vi.fn()
  const onDismiss = vi.fn()
  const view = render(
    <MenuView
      menu={menu}
      headers={headers}
      flyout={flyout}
      onPick={onPick}
      onFlyoutPick={onFlyoutPick}
      onFlyoutHover={onFlyoutHover}
      onCrumb={onCrumb}
      onHover={onHover}
      onDismiss={onDismiss}
      t={t}
    />,
  )
  return { menu, headers, flyout, onPick, onFlyoutPick, onFlyoutHover, onCrumb, onHover, onDismiss, view }
}

/** The bounded menu shell: it owns the height clamp, the listbox scrolls inside it. */
function menuShell(): HTMLElement {
  const shell = document.querySelector('[data-trigger-menu]')
  if (!(shell instanceof HTMLElement)) throw new Error('menu shell is not rendered')
  return shell
}

/** The non-interactive group title rows (role=presentation), in document order. */
function titles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('div[role="presentation"][data-source]')]
    .map(el => el.textContent ?? '')
}

describe('MenuView', () => {
  it('renders null while closed and appears when the store opens', () => {
    const { menu, view } = mount(CLOSED)
    expect(view.container.childElementCount).toBe(0)
    act(() => { menu.set(openState()) })
    expect(screen.queryByRole('listbox')).not.toBeNull()
    act(() => { menu.set(CLOSED) })
    expect(view.container.childElementCount).toBe(0)
  })

  it('renders ready groups as option rows and pending groups as two skeleton rows', () => {
    mount(openState())
    const options = screen.getAllByRole('option')
    expect(options.map(o => o.textContent)).toEqual(['goalSet up a goal', 'plan'])
    // The icon token renders as an SVG glyph, not text.
    expect(options[0]?.querySelector('svg')).not.toBeNull()
    expect(options[1]?.querySelector('svg')).toBeNull()
    const status = screen.getByRole('status', { name: '正在加载…' })
    expect(status.children).toHaveLength(2)
  })

  it('renders a localized label as the title with the name as its alias, an icon component, and the description', () => {
    const Glyph = ({ size = 16 }: { size?: number | undefined }) => <svg data-glyph="plan" width={size} height={size} />
    mount(openState({
      groups: [{
        source: 'command',
        status: 'ready',
        items: [
          { name: 'plan', label: '计划', description: '进入或退出计划模式', icon: Glyph, section: '添加' },
          { name: 'file', label: 'File', section: '添加' },
        ],
      }],
    }))
    const options = screen.getAllByRole('option')
    expect(options.map(o => o.textContent)).toEqual(['计划plan进入或退出计划模式', 'File'])
    expect(options[0]?.querySelector('[data-glyph="plan"]')?.getAttribute('width')).toBe('14')
    // A label that is the name in another letter case renders no alias.
    expect(options[1]?.querySelectorAll('span')).toHaveLength(1)
    expect(screen.getAllByText('添加')).toHaveLength(1)
  })

  it('keeps an opted-out source title hidden while its candidates are pending', () => {
    mount(openState({
      groups: [{ source: 'reference', showGroupTitle: false, status: 'pending', items: [] }],
      highlight: null,
    }))
    expect(screen.queryByText('reference')).toBeNull()
    expect(screen.getByRole('status', { name: '正在加载…' })).toBeTruthy()
  })

  it('renders retained items instead of skeletons while a refinement is pending', () => {
    mount(openState({
      groups: [{ source: 'command', status: 'pending', items: [{ name: 'goal' }] }],
      highlight: null,
    }))
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['goal'])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('titles each group with the localized source name, raw name for unknown sources, none for empty ready groups', () => {
    const { view } = mount(openState({
      groups: [
        { source: 'command', status: 'ready', items: [{ name: 'goal' }] },
        { source: 'hollow', status: 'ready', items: [] },
        { source: 'mystery', status: 'ready', items: [{ name: 'x' }] },
        { source: 'skill', status: 'pending', items: [] },
      ],
    }))
    expect(titles(view.container)).toEqual(['指令', 'mystery', '技能'])
  })

  it('titles the expert source with its localized name', () => {
    const { view } = mount(openState({
      groups: [{ source: 'expert', status: 'ready', items: [{ name: 'reviewer' }] }],
      highlight: null,
    }))
    expect(titles(view.container)).toEqual(['专家'])
  })

  it('shows a source named like another dictionary key as published, not that entry copy', () => {
    const { view } = mount(openState({
      groups: [
        { source: 'loading', status: 'ready', items: [{ name: 'a' }] },
        { source: 'drill.key', status: 'ready', items: [{ name: 'b' }] },
      ],
      highlight: null,
    }))
    expect(titles(view.container)).toEqual(['loading', 'drill.key'])
  })

  it('renders contiguous candidate sections once without changing option indexes', () => {
    const { onPick } = mount(openState({
      groups: [{
        source: 'reference',
        status: 'ready',
        items: [
          { name: 'Folder · src/', section: '文件与文件夹' },
          { name: 'File · README.md', section: '文件与文件夹' },
          { name: 'Session · Research', section: '对话' },
        ],
      }],
      highlight: { source: 'reference', index: 0 },
    }))
    expect(screen.queryByText('reference')).toBeNull()
    expect(screen.getAllByText('文件与文件夹')).toHaveLength(1)
    expect(screen.getAllByText('对话')).toHaveLength(1)
    const options = screen.getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual([
      'Folder · src/',
      'File · README.md',
      'Session · Research',
    ])
    fireEvent.mouseDown(options[2]!)
    expect(onPick).toHaveBeenCalledWith('reference', 2)
  })

  it('renders the drill chevron only on drillable rows and routes its own action', () => {
    const { onPick } = mount(openState({
      groups: [{
        source: 'reference',
        status: 'ready',
        items: [
          { name: 'Folder · src/', drill: true },
          { name: 'File · README.md' },
        ],
      }],
      highlight: { source: 'reference', index: 0 },
    }))
    const chevrons = screen.getAllByRole('button', { name: '进入目录' })
    expect(chevrons).toHaveLength(1)
    // The chevron drills; the row body still settles the pick untouched.
    fireEvent.mouseDown(chevrons[0]!)
    expect(onPick).toHaveBeenCalledWith('reference', 0, 'drill')
    fireEvent.mouseDown(screen.getAllByRole('option')[0]!)
    expect(onPick).toHaveBeenCalledWith('reference', 0)
  })

  it('exposes the highlight via aria-activedescendant and aria-selected', () => {
    mount(openState({ highlight: { source: 'command', index: 1 } }))
    const listbox = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')
    expect(options[1]!.id).toBeTruthy()
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1]!.id)
    expect(options[1]!.getAttribute('aria-selected')).toBe('true')
    expect(options[0]!.getAttribute('aria-selected')).toBe('false')
  })

  it('omits aria-activedescendant without a highlight', () => {
    mount(openState({ highlight: null }))
    expect(screen.getByRole('listbox').getAttribute('aria-activedescendant')).toBeNull()
  })

  it('scrolls the highlighted option into view when the highlight moves', () => {
    const { menu } = mount(openState())
    scrollIntoView.mockClear()
    act(() => { menu.set(openState({ highlight: { source: 'command', index: 1 } })) })
    const options = screen.getAllByRole('option')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.instances.at(-1)).toBe(options[1])
  })

  it('caps the list height at the design maximum when the composer sits low enough', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ bottom: 800 } as DOMRect)
    mount(openState())
    expect(menuShell().style.maxHeight).toBe('400px')
  })

  it('clamps the list height to the space above the composer minus the header-clearing margin', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ bottom: 200 } as DOMRect)
    mount(openState())
    expect(menuShell().style.maxHeight).toBe('116px')
  })

  it('re-fits the height when the window resizes', () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    rect.mockReturnValue({ bottom: 800 } as DOMRect)
    mount(openState())
    expect(menuShell().style.maxHeight).toBe('400px')
    rect.mockReturnValue({ bottom: 100 } as DOMRect)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(menuShell().style.maxHeight).toBe('16px')
  })

  it('shows the bottom overflow hint until the list reaches its final row', () => {
    mount(openState())
    const listbox = screen.getByRole('listbox')
    Object.defineProperties(listbox, {
      clientHeight: { configurable: true, value: 320 },
      scrollHeight: { configurable: true, value: 392 },
      scrollTop: { configurable: true, value: 0, writable: true },
    })
    fireEvent.scroll(listbox)
    expect(menuShell().hasAttribute('data-overflow-below')).toBe(true)
    listbox.scrollTop = 72
    fireEvent.scroll(listbox)
    expect(menuShell().hasAttribute('data-overflow-below')).toBe(false)
  })

  it('pointerdown outside the menu (no composer card ancestor) dismisses', () => {
    const { onDismiss } = mount(openState())
    fireEvent.pointerDown(document.body)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('pointerdown inside the list does not dismiss', () => {
    const { onDismiss } = mount(openState())
    fireEvent.pointerDown(screen.getAllByRole('option')[0]!)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('pointerdown inside the surrounding composer card does not dismiss; outside it does', () => {
    const menu = createSnapshotStore<MenuState>(openState())
    const onDismiss = vi.fn()
    render(
      <div data-composer-card="">
        <MenuView
          menu={menu}
          headers={createSnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>(new Map())}
          flyout={createSnapshotStore<FlyoutState | null>(null)}
          onPick={vi.fn()}
          onFlyoutPick={vi.fn()}
          onFlyoutHover={vi.fn()}
          onCrumb={vi.fn()}
          onHover={vi.fn()}
          onDismiss={onDismiss}
          t={t}
        />
        <button type="button" data-testid="composer-button" />
      </div>,
    )
    fireEvent.pointerDown(screen.getByTestId('composer-button'))
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('ignores a pointerdown whose target is not a DOM node', () => {
    const { onDismiss } = mount(openState())
    const ev = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(ev, 'target', { value: {} })
    document.dispatchEvent(ev)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('closing the menu removes the dismiss listener', () => {
    const { menu, onDismiss } = mount(openState())
    act(() => { menu.set(CLOSED) })
    fireEvent.pointerDown(document.body)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('mousedown on a row picks (source, index) and prevents the focus steal', () => {
    const { onPick } = mount(openState())
    const options = screen.getAllByRole('option')
    const notPrevented = fireEvent.mouseDown(options[1]!)
    // fireEvent returns false when preventDefault was called.
    expect(notPrevented).toBe(false)
    expect(onPick).toHaveBeenCalledWith('command', 1)
  })

  it('pointer motion over a row routes hover; the highlighted row stays silent', () => {
    const { onHover } = mount(openState())
    const options = screen.getAllByRole('option')
    fireEvent.mouseMove(options[1]!)
    expect(onHover).toHaveBeenCalledWith('command', 1)
    onHover.mockClear()
    // Index 0 already holds the highlight: no hover round-trip.
    fireEvent.mouseMove(options[0]!)
    expect(onHover).not.toHaveBeenCalled()
  })

  it('renders a source header as a breadcrumb above the list, current step last', () => {
    mount(openState(), new Map([['command', [
      { label: 'Workspace', value: 'root' },
      { label: 'src', value: 'src' },
      { label: 'module1', value: 'module1', current: true },
    ]]]))
    const nav = screen.getByRole('navigation', { name: '目录导航' })
    expect([...nav.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Workspace', 'src', 'module1'])
    // The listbox holds options alone; the header is its sibling, not a row.
    expect(screen.getByRole('listbox').contains(nav)).toBe(false)
  })

  it('mousedown on a crumb routes (source, index) without stealing focus; the current step is inert', () => {
    const { onCrumb } = mount(openState(), new Map([['command', [
      { label: 'Workspace', value: 'root' },
      { label: 'src', value: 'src', current: true },
    ]]]))
    const crumbs = screen.getByRole('navigation', { name: '目录导航' }).querySelectorAll('button')
    expect(fireEvent.mouseDown(crumbs[0]!)).toBe(false)
    expect(onCrumb).toHaveBeenCalledWith('command', 0)
    onCrumb.mockClear()
    expect(crumbs[1]!.disabled).toBe(true)
    fireEvent.mouseDown(crumbs[1]!)
    expect(onCrumb).not.toHaveBeenCalled()
  })

  it('renders no header for a source that published no crumbs', () => {
    mount(openState())
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  describe('flyout', () => {
    const submenuState = (): MenuState => openState({
      groups: [
        { source: 'command', status: 'ready', items: [{ name: 'expert', label: 'Expert', submenu: true }, { name: 'plan' }] },
      ],
    })
    const readyFlyout = (highlight: number | null = null): FlyoutState => ({
      source: 'command',
      parent: 0,
      parentName: 'expert',
      status: 'ready',
      items: [{ name: 'alpha', description: 'first' }, { name: 'beta' }],
      highlight,
    })

    it('marks a submenu row with a popup hint and a chevron, and renders nothing while closed', () => {
      mount(submenuState())
      const row = screen.getAllByRole('option')[0]!
      expect(row.getAttribute('aria-haspopup')).toBe('listbox')
      expect(row.querySelector('svg')).not.toBeNull()
      expect(screen.getAllByRole('option')[1]!.getAttribute('aria-haspopup')).toBeNull()
      expect(document.querySelector('[data-trigger-flyout]')).toBeNull()
    })

    it('lists the flyout rows beside the menu and routes mousedown and mousemove by index', () => {
      const { onFlyoutPick, onFlyoutHover, onPick } = mount(submenuState(), new Map(), readyFlyout(0))
      const panel = document.querySelector('[data-trigger-flyout]')!
      const rows = [...panel.querySelectorAll('[role="option"]')]
      expect(rows.map(row => row.textContent)).toEqual(['alphafirst', 'beta'])
      expect(rows.map(row => row.getAttribute('aria-selected'))).toEqual(['true', 'false'])
      fireEvent.mouseMove(rows[1]!)
      expect(onFlyoutHover).toHaveBeenCalledWith(1)
      fireEvent.mouseMove(rows[0]!)
      expect(onFlyoutHover).toHaveBeenCalledTimes(1)
      expect(fireEvent.mouseDown(rows[1]!)).toBe(false)
      expect(onFlyoutPick).toHaveBeenCalledWith(1)
      expect(onPick).not.toHaveBeenCalled()
    })

    it('keeps each listbox active descendant inside its own rows', () => {
      const { flyout } = mount(submenuState(), new Map(), readyFlyout(null))
      const [main, panel] = screen.getAllByRole('listbox')
      expect(main!.getAttribute('aria-activedescendant')).toBe('dsh-slash-option-command-0')
      expect(panel!.getAttribute('aria-activedescendant')).toBeNull()
      act(() => { flyout.set(readyFlyout(1)) })
      expect(main!.getAttribute('aria-activedescendant')).toBe('dsh-slash-option-command-0')
      expect(main!.contains(document.getElementById('dsh-slash-option-command-0'))).toBe(true)
      expect(panel!.getAttribute('aria-activedescendant')).toBe('dsh-slash-flyout-option-1')
      expect(panel!.contains(document.getElementById('dsh-slash-flyout-option-1'))).toBe(true)
      expect(scrollIntoView).toHaveBeenCalled()
    })

    it('reports the submenu parent as expanded and controlling the flyout only while it is open', () => {
      const { flyout } = mount(submenuState())
      const [parent, plain] = screen.getAllByRole('option')
      expect(parent!.getAttribute('aria-expanded')).toBe('false')
      expect(parent!.getAttribute('aria-controls')).toBeNull()
      expect(plain!.getAttribute('aria-expanded')).toBeNull()
      act(() => { flyout.set(readyFlyout()) })
      expect(parent!.getAttribute('aria-expanded')).toBe('true')
      expect(parent!.getAttribute('aria-controls')).toBe(document.querySelector('[data-trigger-flyout]')!.id)
      expect(plain!.getAttribute('aria-expanded')).toBeNull()
      act(() => { flyout.set({ ...readyFlyout(), parent: 1 }) })
      expect(parent!.getAttribute('aria-expanded')).toBe('false')
    })

    it('shows skeleton rows while loading and an empty notice when there is nothing to choose', () => {
      const { flyout } = mount(submenuState(), new Map(), { ...readyFlyout(), status: 'pending', items: [] })
      const panel = document.querySelector('[data-trigger-flyout]')!
      expect(panel.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('正在加载…')
      act(() => { flyout.set({ ...readyFlyout(), items: [] }) })
      expect(panel.textContent).toBe('暂无可选项')
    })

    it('announces a localized failure instead of presenting stale flyout options', () => {
      mount(submenuState(), new Map(), { ...readyFlyout(), status: 'failed', items: [], highlight: null })
      expect(screen.getByRole('alert').textContent).toBe('无法加载可选项')
      expect(document.querySelector('[data-trigger-flyout] [role="option"]')).toBeNull()
    })

    it('opens through the parent row hover while it is active and closed, and not once open', () => {
      const { onHover, flyout } = mount(submenuState())
      const row = screen.getAllByRole('option')[0]!
      expect(row.getAttribute('aria-selected')).toBe('true')
      fireEvent.mouseMove(row)
      expect(onHover).toHaveBeenCalledWith('command', 0)
      onHover.mockClear()
      act(() => { flyout.set(readyFlyout()) })
      fireEvent.mouseMove(row)
      expect(onHover).not.toHaveBeenCalled()
    })

    it('does not dismiss on a pointerdown inside the flyout', () => {
      const { onDismiss } = mount(submenuState(), new Map(), readyFlyout())
      fireEvent.pointerDown(document.querySelector('[data-trigger-flyout] [role="option"]')!)
      expect(onDismiss).not.toHaveBeenCalled()
    })
  })
})
