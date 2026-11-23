/**
 * xterm.js wrapper over the /api/dsh-remote/terminal WebSocket. Mount-once;
 * the parent remounts (key) to (re)connect. Reports the server session id
 * for refresh-safe reattach and the exit state for the view chrome.
 */
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalClientFrame, TerminalServerFrame } from '../protocol.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { ContextMenu, useContextMenu, type MenuEntry } from './vsc/kit.tsx'
import {
  createPasteFallback,
  stripBracketedPasteMarkers,
  terminalKeyCommand,
  terminalMenuState,
} from './vsc/terminal-clipboard.ts'
import { terminalTheme } from './vsc/terminal-theme.ts'

/**
 * Send one frame; `false` means it was NOT handed to the socket.
 *
 * The caller that tracks "the PTY already knows this size" depends on that
 * answer (see `pushSize`): recording a size that never left is how a terminal
 * used to sit at the URL's 80x24 for the rest of its life.
 */
function send(ws: WebSocket, frame: TerminalClientFrame): boolean {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch {
      // Socket raced away.
      return false
    }
  }
  return false
}

/** Clipboard write with a legacy execCommand fallback (non-secure contexts). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** Clipboard read; undefined when the browser denies it. */
async function readClipboard(): Promise<string | undefined> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return undefined
  }
}

