/**
 * 符号大纲浮层：可筛选的符号列表 + ↑↓/Enter/点击跳转。
 *
 * 只在打开时挂载（父组件用 `undefined` 表示关闭），所以「关闭」就是卸载 —— 不会
 * 留下第二个 `isOpen` 状态要同步，也不会在关闭后留一个偷键盘的监听器。条目由
 * `outline-model.ts` 的纯函数产出；这里只负责像素、焦点和按键。
 *
 * PORTAL 到 `<body>`：编辑器有三种座位（侧栏 / 中间 / 浮窗），浮层若留在原 DOM
 * 里会被祖先的 `overflow: hidden` 裁掉。`.rvs-portal` 负责声明 `--rvs-*` token
 * 子集 —— portal 之后已经不在 `.rvs-root` 作用域内，缺了它颜色/边框全是空值。
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { matchPositions } from './quickopen-model.ts'
import {
  OUTLINE_RESULT_LIMIT,
  buildOutline,
  rankOutline,
  type OutlineEntry,
} from './outline-model.ts'

/** 一行：kind 徽标 + 缩进过的名字 + 行号。 */
function Row(props: {
  entry: OutlineEntry
  query: string
  active: boolean
  index: number
  id: string
  t: (key: string) => string
  onPick: () => void
  onHover: () => void
}): ReactNode {
  const { entry } = props
  // 高亮的位置来自 quickopen 的 `matchPositions`：与过滤用的是同一套贪心匹配，
  // 所以「为什么这行算命中」和「高亮哪几个字符」永远一致。
  const positions = useMemo(() => new Set(matchPositions(props.query, entry.name)), [props.query, entry.name])
  return (
    <div
      className={props.active ? 'rvs-outline-row active' : 'rvs-outline-row'}
      role="option"
      aria-selected={props.active}
      id={props.id}
      data-outline-index={props.index}
      data-outline-depth={entry.depth}
      data-outline-kind={entry.kind}
      // mousedown 而不是 click：列表不能在跳转前先丢焦点，而重排后的 click 可能
      // 落到用户没指的那一行上。
      onMouseDown={(event) => {
        event.preventDefault()
        props.onPick()
      }}
      onMouseEnter={props.onHover}
    >
      <span className="rvs-outline-kind" data-kind={entry.kind}>{props.t(`outline.kind.${entry.kind}`)}</span>
      <span
        className="rvs-outline-name"
        style={{ paddingLeft: `${entry.depth * 14}px` }}
        title={entry.container === undefined ? entry.name : `${entry.container} › ${entry.name}`}
      >
        {entry.name.split('').map((character, at) => (
          positions.has(at)
            ? <mark key={at} className="rvs-outline-hit">{character}</mark>
            : <span key={at}>{character}</span>
        ))}
      </span>
      <span className="rvs-outline-line">{entry.line}</span>
    </div>
  )
}

