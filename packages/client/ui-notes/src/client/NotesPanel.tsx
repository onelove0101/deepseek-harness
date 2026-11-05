/**
 * The notes / sticky-notes panel opened by the sidebar entry. Opens on a
 * sticky-note wall (masonry of paper cards); notes persist to the browser's
 * localStorage so entries survive reloads and process restarts.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import styles from './NotesPanel.module.css'

type Kind = 'note' | 'sticky'

/** One stored note or sticky note. */
interface Note {
  id: string
  kind: Kind
  title: string
  content: string
  color: string
  createdAt: string
  updatedAt: string
}

/** Editor draft: `id` is null while creating. */
interface Draft {
  id: string | null
  fields: { title: string; kind: Kind; color: string; content: string }
}

type Filter = 'all' | Kind

const KEY = 'dsh.notes.v1'
const PAPER_COLORS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '#fde68a', label: '柠檬黄' },
  { value: '#fbcfe8', label: '樱花粉' },
  { value: '#bfdbfe', label: '天空蓝' },
  { value: '#bbf7d0', label: '薄荷绿' },
  { value: '#ddd6fe', label: '薰衣草' },
  { value: '#fed7aa', label: '暖橙' },
]
const DEFAULT_COLOR = '#fde68a'
const KIND_LABEL: Record<Kind, string> = { note: '笔记', sticky: '便签' }
const FILTERS: ReadonlyArray<readonly [Filter, string]> = [['sticky', '便签'], ['note', '笔记'], ['all', '全部']]

function load(): Note[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Note[]) : []
  } catch {
    return []
  }
}

function save(list: Note[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // Storage may be unavailable (private mode / quota); notes then live for this page only.
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Stable tilt in [-1.6deg, 1.6deg] so a card keeps its angle across renders. */
function tiltOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) % 997
  }
  return ((h % 33) - 16) / 10
}

const emptyFields = (kind: Kind): Draft['fields'] => ({ title: '', kind, color: DEFAULT_COLOR, content: '' })

/**
 * The notes panel body; ignores the main-slot standard props and drives all
 * of its own state locally.
 */
