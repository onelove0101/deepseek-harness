/** Copy dictionaries for the Skills Settings page. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  nav: '技能',
  loading: '正在读取技能…',
  loadFailed: '无法读取技能：{reason}',
  retry: '重试',
  empty: '当前没有已加载的技能。',
  add: '添加技能',
  addPlaceholder: '包含 SKILL.md 的目录的绝对路径',
  addLabel: '技能目录路径',
  addConfirm: '添加',
  adding: '正在添加…',
  cancel: '取消',
  toggleNamed: '启用 {name}',
  readOnly: '当前连接不能修改技能设置。',
} satisfies Record<string, string>

/** Skills page locale key union. */
export type SkillsLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  nav: 'Skills',
  loading: 'Reading skills…',
  loadFailed: 'Could not read skills: {reason}',
  retry: 'Retry',
  empty: 'No skills are loaded.',
  add: 'Add skill',
  addPlaceholder: 'Absolute path of a directory containing SKILL.md',
  addLabel: 'Skill directory path',
  addConfirm: 'Add',
  adding: 'Adding…',
  cancel: 'Cancel',
  toggleNamed: 'Enable {name}',
  readOnly: 'This connection cannot change skill settings.',
} satisfies Record<SkillsLocaleKey, string>
