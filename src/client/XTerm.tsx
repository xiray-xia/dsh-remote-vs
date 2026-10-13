/**
 * xterm.js wrapper over the /api/dsh-remote/terminal WebSocket. Mount-once;
 * the parent remounts (key) to (re)connect. Reports the server session id
 * for refresh-safe reattach and the exit state for the view chrome.
 */
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalClientFrame, TerminalServerFrame } from '../protocol.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'

function send(ws: WebSocket, frame: TerminalClientFrame): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // Socket raced away.
    }
  }
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

/** Opaque high-readability palette (opaque: the contrast engine cannot reason about transparency). */
function buildTheme(dark: boolean): ITheme {
  return dark
    ? {
        background: '#0e0e13',
        foreground: '#e8e8e8',
        cursor: '#e8e8e8',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e910',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#7a7a7a',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      }
    : {
        background: '#ffffff',
        foreground: '#1a1a1a',
        cursor: '#1a1a1a',
        black: '#000000',
        red: '#cd3131',
        green: '#00bc67',
        yellow: '#949800',
        blue: '#0451a5',
        magenta: '#bc05bc',
        cyan: '#0598bc',
        white: '#555555',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      }
}

export function XTerm(props: {
  wsUrl: string
  onReady: (id: string) => void
  onExit: (code: number | null, message?: string) => void
  fontFamily?: string
  /** When the parent sub-tab hides/shows this view without unmounting. */
  visible?: boolean
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const liveRef = useRef<{ refit: () => void } | undefined>(undefined)

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
      theme: buildTheme(isDarkScheme()),
    })
    // Re-theme live when the user flips the DSH scheme.
    const unflip = subscribeColorScheme(() => {
      try {
        term.options.theme = buildTheme(isDarkScheme())
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
    let exitReported = false
    const reportExit = (code: number | null, message?: string): void => {
      if (exitReported) return
      exitReported = true
      propsRef.current.onExit(code, message)
    }

    const pushSize = (): void => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return
      try {
        fit.fit()
      } catch {
        // Not laid out yet.
      }
      send(ws, { t: 'resize', cols: term.cols, rows: term.rows })
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

    term.onData((data) => send(ws, { t: 'in', d: data }))
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
        propsRef.current.onReady(frame.id)
      } else if (frame.t === 'out') {
        term.write(frame.d)
      } else if (frame.t === 'exit') {
        reportExit(frame.code)
        try {
          ws.close()
        } catch {
          // Ignore.
        }
      } else if (frame.t === 'error') {
        term.write(`\r\n[dsh-remote] ${frame.message}\r\n`)
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

    // Copy/paste (Windows Terminal conventions; plain Ctrl+C stays SIGINT):
    // Ctrl+Shift+C / Cmd+C / Ctrl+Insert = copy, Ctrl+Shift+V / Cmd+V /
    // Shift+Insert = paste, right-click = copy when selecting else paste.
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
    term.attachCustomKeyEventHandler((e) => {
      const key = e.key.toLowerCase()
      const copyKey = (!e.metaKey && e.ctrlKey && ((e.shiftKey && key === 'c') || (!e.shiftKey && e.key === 'Insert')))
        || (e.metaKey && !e.ctrlKey && key === 'c')
      const pasteKey = (!e.metaKey && e.ctrlKey && e.shiftKey && key === 'v')
        || (e.metaKey && !e.ctrlKey && key === 'v')
        || (!e.ctrlKey && !e.metaKey && e.shiftKey && e.key === 'Insert')
      if (copyKey) {
        if (term.hasSelection()) {
          doCopy(false)
          return false
        }
        return true
      }
      if (pasteKey) {
        doPaste()
        return false
      }
      return true
    })
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (term.hasSelection()) doCopy(true)
      else doPaste()
    }
    host.addEventListener('contextmenu', onContextMenu)

    term.focus()
    return () => {
      liveRef.current = undefined
      unflip()
      window.clearTimeout(timer)
      window.removeEventListener('resize', onWindowResize)
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

  return <div ref={hostRef} style={{ height: '100%', minHeight: 200 }} />
}
