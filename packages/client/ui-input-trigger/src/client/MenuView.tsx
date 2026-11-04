/**
 * Trigger candidate menu: renders the InputTriggerService menu store into the
 * conversation.input.overlay anchor. Closed state renders null (the overlay
 * slot stays mounted); groups render in roster order under localized title
 * rows. A pending group keeps showing the items it already had (the reducer
 * retains them across a query refinement) and falls back to two skeleton
 * rows only while it has none; pointer picks route back through
 * the service (combobox pattern — focus never leaves the textarea, so rows
 * are mousedown-handled and the highlight is exposed via
 * aria-activedescendant on the main listbox). A row reads title, then the
 * command-name alias when the title is not the name in another letter case
 * (a localized title), then the description right-aligned. A source publishing crumbs gets a breadcrumb
 * header pinned above the scrolling list. A `submenu` row shows a chevron and,
 * while hovered or entered by Enter / Tab, a flyout of nested rows laid over
 * the menu's right side level with the row. The flyout is a sibling listbox, so
 * each listbox's aria-activedescendant names only its own rows: the main one
 * keeps the parent row, the flyout one names its highlighted row; the parent row
 * reports aria-expanded and aria-controls while its flyout is open.
 */
import { MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconChevronRightOutlineRegular, ReferenceIconRegular, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MenuView.module.css'
import type { MenuViewInjected } from './slots.ts'
import type { MenuKey } from './locales.ts'

/** Full menu props: injected face + the locale seat. */
export type MenuViewProps = MenuViewInjected & PropsLocale<'slash.menu'>

/** Sources whose group title is a dictionary entry; any other source name is shown as published. */
const TITLED_SOURCES = ['command', 'skill', 'subagent', 'expert'] as const satisfies readonly MenuKey[]

/** DOM id of the flyout listbox (the parent row's aria-controls target). */
const FLYOUT_ID = 'dsh-slash-flyout'

/** Height cap that fits the two headings and eight built-in command rows. */
const MAX_HEIGHT = 400

/**
 * Viewport top margin: the conversation header's 76px block (title row plus
 * view tabs, ui-conversation) plus 8px of air, so a tall list stops below the
 * header instead of sliding under it.
 */
const TOP_MARGIN = 84

/** DOM id of one option row (the aria-activedescendant target). */
function optionId(source: string, index: number): string {
  return `dsh-slash-option-${source}-${index}`
}

/** DOM id of one flyout row; only one flyout exists, so the index is enough. */
function flyoutOptionId(index: number): string {
  return `dsh-slash-flyout-option-${index}`
}

/**
 * Resolve a group's title row text. Source names are open-ended, so only the
 * known source keys are looked up: a source named like another dictionary key
 * (`loading`, `drill.key`) must not borrow that entry's copy.
 * @param source - the group's source name.
 * @param t - the `slash.menu` translator.
 * @returns the localized title for a known source; the source name otherwise.
 */
function groupTitle(source: string, t: MenuViewProps['t']): string {
  return (TITLED_SOURCES as readonly string[]).includes(source) ? t(source as MenuKey) : source
}

/**
 * Render the candidate menu overlay entry.
 * @param props - injected face (the menu store and the pick route); `t` rides the standard locale seat.
 * @returns the dropdown while open; null while closed.
 */
export function MenuView({
  menu, headers, flyout, onPick, onFlyoutPick, onFlyoutHover, onCrumb, onHover, onDismiss, t,
}: MenuViewProps) {
  const state = useSyncExternalStore(
    fn => menu.subscribe(fn),
    () => menu.getSnapshot(),
  )
  const crumbs = useSyncExternalStore(
    fn => headers.subscribe(fn),
    () => headers.getSnapshot(),
  )
  const flyoutState = useSyncExternalStore(
    fn => flyout.subscribe(fn),
    () => flyout.getSnapshot(),
  )
  const listRef = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [hasOverflowBelow, setHasOverflowBelow] = useState(false)
  // The list is bottom-anchored above the composer; clamp the design cap to
  // the space above it, re-measured on every store update (the anchor moves
  // when the composer grows).
  const maxHeight = useAnchoredMaxHeight(listRef, MAX_HEIGHT, state, TOP_MARGIN)
  const updateOverflowHint = useCallback(() => {
    const viewport = viewportRef.current
    setHasOverflowBelow(viewport !== null
      && viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1)
  }, [])
  useLayoutEffect(() => {
    updateOverflowHint()
  }, [state, maxHeight, updateOverflowHint])
  const highlight = state.open ? state.highlight : null
  // Focus stays in the textarea (combobox pattern), so the browser never
  // scrolls the active option into view on keyboard moves — do it here.
  useEffect(() => {
    if (highlight === null) return
    document.getElementById(optionId(highlight.source, highlight.index))
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight])
  const flyoutHighlight = flyoutState?.highlight ?? null
  useEffect(() => {
    if (flyoutHighlight === null) return
    document.getElementById(flyoutOptionId(flyoutHighlight))?.scrollIntoView({ block: 'nearest' })
  }, [flyoutHighlight])
  // Level the flyout with its parent row, clamped so it stays inside the menu.
  useLayoutEffect(() => {
    const panel = flyoutRef.current
    const menuBox = listRef.current
    if (panel === null || menuBox === null || flyoutState === null) return
    const row = document.getElementById(optionId(flyoutState.source, flyoutState.parent))
    if (row === null) return
    const top = row.getBoundingClientRect().top - menuBox.getBoundingClientRect().top
    panel.style.top = `${String(Math.max(0, Math.min(top, menuBox.clientHeight - panel.offsetHeight)))}px`
  }, [flyoutState, state])
  // Dismiss on pointer outside the menu AND outside the composer card
  // (clicking the textarea or bottom bar must not close the menu).
  useEffect(() => {
    if (!state.open) return
    const onPointerDown = (ev: PointerEvent): void => {
      if (!(ev.target instanceof Node)) return
      if (listRef.current?.contains(ev.target)) return
      const composerCard = listRef.current?.closest('[data-composer-card]')
      if (composerCard?.contains(ev.target)) return
      onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [state.open, onDismiss])
  if (!state.open) return null
  return (
    // The listbox role sits on the scrolling viewport, not this shell: a
    // breadcrumb header is not an option, and a listbox may not carry one.
    <MenuSurface
      ref={listRef}
      className={css.menu}
      style={{ maxHeight }}
      data-trigger-menu=""
      data-overflow-below={hasOverflowBelow || undefined}
    >
      {state.groups.map((group) => {
        const trail = crumbs.get(group.source)
        return trail === undefined ? null : (
          <nav key={group.source} className={css.crumbs} aria-label={t('crumbs.aria')}>
            {trail.map((crumb, index) => (
              <Fragment key={`${String(index)}-${crumb.value}`}>
                {index > 0 && <span className={css.crumbSeparator} aria-hidden><IconChevronRightOutlineRegular /></span>}
                <button
                  type="button"
                  className={clsx(css.crumb, crumb.current === true && css.crumbCurrent)}
                  aria-current={crumb.current === true ? 'location' : undefined}
                  disabled={crumb.current === true}
                  // mousedown, not click: the composer keeps focus, same as a row.
                  onMouseDown={(ev) => {
                    ev.preventDefault()
                    onCrumb(group.source, index)
                  }}
                >
                  {crumb.label}
                </button>
              </Fragment>
            ))}
          </nav>
        )
      })}
      <div
        ref={viewportRef}
        className={css.viewport}
        role="listbox"
        aria-label={t('suggestions.aria')}
        aria-activedescendant={highlight !== null ? optionId(highlight.source, highlight.index) : undefined}
        onScroll={updateOverflowHint}
      >
        {state.groups.map(group => (group.status === 'ready' && group.items.length === 0)
          ? null
          : (
            <Fragment key={group.source}>
              {group.showGroupTitle === false || group.items.some(item => item.section !== undefined)
                ? null
                : <div className={css.groupTitle} role="presentation" data-source={group.source}>{groupTitle(group.source, t)}</div>}
              {group.status === 'pending' && group.items.length === 0
                ? (
                  <div role="status" aria-label={t('loading')} data-source={group.source}>
                    <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '32%' }} /></div>
                    <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '48%' }} /></div>
                  </div>
                )
                : group.items.map((item, index) => {
                  const active = highlight !== null && highlight.source === group.source && highlight.index === index
                  const expanded = flyoutState !== null && flyoutState.source === group.source && flyoutState.parent === index
                  return (
                    <Fragment key={optionId(group.source, index)}>
                      {item.section !== undefined && item.section !== group.items[index - 1]?.section
                        ? <div className={css.sectionTitle} role="presentation">{item.section}</div>
                        : null}
                      <button
                        id={optionId(group.source, index)}
                        type="button"
                        role="option"
                        aria-selected={active}
                        aria-haspopup={item.submenu === true ? 'listbox' : undefined}
                        aria-expanded={item.submenu === true ? expanded : undefined}
                        aria-controls={item.submenu === true && expanded ? FLYOUT_ID : undefined}
                        className={clsx(css.item, active && css.active)}
                        // mousedown, not click: the textarea keeps focus (combobox
                        // pattern) — preventing default stops the focus steal, and the
                        // pick runs before any blur-driven teardown.
                        onMouseDown={(ev) => {
                          ev.preventDefault()
                          onPick(group.source, index)
                        }}
                        // mousemove, not mouseenter: real pointer motion moves the
                        // shared highlight; keyboard scrolling rows under a resting
                        // pointer must not steal it back.
                        // A submenu row also listens while active and closed, so a
                        // pointer resting on a keyboard-highlighted row opens it.
                        onMouseMove={active && !(item.submenu === true && flyoutState === null)
                          ? undefined
                          : () => { onHover(group.source, index) }}
                      >
                        {item.icon !== undefined && (
                          <span className={css.itemIcon} aria-hidden>
                            {typeof item.icon === 'string'
                              ? <ReferenceIconRegular kind={item.icon} size={14} />
                              : <item.icon size={14} />}
                          </span>
                        )}
                        <span className={css.itemName}>{item.label ?? item.name}</span>
                        {item.label !== undefined && item.label.toLowerCase() !== item.name.toLowerCase() && (
                          <span className={css.itemAlias}>{item.name}</span>
                        )}
                        {item.description !== undefined && <span className={css.itemDescription}>{item.description}</span>}
                        {item.submenu === true && (
                          <span className={css.submenuChevron} aria-hidden><IconChevronRightOutlineRegular size={14} /></span>
                        )}
                        {item.drill === true && (
                          <span className={css.trailing}>
                            {/* Visual hint only: Tab drills the highlighted row (the
                                keyboard twin of the chevron, which owns the aria label). */}
                            <span className={css.drillHintText} aria-hidden>{t('drill.hint')}</span>
                            <kbd className={css.drillHint} aria-hidden>{t('drill.key')}</kbd>
                            <span
                              role="button"
                              aria-label={t('drill.aria')}
                              className={css.drill}
                              // mousedown so the composer keeps focus, same as the row;
                              // stopPropagation keeps the row's settling pick out of it.
                              onMouseDown={(ev) => {
                                ev.preventDefault()
                                ev.stopPropagation()
                                onPick(group.source, index, 'drill')
                              }}
                            >
                              <IconChevronRightOutlineRegular size={12} />
                            </span>
                          </span>
                        )}
                      </button>
                    </Fragment>
                  )
                })}
            </Fragment>
          ))}
      </div>
      {flyoutState !== null && (
        <div
          ref={flyoutRef}
          id={FLYOUT_ID}
          className={css.flyout}
          role="listbox"
          aria-label={t('flyout.aria')}
          aria-activedescendant={flyoutHighlight !== null ? flyoutOptionId(flyoutHighlight) : undefined}
          data-trigger-flyout=""
        >
          {flyoutState.status === 'pending'
            ? (
              <div role="status" aria-label={t('loading')}>
                <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '48%' }} /></div>
                <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '64%' }} /></div>
              </div>
            )
            : flyoutState.status === 'failed'
              ? <div className={css.flyoutEmpty} role="alert">{t('flyout.failed')}</div>
              : flyoutState.items.length === 0
                ? <div className={css.flyoutEmpty} role="status">{t('flyout.empty')}</div>
                : flyoutState.items.map((item, index) => {
                  const active = flyoutState.highlight === index
                  return (
                    <button
                      key={flyoutOptionId(index)}
                      id={flyoutOptionId(index)}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={clsx(css.item, active && css.active)}
                      onMouseDown={(ev) => {
                        ev.preventDefault()
                        onFlyoutPick(index)
                      }}
                      onMouseMove={active ? undefined : () => { onFlyoutHover(index) }}
                    >
                      <span className={css.itemName}>{item.label ?? item.name}</span>
                      {item.description !== undefined && <span className={css.itemDescription}>{item.description}</span>}
                    </button>
                  )
                })}
        </div>
      )}
    </MenuSurface>
  )
}
