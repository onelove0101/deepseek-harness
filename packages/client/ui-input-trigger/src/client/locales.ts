/**
 * `slash.menu` namespace dictionaries: group titles keyed by source name
 * (MenuView looks titles up only for the known source names and shows any
 * other source name as published), the pending row, and the listbox and
 * header aria labels.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'command': '指令',
  'skill': '技能',
  'subagent': '子智能体',
  'expert': '专家',
  'loading': '正在加载…',
  'drill.aria': '进入目录',
  'drill.hint': '进入目录',
  'drill.key': 'Tab',
  'flyout.aria': '子菜单',
  'flyout.empty': '暂无可选项',
  'flyout.failed': '无法加载可选项',
  'crumbs.aria': '目录导航',
  'suggestions.aria': '触发候选建议',
} satisfies Record<string, string>

/** The slash.menu namespace key union. */
export type MenuKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'command': 'Commands',
  'skill': 'Skills',
  'subagent': 'Subagents',
  'expert': 'Experts',
  'loading': 'Loading…',
  'drill.aria': 'Browse folder',
  'drill.hint': 'Browse folder',
  'drill.key': 'Tab',
  'flyout.aria': 'Submenu',
  'flyout.empty': 'Nothing to choose',
  'flyout.failed': 'Could not load choices',
  'crumbs.aria': 'Folder navigation',
  'suggestions.aria': 'Trigger suggestions',
} satisfies Record<MenuKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'command': 'コマンド',
  'skill': 'スキル',
  'subagent': 'サブエージェント',
  'expert': 'Experts',
  'loading': '読み込み中…',
  'drill.aria': 'フォルダを参照',
  'drill.hint': 'フォルダを参照',
  'drill.key': 'Tab',
  'flyout.aria': 'Submenu',
  'flyout.empty': 'Nothing to choose',
  'flyout.failed': 'Could not load choices',
  'crumbs.aria': 'フォルダナビゲーション',
  'suggestions.aria': '候補を表示',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'command': 'Comandos',
  'skill': 'Habilidades',
  'subagent': 'Subagentes',
  'expert': 'Expertos',
  'loading': 'Cargando…',
  'drill.aria': 'Explorar carpeta',
  'drill.hint': 'Explorar carpeta',
  'drill.key': 'Pestaña',
  'flyout.aria': 'Submenú',
  'flyout.empty': 'No hay nada que elegir',
  'flyout.failed': 'No se pudieron cargar las opciones',
  'crumbs.aria': 'Navegación de carpetas',
  'suggestions.aria': 'Sugerencias de activación',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'command': 'Commandes',
  'skill': 'Compétences',
  'subagent': 'Sous-agents',
  'expert': 'Experts',
  'loading': 'Chargement…',
  'drill.aria': 'Parcourir le dossier',
  'drill.hint': 'Parcourir le dossier',
  'drill.key': 'Onglet',
  'flyout.aria': 'Sous-menu',
  'flyout.empty': 'Rien à choisir',
  'flyout.failed': 'Impossible de charger les choix',
  'crumbs.aria': 'Navigation dans les dossiers',
  'suggestions.aria': 'Suggestions de déclenchement',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'command': 'Befehle',
  'skill': 'Fähigkeiten',
  'subagent': 'Subagenten',
  'expert': 'Experten',
  'loading': 'Laden…',
  'drill.aria': 'Ordner durchsuchen',
  'drill.hint': 'Ordner durchsuchen',
  'drill.key': 'Tab',
  'flyout.aria': 'Untermenü',
  'flyout.empty': 'Nichts zur Auswahl',
  'flyout.failed': 'Auswahl konnte nicht geladen werden',
  'crumbs.aria': 'Ordnernavigation',
  'suggestions.aria': 'Trigger-Vorschläge',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'command': 'Команды',
  'skill': 'Навыки',
  'subagent': 'Субагенты',
  'expert': 'Эксперты',
  'loading': 'Загрузка…',
  'drill.aria': 'Просмотреть папку',
  'drill.hint': 'Просмотреть папку',
  'drill.key': 'Вкладка',
  'flyout.aria': 'Подменю',
  'flyout.empty': 'Нечего выбрать',
  'flyout.failed': 'Не удалось загрузить варианты',
  'crumbs.aria': 'Навигация по папкам',
  'suggestions.aria': 'Триггерные предложения',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'command': 'Comandos',
  'skill': 'Habilidades',
  'subagent': 'Subagentes',
  'expert': 'Especialistas',
  'loading': 'Carregando…',
  'drill.aria': 'Navegar na pasta',
  'drill.hint': 'Navegar na pasta',
  'drill.key': 'Guia',
  'flyout.aria': 'Submenu',
  'flyout.empty': 'Nada para escolher',
  'flyout.failed': 'Não foi possível carregar as opções',
  'crumbs.aria': 'Navegação de pastas',
  'suggestions.aria': 'Sugestões de gatilho',
} satisfies Record<keyof typeof en, string>