export function NotesPanel(_props: PropsRuntime<'main'>): ReactNode {
  const [notes, setNotes] = useState<Note[]>(load)
  const [filter, setFilter] = useState<Filter>('sticky')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const commit = (next: Note[]): void => {
    setNotes(next)
    save(next)
  }

  const counts = useMemo(() => ({
    all: notes.length,
    note: notes.filter(n => n.kind === 'note').length,
    sticky: notes.filter(n => n.kind === 'sticky').length,
  }), [notes])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes
      .filter(n => filter === 'all' || n.kind === filter)
      .filter(n => !q || `${n.title}\n${n.content}`.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }, [notes, filter, query])

  const beginNew = (): void => {
    setDraft({ id: null, fields: emptyFields(filter === 'note' ? 'note' : 'sticky') })
  }
  const beginEdit = (n: Note): void => {
    setDraft({ id: n.id, fields: { title: n.title, kind: n.kind, color: n.color, content: n.content } })
  }
  const closeEditor = (): void => setDraft(null)

  const setFields = (patch: Partial<Draft['fields']>): void => {
    if (draft) {
      setDraft({ ...draft, fields: { ...draft.fields, ...patch } })
    }
  }

  const handleSave = (): void => {
    if (!draft) {
      return
    }
    const f = draft.fields
    if (!f.title.trim() && !f.content.trim()) {
      closeEditor()
      return
    }
    const stamp = new Date().toISOString()
    if (draft.id === null) {
      const fresh: Note = {
        ...f,
        title: f.title.trim(),
        id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        createdAt: stamp,
        updatedAt: stamp,
      }
      commit([fresh, ...notes])
    } else {
      commit(notes.map(n => (n.id === draft.id ? { ...n, ...f, title: f.title.trim(), updatedAt: stamp } : n)))
    }
    closeEditor()
  }

  const handleDelete = (id: string): void => {
    if (confirmId !== id) {
      setConfirmId(id)
      return
    }
    setConfirmId(null)
    commit(notes.filter(n => n.id !== id))
  }

  if (draft) {
    const f = draft.fields
    const paper = f.kind === 'sticky' ? f.color : undefined
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <h2 className={styles.heading}>{draft.id === null ? '新建' : '编辑'}{KIND_LABEL[f.kind]}</h2>
          <button type="button" className={styles.ghostBtn} onClick={closeEditor}>返回</button>
        </div>
        <div
          className={`${styles.editor} ${paper ? styles.editorPaper : ''}`}
          style={paper ? ({ '--paper': paper } as CSSProperties) : undefined}
        >
          <div className={styles.editorTop}>
            <div className={styles.segment} role="tablist">
              {(['sticky', 'note'] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={f.kind === k}
                  className={`${styles.segBtn} ${f.kind === k ? styles.segOn : ''}`}
                  onClick={() => setFields({ kind: k })}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            {f.kind === 'sticky' && (
              <div className={styles.swatches}>
                {PAPER_COLORS.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    aria-label={c.label}
                    title={c.label}
                    className={`${styles.swatch} ${f.color === c.value ? styles.swatchOn : ''}`}
                    style={{ background: c.value }}
                    onClick={() => setFields({ color: c.value })}
                  />
                ))}
              </div>
            )}
          </div>
          <input
            className={styles.titleInput}
            type="text"
            placeholder="标题"
            autoFocus
            value={f.title}
            onChange={e => setFields({ title: e.target.value })}
          />
          <textarea
            className={styles.bodyInput}
            placeholder="写点什么…"
            value={f.content}
            onChange={e => setFields({ content: e.target.value })}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                handleSave()
              }
            }}
          />
          <div className={styles.editorFoot}>
            <span className={styles.hint}>⌘/Ctrl + Enter 保存</span>
            <div className={styles.editorBtns}>
              <button type="button" className={styles.ghostBtn} onClick={closeEditor}>取消</button>
              <button type="button" className={styles.primaryBtn} onClick={handleSave}>保存</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading}>{filter === 'note' ? '笔记' : filter === 'all' ? '全部' : '便签墙'}</h2>
          <p className={styles.sub}>{visible.length} 条{query.trim() ? '匹配' : ''}</p>
        </div>
        <div className={styles.tools}>
          <input
            className={styles.search}
            type="search"
            placeholder="搜索…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <button type="button" className={styles.primaryBtn} onClick={beginNew}>＋ 新建</button>
        </div>
      </div>
      <div className={styles.segment} role="tablist">
        {FILTERS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={filter === k}
            className={`${styles.segBtn} ${filter === k ? styles.segOn : ''}`}
            onClick={() => setFilter(k)}
          >
            {label}<span className={styles.count}>{counts[k]}</span>
          </button>
        ))}
      </div>
      <div className={styles.wall}>
        <button type="button" className={styles.addCard} onClick={beginNew}>
          <span className={styles.plus}>＋</span>
          <span>{filter === 'note' ? '新笔记' : '新便签'}</span>
        </button>
        {visible.map((n) => {
          const sticky = n.kind === 'sticky'
          const style = {
            '--paper': sticky ? n.color : undefined,
            '--tilt': sticky ? `${tiltOf(n.id)}deg` : '0deg',
          } as CSSProperties
          return (
            <article
              key={n.id}
              className={`${styles.card} ${sticky ? styles.sticky : styles.plain}`}
              style={style}
              onClick={() => beginEdit(n)}
              onMouseLeave={() => confirmId === n.id && setConfirmId(null)}
            >
              {sticky && <span className={styles.tape} aria-hidden="true" />}
              <button
                type="button"
                className={`${styles.del} ${confirmId === n.id ? styles.delConfirm : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete(n.id)
                }}
              >
                {confirmId === n.id ? '确认删除' : '✕'}
              </button>
              {filter === 'all' && <span className={styles.kindTag}>{KIND_LABEL[n.kind]}</span>}
              <h3 className={styles.cardTitle}>{n.title || '无标题'}</h3>
              {n.content && <p className={styles.cardText}>{n.content}</p>}
              <time className={styles.time}>{fmtTime(n.updatedAt)}</time>
            </article>
          )
        })}
      </div>
      {visible.length === 0 && (
        <div className={styles.empty}>{query.trim() ? '没有匹配的内容' : '墙上还空着,贴上第一张吧。'}</div>
      )}
    </div>
  )
}