export function XTerm(props: {
  wsUrl: string
  onReady: (id: string) => void
  onExit: (code: number | null, message?: string) => void
  fontFamily?: string
  /** When the parent sub-tab hides/shows this view without unmounting. */
  visible?: boolean
  /**
   * Line typed into the fresh shell once its PTY reports ready (a menu entry's
   * `cd`). Sent ONCE per mount: a reconnect is a new mount and thus a new shell,
   * which correctly re-runs the line.
   */
  initialInput?: string
  /** Translator for the right-click menu (copy / paste / select all). */
  t: (key: string) => string
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const liveRef = useRef<{ refit: () => void } | undefined>(undefined)
  // The context menu lives at component level (portal); the mount-once effect
  // reaches it through refs, the same pattern the explorer row uses.
  const menu = useContextMenu()
  const openMenuRef = useRef(menu.open)
  openMenuRef.current = menu.open
  const tRef = useRef(props.t)
  tRef.current = props.t

  // Shown again after being hidden: refit and push the size.
  useEffect(() => {
    if (props.visible === false) return
    liveRef.current?.refit()
  }, [props.visible])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: propsRef.current.fontFamily ?? 'var(--ds-font-family-code, ui-monospace, monospace)',
      minimumContrastRatio: 7,
      theme: terminalTheme(isDarkScheme()),
    })
    // Re-theme live when the user flips the DSH scheme.
    const unflip = subscribeColorScheme(() => {
      try {
        term.options.theme = terminalTheme(isDarkScheme())
      } catch {
        // Terminal gone.
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const ws = new WebSocket(propsRef.current.wsUrl)
    let opened = false
    /**
     * True once the HOST said `ready` for this socket.
     *
     * Frames sent before that are lost, not queued: the host only attaches its
     * message listener after the shell exists (a cold dial takes seconds), so a
     * `resize` sent on the WebSocket `open` event never reached the PTY — and
     * because the client had already recorded the size, the later push (once the
     * host was listening) was deduped away. The shell then stayed at the URL's
     * 80x24 for its whole life. Sizes are only sent after `ready`.
     */
    let hostReady = false
    /** The seeded line is typed at most once per mount (a reconnect re-mounts). */
    let seeded = false
    let exitReported = false
    const reportExit = (code: number | null, message?: string): void => {
      if (exitReported) return
      exitReported = true
      propsRef.current.onExit(code, message)
    }

    /**
     * Size last pushed to the PTY (`0` = nothing sent yet, so the first push
     * always goes). Declared BEFORE `pushSize` reads it: a `let` declared below
     * would be in its temporal dead zone on the first call.
     */
    let lastSize = { cols: 0, rows: 0 }
    const pushSize = (): void => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return
      try {
        fit.fit()
      } catch {
        // Not laid out yet.
      }
      // Nothing may be sent before the host is listening (see `hostReady`); the
      // `ready` handler pushes the measured size itself.
      if (!hostReady) return
      // Only a CHANGED size is news: the observer fires on every pixel of a
      // window drag, and a resize frame per tick makes the remote shell re-run
      // SIGWINCH handling (full-screen apps redraw) for nothing.
      if (term.cols === lastSize.cols && term.rows === lastSize.rows) return
      // Record the size only once it really left: the observer can fire before
      // the socket is OPEN (and `send` then drops the frame), and remembering a
      // size the PTY never received left the shell at the URL's 80x24 until the
      // user dragged the window.
      const sent = send(ws, { t: 'resize', cols: term.cols, rows: term.rows })
      if (sent) lastSize = { cols: term.cols, rows: term.rows }
    }
    liveRef.current = {
      refit: () => {
        pushSize()
        try {
          term.focus()
        } catch {
          // Ignore.
        }
      },
    }

    /**
     * Terminal input, chunked because `onData` hands over a whole PASTE at
     * once: the host refuses frames past its own cap (it will not parse them),
     * so one large paste would otherwise drop the connection. Splitting on code
     * points keeps surrogate pairs whole; 64 Ki characters is at most 256 KiB of
     * UTF-8, and ~384 KiB once JSON escapes the worst case of control
     * characters — far under that cap either way, and far above a keystroke.
     */
    const INPUT_CHUNK_CHARS = 64 * 1024
    const sendInput = (rawData: string): void => {
      const data = stripBracketedPasteMarkers(rawData)
      if (data === '') return
      if (data.length <= INPUT_CHUNK_CHARS) {
        send(ws, { t: 'in', d: data })
        return
      }
      let chunk = ''
      for (const character of data) {
        if (chunk.length + character.length > INPUT_CHUNK_CHARS) {
          send(ws, { t: 'in', d: chunk })
          chunk = ''
        }
        chunk += character
      }
      if (chunk !== '') send(ws, { t: 'in', d: chunk })
    }
    term.onData(sendInput)

    /**
     * Output writer: at most ONE `term.write` in flight, and everything that
     * arrives meanwhile is concatenated into the next one.
     *
     * Why: a busy command (`dmesg`, `cat` of a log) delivers a burst of frames.
     * xterm already time-slices its own parser, so the win is not CPU per byte
     * but the per-call bookkeeping and the queue churn — and, more importantly,
     * ordering: the exit/error notices below go through the same queue, so they
     * can never overtake output that has not been parsed yet. An idle terminal
     * still writes the first frame immediately (no added typing/echo latency);
     * only BackPRESSURE-shaped bursts coalesce.
     */
    let writeQueue: string[] = []
    let writeBusy = false
    const flushWrites = (): void => {
      if (writeBusy || writeQueue.length === 0) return
      const chunk = writeQueue.length === 1 ? writeQueue[0] : writeQueue.join('')
      writeQueue = []
      writeBusy = true
      try {
        term.write(chunk, () => {
          writeBusy = false
          flushWrites()
        })
      } catch {
        // Terminal disposed mid-write.
        writeBusy = false
      }
    }
    const writeOut = (text: string): void => {
      if (text === '') return
      writeQueue.push(text)
      flushWrites()
    }
    ws.addEventListener('open', () => {
      opened = true
      pushSize()
    })
    ws.addEventListener('message', (event) => {
      let frame: TerminalServerFrame
      try {
        frame = JSON.parse(String(event.data)) as TerminalServerFrame
      } catch {
        return
      }
      if (frame.t === 'ready') {
        hostReady = true
        // The host is listening now: apply the size this client really has.
        pushSize()
        propsRef.current.onReady(frame.id)
        // The shell exists now: type the seeded line (a menu entry's `cd`), as a
        // normal input line so the shell echoes it and redraws its prompt.
        const seed = propsRef.current.initialInput
        if (!seeded && seed !== undefined && seed !== '') {
          seeded = true
          send(ws, { t: 'in', d: `${seed}\n` })
        }
      } else if (frame.t === 'out') {
        writeOut(frame.d)
      } else if (frame.t === 'exit') {
        reportExit(frame.code)
        try {
          ws.close()
        } catch {
          // Ignore.
        }
      } else if (frame.t === 'error') {
        writeOut(`\r\n[dsh-remote] ${frame.message}\r\n`)
        reportExit(null, frame.message)
      }
    })
    const onClose = (): void => {
      if (!opened) reportExit(null, 'websocket refused')
      else reportExit(null)
    }
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', () => {
      if (!opened) reportExit(null, 'websocket error')
    })

    const resizeObserver = new ResizeObserver(() => pushSize())
    resizeObserver.observe(host)
    const onWindowResize = (): void => pushSize()
    window.addEventListener('resize', onWindowResize)
    // Late layout (tab switch): refit shortly after mount too.
    const timer = window.setTimeout(pushSize, 300)

    // Clipboard (VS Code / Windows Terminal conventions; plain Ctrl+C stays SIGINT):
    // copy = Ctrl+Shift+C / Cmd+C / Ctrl+Insert, paste = Ctrl+Shift+V / Cmd+V /
    // Shift+Insert. Handled chords call preventDefault() THEMSELVES: returning
    // false only stops xterm, and the browser would then run its own default
    // (Chrome maps Ctrl+Shift+V to paste-as-plain-text, which double-pasted).
    // Plain Ctrl+V is left to the browser first; when no paste event arrives the
    // Clipboard API fallback fires (some shells swallow the native paste).
    const doCopy = (clear: boolean): void => {
      const selection = term.getSelection()
      if (selection === '') return
      void copyText(selection).then((ok) => {
        if (!ok) term.write('\r\n[dsh-remote] clipboard write denied by the browser\r\n')
        else if (clear) term.clearSelection()
      })
    }
    const doPaste = (): void => {
      void readClipboard().then((text) => {
        if (text === undefined) {
          term.write('\r\n[dsh-remote] clipboard read denied by the browser\r\n')
          return
        }
        term.paste(text)
      })
    }
    const pasteFallback = createPasteFallback({
      read: readClipboard,
      paste: (text) => { term.paste(text) },
      onDenied: () => { term.write('\r\n[dsh-remote] clipboard read denied by the browser\r\n') },
    })
    /**
     * All paste input converges here: one insertion per paste event.
     *
     * Capture phase + stopPropagation keeps xterm's own textarea handler from
     * inserting a second copy, and preventDefault stops the browser's remaining
     * default. The watcher is cancelled so the Clipboard-API fallback (for hosts
     * that never deliver this event) does not fire on top of it.
     */
    /**
     * Explicit paste chords (Ctrl+Shift+V / Cmd+V / Shift+Insert) insert through
     * the Clipboard API themselves. Some hosts still deliver the browser's native
     * paste afterwards even when the keydown was preventDefault-ed (observed with
     * Ctrl+Shift+V paste-as-plain-text), which pasted twice. This window swallows
     * that native delivery; plain Ctrl+V keeps the native path below.
     */
    let suppressNativePasteUntil = 0
    const onPasteEvent = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (Date.now() < suppressNativePasteUntil) {
        // The explicit chord already inserted this paste through the API.
        suppressNativePasteUntil = 0
        return
      }
      const text = e.clipboardData?.getData('text/plain') ?? ''
      pasteFallback.observed()
      if (text !== '') term.paste(text)
    }
    host.addEventListener('paste', onPasteEvent, true)
    term.attachCustomKeyEventHandler((e) => {
      // `terminalKeyCommand` answers undefined for keyup/keypress: xterm invokes
      // this hook for all three, and acting on keyup pasted twice.
      const chord = terminalKeyCommand({
        type: e.type,
        key: e.key,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
      })
      if (chord === undefined) return true
      if (chord === 'copy-interrupt') {
        // Ctrl+C: with a selection the convention is COPY (never SIGINT); without
        // one the key falls through so the remote shell interrupts as usual.
        if (!term.hasSelection()) return true
        e.preventDefault()
        doCopy(false)
        return false
      }
      if (chord === 'paste') {
        // Explicit paste chord: insert ONCE through the Clipboard API and swallow
        // the browser's native delivery for this gesture (some hosts ignore the
        // keydown preventDefault and paste again).
        e.preventDefault()
        suppressNativePasteUntil = Date.now() + 600
        doPaste()
        return false
      }
      if (chord === 'paste-native') {
        // Plain Ctrl+V: the browser's native paste is the primary path; when the
        // host swallows it, the watcher falls back to the Clipboard API.
        pasteFallback.arm()
        return true
      }
      // Copy: with nothing selected the key belongs to the terminal/browser.
      if (!term.hasSelection()) return true
      e.preventDefault()
      doCopy(false)
      return false
    })
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      const hasSelection = term.hasSelection()
      const entries: MenuEntry[] = [
        {
          label: tRef.current('term.copy'),
          disabled: terminalMenuState({ hasSelection }).copyDisabled,
          onSelect: () => { doCopy(false); term.focus() },
        },
        { label: tRef.current('term.paste'), onSelect: () => { doPaste(); term.focus() } },
        { label: tRef.current('term.selectAll'), separated: true, onSelect: () => { term.selectAll(); term.focus() } },
      ]
      openMenuRef.current(e.clientX, e.clientY, entries)
    }
    host.addEventListener('contextmenu', onContextMenu)

    term.focus()
    return () => {
      liveRef.current = undefined
      unflip()
      window.clearTimeout(timer)
      window.removeEventListener('resize', onWindowResize)
      host.removeEventListener('paste', onPasteEvent, true)
      host.removeEventListener('contextmenu', onContextMenu)
      resizeObserver.disconnect()
      try {
        ws.close()
      } catch {
        // Ignore.
      }
      term.dispose()
    }
    // Mount-once: the parent remounts (key) to reconnect or switch sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <div ref={hostRef} style={{ height: '100%', minHeight: 200 }} />
      {menu.menu !== undefined && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} entries={menu.menu.entries} onClose={menu.close} />
      )}
    </>
  )
}
