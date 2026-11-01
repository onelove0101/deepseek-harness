/** Leading-mention helpers shared by the `@` source and the Add menu's Expert flyout. */

/** Longest Soul excerpt shown as a menu description. */
const DESCRIPTION_CHARS = 80

/**
 * First line of a Soul, truncated for a one-line menu description.
 * @param soul - the Expert's Soul text.
 * @returns the trimmed excerpt.
 */
export function soulExcerpt(soul: string): string {
  return soul.trim().slice(0, DESCRIPTION_CHARS).replace(/\n[\s\S]*$/, '')
}

/** One edit of the draft's start: replace `[0, end)` with `text`. */
export interface LeadingMentionEdit {
  readonly text: string
  readonly end: number
}

/**
 * Plan the insertion of `@name ` at the start of a draft. A draft that already
 * opens with a mention of a known Expert has that mention replaced, because
 * the Host recognizes only one leading mention.
 * @param draft - the current draft text.
 * @param name - the Expert to mention.
 * @param known - names of the Experts offered by the Host.
 * @returns the text and the end of the span it replaces.
 */
export function leadingMentionEdit(draft: string, name: string, known: ReadonlySet<string>): LeadingMentionEdit {
  const match = /^@([^\s@]+) ?/.exec(draft)
  const [matchedMention, existingName] = match ?? []
  const end = existingName !== undefined && known.has(existingName) ? matchedMention.length : 0
  return { text: `@${name} `, end }
}
