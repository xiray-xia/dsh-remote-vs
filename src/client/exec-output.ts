/**
 * Pure helpers behind the streaming exec surface (the network verbs' live log).
 *
 * The host route answers as server-sent events so a 20-minute push can show its
 * progress (`remote: …`, hook output, pack lines) while it runs, instead of one
 * line after the fact. Everything here is pure so the local self-check can pin
 * the frame splitting (a chunk boundary may fall anywhere) and the output cap
 * without a browser or a host.
 */
import { DEFAULT_NETWORK_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../timeouts.ts'
import { fetchCommand, pullCommand, pushCommand, pushRefspecCommand } from '../git-ops.ts'

/** What a streamed push should do: remembered refspec ('' = plain) + remote. */
export interface PushTarget {
  refspec: string
  remote: string
}

/**
 * The commands one network verb runs, in order.
 *
 * Pure so the gate can pin the sequence: sync is pull-then-push (the historical
 * order), and a push with a refspec must not fall back to the bare form.
 */
export function networkCommands(root: string, kind: 'fetch' | 'pull' | 'push' | 'sync', push: PushTarget): string[] {
  if (kind === 'fetch') return [fetchCommand(root)]
  if (kind === 'pull') return [pullCommand(root)]
  const pushCmd = push.refspec === '' ? pushCommand(root) : pushRefspecCommand(root, push.remote, push.refspec)
  if (kind === 'push') return [pushCmd]
  // Sync keeps its historical order, and honours a refspec when one is given
  // (the UI currently passes '' for sync, but the API must not quietly drop it).
  return [pullCommand(root), pushCmd]
}

/** Live-log cap: keep the TAIL, because the head of a long push is never the point. */
export const EXEC_OUTPUT_CAP = 200_000

/**
 * Fold carriage-return progress rewrites for DISPLAY.
 *
 * git's progress lines are written as `Counting: 1%\rCounting: 2%\r…` and a
 * `<pre>` would render every rewrite as its own line (hundreds of them for one
 * push). Only the content after the last `\r` of a line survives.
 *
 * Fold at RENDER time, over the complete accumulated text — not inside
 * `appendExecOutput`. A chunk can end mid-rewrite (git writes bare `\r`s at
 * arbitrary boundaries), and folding a fragment loses the state that the next
 * fragment continues: measured against real `git push --progress` stderr, the
 * per-chunk fold glued `Counting: 1%Counting: 2%…` into one long line.
 */
export function foldExecOutput(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map(line => {
      if (!line.includes('\r')) return line
      // A trailing `\r` (progress finished, then newline) does not erase what
      // was drawn before it: the visible text is the last NON-EMPTY rewrite.
      const parts = line.split('\r')
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index] as string
        if (part !== '') return part
      }
      return ''
    })
    .join('\n')
}

/**
 * Append one decoded chunk, keeping the TAIL.
 *
 * The raw `\r` bytes are preserved on purpose: the view folds them once, over
 * the whole accumulated log, so a rewrite split across two chunks still folds
 * correctly (`foldExecOutput`).
 */
export function appendExecOutput(previous: string, chunk: string, cap = EXEC_OUTPUT_CAP): string {
  if (chunk === '') return previous
  const combined = previous + chunk
  if (combined.length <= cap) return combined
  return combined.slice(combined.length - cap)
}

/**
 * Split an SSE buffer into complete frames and the incomplete tail.
 *
 * A chunk can end in the middle of `data: {...}` or between the two newlines
 * that terminate a frame, so the caller must carry `rest` into the next read.
 */
export function takeSseFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  return { frames: parts.filter(frame => frame.trim() !== ''), rest }
}

/**
 * One SSE frame's JSON payload; `undefined` for comments (heartbeats), empty
 * frames and malformed JSON — a broken heartbeat must not kill the stream.
 */
export function parseSseFrame(frame: string): unknown | undefined {
  const data = frame
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (data === '') return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

/** `m:ss` (or `h:mm:ss`) for the running timer. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * The network verbs' budget: at least 20 minutes, or twice the configured git
 * budget when that is larger, never past the host's 30-minute ceiling.
 */
export function networkBudgetMs(gitTimeoutMs: number): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(DEFAULT_NETWORK_TIMEOUT_MS, gitTimeoutMs * 2))
}