export function OutlinePanel(props: {
  t: (key: string) => string
  /** 远端绝对路径（判断语言 + 标题）。 */
  path: string
  /** 实时缓冲区全文：dirty 时必须来自编辑器，不是 `tab.text`。 */
  text: string
  onPick: (entry: OutlineEntry) => void
  onClose: () => void
}): ReactNode {
  // Two editor seats can keep an outline open at once; DOM ids must not collide.
  const listId = useId()
  const optionId = (index: number): string => `${listId}-option-${index}`
  const t = props.t
  const outline = useMemo(() => buildOutline(props.text, props.path), [props.text, props.path])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  /** 最新的关闭回调：window 监听只装一次，不能跟着每次渲染重装。 */
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  /** 关闭时把焦点还给打开它的那个元素（portal 自身不会恢复）。 */
  const openerRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      const opener = openerRef.current
      if (opener !== null && document.body.contains(opener)) opener.focus()
    }
  }, [])

  const ranked = useMemo(() => rankOutline(query, outline.entries, OUTLINE_RESULT_LIMIT), [query, outline])
  const count = ranked.hits.length
  const current = count === 0 ? -1 : Math.min(active, count - 1)

  // 新查询从第一行开始，绝不停在上一轮的旧行上。
  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    if (current < 0) return
    listRef.current?.querySelector<HTMLElement>(`[data-outline-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [current])

  const pick = (entry: OutlineEntry): void => {
    props.onPick(entry)
  }

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // 输入法候选窗用 Enter/方向键选字：此时按 Enter 就跳走等于打断中文输入。
    if (event.nativeEvent.isComposing === true || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (count === 0) return
      setActive((previous) => {
        const at = Math.min(previous, count - 1)
        if (event.key === 'ArrowDown') return (at + 1) % count
        return at <= 0 ? count - 1 : at - 1
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = current >= 0 ? ranked.hits[current] : undefined
      if (target !== undefined) pick(target)
    }
  }

  /** Tab 不许离开浮层：列表行不是焦点元素，Tab 会落到后面的页面元素上。 */
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const box = boxRef.current
    if (box === null) return
    const items = Array.from(box.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ))
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const at = document.activeElement
    const inside = at !== null && box.contains(at)
    if (!inside) {
      event.preventDefault()
      first?.focus()
      return
    }
    if (event.shiftKey && at === first) {
      event.preventDefault()
      last?.focus()
      return
    }
    if (!event.shiftKey && at === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  /**
   * 状态行。
   *
   * 「猜的大纲」与「被截断」是两条独立的常驻警告：它们说的是「这份列表不完整」，
   * 不能被「没有匹配」替换掉 —— 那个是查询的结果，不是数据的性质。
   */
  const foot = (): ReactNode => {
    if (count === 0) {
      return (
        <span className="rvs-outline-note" role="status">
          {outline.entries.length === 0 ? t('outline.empty') : t('outline.noResults')}
        </span>
      )
    }
    return (
      <span className="rvs-outline-note">
        {ranked.truncated
          ? t('outline.more').replace('{count}', String(count)).replace('{total}', String(outline.total))
          : `${count} / ${outline.total}`}
      </span>
    )
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="rvs-portal">
      <div
        className="rvs-outline-mask"
        onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose() }}
      >
        <div
          className="rvs-outline"
          role="dialog"
          aria-modal="true"
          aria-label={t('outline.title')}
          ref={boxRef}
          onKeyDown={onDialogKeyDown}
        >
          <div className="rvs-outline-head">
            <span className="rvs-outline-title">{t('outline.title')}</span>
            <span className="rvs-outline-path" title={props.path}>{props.path}</span>
            <button
              type="button"
              className="rvs-outline-close"
              title={t('common.close')}
              aria-label={t('common.close')}
              onClick={props.onClose}
            >
              ×
            </button>
          </div>
          <div className="rvs-outline-bar">
            <input
              ref={inputRef}
              className="rvs-outline-input"
              type="text"
              value={query}
              placeholder={t('outline.placeholder')}
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={current >= 0 ? optionId(current) : undefined}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
            <span className="rvs-outline-hint">{t('outline.hint')}</span>
          </div>
          <div className="rvs-outline-list" id={listId} role="listbox" ref={listRef}>
            {ranked.hits.map((entry, index) => (
              <Row
                key={`${entry.line}:${entry.name}:${index}`}
                entry={entry}
                query={query}
                active={index === current}
                index={index}
                id={optionId(index)}
                t={t}
                onPick={() => pick(entry)}
                onHover={() => setActive(index)}
              />
            ))}
          </div>
          <div className="rvs-outline-foot">
            {foot()}
            {outline.guessed && (
              <span className="rvs-outline-note warn" role="status">{t('outline.guessed')}</span>
            )}
            {outline.truncated && (
              <span className="rvs-outline-note warn" role="status">
                {t('outline.truncated').replace('{count}', String(outline.entries.length))}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
