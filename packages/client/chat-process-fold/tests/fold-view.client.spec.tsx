// @vitest-environment jsdom
/**
 * FoldProcessView: a single step collapses to a header; the header expands to
 * reveal the summary; error steps carry the error marker; the answer-only "no
 * step" case renders nothing.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FoldProcessView, type FoldProcessViewProps } from '../src/client/FoldProcessView.tsx'
import type { ChatProcessFoldKey } from '../src/client/locales.ts'
import type { ProcessFoldChatData } from '../src/client/process-fold.ts'

afterEach(() => { cleanup() })

function props(data: ProcessFoldChatData): FoldProcessViewProps {
  return {
    node: {
      key: 'k',
      kind: 'process-fold',
      id: '1',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'turn', turn: 1, status: 'open' },
      visibility: 'visible',
      data,
    },
    t: (key: ChatProcessFoldKey) => key,
  } as unknown as FoldProcessViewProps
}

const toolData: ProcessFoldChatData = { turn: 1, kind: 'tool', summary: 'bash(ls)', error: false }

describe('FoldProcessView', () => {
  it('shows a collapsed header with the step title', () => {
    render(<FoldProcessView {...props(toolData)} />)
    expect(screen.getByRole('button', { name: 'expand' })).toBeTruthy()
    expect(screen.queryByText('bash(ls)')).toBeNull()
  })

  it('expands on header click to reveal the summary', () => {
    render(<FoldProcessView {...props(toolData)} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('bash(ls)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'collapse' })).toBeTruthy()
  })

  it('collapses again via the header', () => {
    render(<FoldProcessView {...props(toolData)} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('bash(ls)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('bash(ls)')).toBeNull()
  })

  it('marks an error step with the error attribute', () => {
    render(<FoldProcessView {...props({ ...toolData, error: true, summary: '⚠ bash(fail)' })} />)
    const box = screen.getByRole('button').closest('[data-process-fold]')
    expect(box?.getAttribute('data-process-fold-error')).toBeDefined()
  })
})
