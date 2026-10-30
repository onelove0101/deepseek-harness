/** `chat-process-fold` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'chat-process-fold'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '过程',
  'thought': '思考',
  'expand': '展开过程',
  'collapse': '折叠过程',
  'settings.title': '折叠过程框',
  'settings.description': '将每轮执行过程(推理与工具调用)折叠成一个默认收起的盒子。',
  'settings.on': '开',
  'settings.off': '关',
} as const

/** English dictionary (same key set). */
export const en: Record<ChatProcessFoldKey, string> = {
  'title': 'Process',
  'thought': 'Thought',
  'expand': 'Show process',
  'collapse': 'Hide process',
  'settings.title': 'Collapse process box',
  'settings.description': 'Fold each turn\'s process (reasoning and tool calls) into a collapsed box by default.',
  'settings.on': 'On',
  'settings.off': 'Off',
}

/** Union of this namespace's dictionary keys. */
export type ChatProcessFoldKey = keyof typeof zh
