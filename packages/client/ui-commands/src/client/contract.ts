/**
 * Frozen contract of the client command surface. Types only. The
 * CommandUiRuntime (`ctx.commandUi`) implements this face; business packages
 * consume its registration and dismissal operations.
 */
import type { ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** Copy for an option that must be acknowledged before onSelect can run. */
export interface SelectConfirmation {
  readonly title: string
  readonly description: string
  readonly acknowledgeLabel: string
  readonly cancelLabel: string
  readonly confirmLabel: string
}

/** Caller-owned group name and localized heading for popup options. */
export interface SelectOptionGroup {
  readonly name: string
  readonly label: string
}

/** Search behavior selected by the popup owner. */
export type PopupSearchMode = 'substring' | 'fuzzy-label'

/** One option row of a popupSelect shell. */
export interface SelectOption {
  readonly id: string
  readonly label: string
  /** Opaque business-owned selection context, preserved only for a flyout pick. */
  readonly value?: string
  /** Optional short marker rendered as a superscript beside the label. */
  readonly badge?: string
  readonly detail?: string
  /** Equal group names share a sticky heading; groups retain first-occurrence order. */
  readonly group?: SelectOptionGroup
  /**
   * The row the shell's highlight parks on when the panel opens, so an accept
   * gesture made without looking confirms the value in use. A business package
   * that marks a row `active` for presentation alone would make that row the
   * default pick.
   */
  readonly active?: boolean
  /** Optional in-page risk gate owned by the shared popup shell. */
  readonly confirmation?: SelectConfirmation
}

/** Command-owned search copy, resolved when its popup opens. */
export interface PopupSearchLabels {
  readonly placeholder: string
  /** Empty catalog, before filtering. */
  readonly empty: string
  /** Nonempty catalog with no matching rows. */
  readonly noResults: string
}

/**
 * Business registration for the popupSelect command kind. Data is
 * self-served: options/onSelect use the business package's own protocol.
 * The shell component is owned by ui-commands; business never sees it. Both
 * callbacks receive the ClientSessionContext captured at popup open.
 */
export interface PopupSelectSpec {
  readonly kind: 'popupSelect'
  /** Defaults to substring search; fuzzy-label ranks names within each group. */
  readonly searchMode?: PopupSearchMode
  /**
   * Supply localized search copy for this opening; omitted uses the shell's generic copy.
   * @returns search placeholder and empty-state labels.
   */
  searchLabels?(): PopupSearchLabels
  options(session: ClientSessionContext, signal: AbortSignal): Promise<readonly SelectOption[]>
  onSelect(option: SelectOption, session: ClientSessionContext): void | Promise<void>
}

/**
 * Rows a command row lists in a flyout beside it while hovered or entered
 * (the Add menu's nested choices). Selecting a row consumes the trigger token
 * and runs `onSelect`; the row's `badge`, `active`, and `confirmation` are not
 * shown in a flyout, so a choice that needs them belongs in a popupSelect.
 */
export interface FlyoutSpec {
  /**
   * Read the rows afresh each time the flyout opens.
   * @param session - the ClientSessionContext captured at open.
   * @param signal - aborted when the flyout closes.
   * @returns the rows in display order; `id` is the pick payload, `label` the title, `detail` the description.
   */
  options(session: ClientSessionContext, signal: AbortSignal): Promise<readonly SelectOption[]>
  /**
   * Apply one selection after the trigger token was consumed.
   * @param option - the selected row, rebuilt with its `id`, `label`, `detail`, and opaque `value` when supplied.
   * @param session - the ClientSessionContext captured at pick.
   */
  onSelect(option: SelectOption, session: ClientSessionContext): void | Promise<void>
}

/**
 * Business registration for the action command kind: a bare invocation
 * consumes the trigger token and runs one client-side callback. It submits nothing, so an
 * attachment-carrying draft never refuses it.
 */
export interface ActionSpec {
  readonly kind: 'action'
  /**
   * Run the action for one session.
   * @param session - the ClientSessionContext captured at invocation.
   */
  run(session: ClientSessionContext): void
}

/** The UI behavior of a contribution or decoration. */
export type CommandUiSpec = PopupSelectSpec | ActionSpec

/**
 * One client-owned command contribution: a slash-menu entry whose behavior
 * lives entirely on the client (no host descriptor). Merged with the host
 * catalog by name — a collision with a host command fails loud at candidate
 * synthesis, never shadows. Row copy is read on every candidate pass, so a
 * locale change reaches the next menu open without re-registration.
 */
export interface CommandContribution {
  /** Command name without the leading slash (unique across contributions). */
  readonly name: string
  /** Localized menu row title; the name itself when absent. */
  label?(): string
  /** Localized menu row description; the row shows none when absent. */
  description?(): string
  /** Menu row glyph from the shared icon set. */
  readonly icon?: ComponentType<IconProps>
  /** Capability filter, called with a fresh projection per candidate pass. */
  available(session: ClientSessionContext): boolean
  /** The command's UI behavior. */
  readonly ui: CommandUiSpec
  /**
   * Nested choices shown in a flyout beside the row; the row itself then opens
   * the flyout instead of running `ui`, which stays the typed `/name` behavior.
   */
  readonly flyout?: FlyoutSpec
}

/**
 * A Composer Add-menu row that has no slash-command behavior. It appears only
 * when the Composer opens the Add menu, and must expose a flyout so selecting
 * its parent can never consume a typed `/name` token or run an action.
 */
export interface AddContribution {
  /** Stable row name, unique across Add and slash contributions. */
  readonly name: string
  /** Localized Add-menu row title. */
  label(): string
  /** Localized Add-menu row description. */
  description(): string
  /** Optional glyph from the shared icon set. */
  readonly icon?: ComponentType<IconProps>
  /** Capability filter, called with a fresh projection per candidate pass. */
  available(session: ClientSessionContext): boolean
  /** Nested choices shown beside this Add-menu row. */
  readonly flyout: FlyoutSpec
}

/**
 * A UI decoration hung on one HOST command: what its BARE invocation does on
 * this client. Not a second command — the host command keeps its catalog
 * row, its argument claim (space / argued enter), and its lifecycle logging;
 * the decoration replaces only the bare menu-pick/enter with a popup whose
 * onSelect typically submits a completed line back through command.execute.
 * A decoration never manufactures a row: a name with no host catalog entry
 * in the session's directory simply never reaches the decoration.
 */
export interface CommandDecoration {
  /** The HOST command name this decorates (without the leading slash). */
  readonly name: string
  /** Capability filter, called with a fresh projection per bare invocation. */
  available(session: ClientSessionContext): boolean
  /** The bare-invocation UI. */
  readonly ui: CommandUiSpec
}

/** The `ctx.commandUi` service face visible to business packages. */
export interface CommandUiContract {
  /**
   * Register one client command contribution; effect disposer. Duplicate
   * names throw at registration.
   */
  register(contribution: CommandContribution): () => void
  /**
   * Register one Add-menu-only row; effect disposer. Duplicate names across
   * Add-only and slash contributions throw at registration.
   */
  registerAdd(contribution: AddContribution): () => void
  /**
   * Hang a bare-invocation decoration on one host command; effect disposer.
   * Duplicate names throw at registration.
   */
  decorate(decoration: CommandDecoration): () => void
  /** Close this command's open popups and confirmations without consuming composer drafts. */
  dismiss(name: string): void
  /** Resolve the per-session popup controller for one session scope (wiring/overlay layer). */
  popupFor(actx: ClientContext): unknown
}
