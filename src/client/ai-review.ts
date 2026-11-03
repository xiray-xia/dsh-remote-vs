/**
 * "Review this diff with AI" (F6): the pure half — byte accounting, the size
 * tier decision and the prompt builder. No React, no DOM, no host access: the
 * button in `scm/DiffView.tsx` calls these and hands the result to
 * `appendToDraft` (`composer.ts`), the ONE delivery channel v1 uses.
 *
 * Why the byte accounting is not optional
 * ---------------------------------------
 * `git diff` runs through `capped()` in `git-ops.ts`: `| head -c GIT_CAP`, and
 * `RemoteExecResult` carries no `truncated` flag — the cut is SILENT. Sending
 * such a prefix as "the diff" produces a confident review of half a patch: a
 * wrong answer with no marker anywhere. So the caller compares BYTES against
 * `GIT_CAP`, and `pickReviewMode` refuses `full` for a capped diff even when the
 * prefix would fit the inline budget: a truncated diff can never be reviewed as
 * if it were complete.
 *
 * Two thresholds, two different jobs:
 *  - `GIT_CAP` (2,000,000 B, `git-ops.ts`): the read was CUT, so the prompt's
 *    FIRST line has to say so.
 *  - `AI_REVIEW_MAX_BYTES` (32 KiB ≈ 8–10k tokens): above it the diff is not
 *    inlined at all. The prompt carries the file, the scope and the `@@` hunk
 *    headers, and tells the model to fetch the diff itself (a read or a
 *    `git diff` on the remote host) instead of spending a whole context window
 *    on one message — 2 MB would be ~550–700k tokens and could never be sent.
 *
 * The fence length is computed, never hardcoded: a file that CONTAINS ``` would
 * close a 3-backtick fence early and the rest of the patch would be read as
 * prose. One backtick more than the longest run inside makes that impossible.
 */
import { GIT_CAP } from '../git-ops.ts'

/** Largest complete diff we inline into the prompt, in BYTES (≈8–10k tokens). */
export const AI_REVIEW_MAX_BYTES = 32 * 1024

/** How many `@@` headers a summary prompt enumerates before it stops. */
export const AI_REVIEW_MAX_HUNKS = 40

/** How much of the diff the prompt carries. */
export type ReviewMode = 'full' | 'summary' | 'pathOnly'

/** Which revision range the diff describes (the SCM view's three diff tabs). */
export type ReviewScope = 'worktree' | 'staged' | 'commit'

/** Prompt language. Follows the UI language (`store.lang`), no separate setting. */
export type ReviewLang = 'zh' | 'en'

/** Everything the prompt template needs, all of it already in the caller's hands. */
export interface ReviewPromptInput {
  /** SSH host alias the diff was read from (named in the prompt, no secrets). */
  alias: string
  /** Repository root on that host (absolute POSIX path). */
  root: string
  /** Repository-relative path of the file. */
  rel: string
  /** Absolute remote path of the file. */
  fullPath: string
  scope: ReviewScope
  /** The commit the diff was drilled down from, for `scope: 'commit'`. */
  commitRef?: string
  /** Unified diff text (`tab.diff.diff`), possibly empty for untracked/binary. */
  diff: string
  mode: ReviewMode
  /** The diff is a `GIT_CAP`-capped PREFIX (the host truncated it silently). */
  capped: boolean
  lang: ReviewLang
}

/** UTF-8 byte length — the unit `head -c` and therefore `GIT_CAP` count. */
export function diffByteLength(diff: string): number {
  return new TextEncoder().encode(diff).length
}

/**
 * Which revision range a diff tab shows.
 *
 * `ref` wins over `staged`, and that order is load-bearing: a commit drill-down
 * tab is BOTH `staged: true` and `ref: hash` (`store.openCommitFile`), so asking
 * `staged` first would label a commit's diff as "staged changes" and point the
 * model at the index instead of the commit.
 */
export function reviewScopeOf(staged: boolean, ref: string | undefined): ReviewScope {
  if (ref !== undefined) return 'commit'
  if (staged) return 'staged'
  return 'worktree'
}

/**
 * Which prompt shape this diff gets.
 *
 * Order matters. `pathOnly` answers "there is no diff text at all" (untracked /
 * binary / failed read) and outranks the rest because it needs no budget.
 * `capped` outranks the size test: a 1 KiB prefix of a 2 MB patch is not a
 * small diff, it is a CUT one. Only a complete, small diff earns `full`.
 */
export function pickReviewMode(input: { bytes: number; hasDiff: boolean; capped: boolean }): ReviewMode {
  if (!input.hasDiff) return 'pathOnly'
  if (input.capped) return 'summary'
  if (input.bytes <= AI_REVIEW_MAX_BYTES) return 'full'
  return 'summary'
}

/** Longest unbroken run of backticks in `text` (0 when there is none). */
export function longestBacktickRun(text: string): number {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) {
    if (run[0].length > longest) longest = run[0].length
  }
  return longest
}

/**
 * A code fence `diff` itself cannot close: one backtick longer than the longest
 * run inside it, never shorter than the usual three.
 */
export function diffFence(diff: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(diff) + 1))
}

/**
 * The `@@ … @@` hunk headers of a unified diff, in order.
 *
 * A line starting with `@@` can only be a header: every content line of a
 * unified diff begins with ' ', '+' or '-', and the file-level lines begin with
 * `diff --git`, `index`, `---`, `+++`, `new file` or `deleted file`.
 */
export function hunkHeaders(diff: string): string[] {
  return diff.split('\n').filter(line => line.startsWith('@@'))
}

/** How the prompt names the revision range. */
const SCOPE_LABEL: Record<ReviewLang, Record<ReviewScope, string>> = {
  zh: { worktree: '工作区未暂存的更改', staged: '已暂存的更改', commit: '提交' },
  en: { worktree: 'unstaged working-tree changes', staged: 'staged changes', commit: 'commit' },
}

function scopeLabel(scope: ReviewScope, commitRef: string | undefined, lang: ReviewLang): string {
  const base = SCOPE_LABEL[lang][scope]
  if (scope !== 'commit' || commitRef === undefined) return base
  return `${base} ${commitRef}`
}

/**
 * The warning that must be the prompt's FIRST line when the diff was capped.
 *
 * The number comes from `GIT_CAP` itself, so the prompt cannot drift from the
 * command that did the cut. The language is the reviewer's, like the rest.
 */
function cappedWarning(lang: ReviewLang): string {
  if (lang === 'zh') {
    return `⚠ 这份 diff 在 ${GIT_CAP} 字节处被静默截断：下面只是前缀，后面的文件与代码块可能缺失，请以远端实际内容为准。`
  }
  return `⚠ This diff was silently truncated at ${GIT_CAP} bytes: only a prefix is shown, so later files and hunks may be missing — rely on the real remote content.`
}

/** The file/scope facts every prompt carries, right after the headline. */
function contextLines(input: ReviewPromptInput): string[] {
  const scope = scopeLabel(input.scope, input.commitRef, input.lang)
  if (input.lang === 'zh') {
    return [
      `目标文件：${input.fullPath}（仓库内相对路径 ${input.rel}）`,
      `主机：${input.alias}`,
      `仓库根：${input.root}`,
      `差异范围：${scope}`,
    ]
  }
  return [
    `Target file: ${input.fullPath} (repository-relative path ${input.rel})`,
    `Host: ${input.alias}`,
    `Repository root: ${input.root}`,
    `Diff scope: ${scope}`,
  ]
}

/**
 * The review instructions every prompt carries.
 *
 * Phrased as RULES rather than a persona because the receiver is a coding agent
 * with write access to the same host: this text lands in a normal draft and can
 * be sent as-is, so "change nothing" has to be explicit.
 */
function reviewRules(lang: ReviewLang): string[] {
  if (lang === 'zh') {
    return [
      '1. 只做审查：不要修改、暂存、提交或删除任何文件，也不要运行会改变工作区的命令。',
      '2. 重点看正确性、边界条件（空值 / 超大输入 / 异常路径）与错误处理（是否吞掉失败），以及与仓库既有约定不一致的地方（命名、分层、注释风格）。',
      '3. 每条问题用「文件:行号」定位（变更后的行号），说明为什么是问题、建议怎么改。',
      '4. 不要复述 diff 内容，直接给结论；没有发现问题就明确说「未发现问题」。',
    ]
  }
  return [
    '1. Review only: do not modify, stage, commit or delete any file, and do not run commands that change the working tree.',
    '2. Focus on correctness, boundary conditions (empty / huge input / unusual paths), swallowed failures, and anything that breaks the repository conventions (naming, layering, comment style).',
    '3. Locate every finding as "file:line" (line numbers AFTER the change) and say why it is a problem and how you would fix it.',
    '4. Do not restate the diff; give conclusions only, and say "no issues found" explicitly when there are none.',
  ]
}

/** The fenced, verbatim diff of a completed read. */
function fullBlock(input: ReviewPromptInput): string[] {
  const intro = input.lang === 'zh' ? '完整 diff：' : 'Complete diff:'
  // A trailing newline would put a blank line before the closing fence; drop
  // exactly one so the block stays tight.
  const body = input.diff.endsWith('\n') ? input.diff.slice(0, -1) : input.diff
  const fence = diffFence(input.diff)
  return [intro, `${fence}diff`, body, fence]
}

/**
 * The size-reduced prompt: no diff body, but the anchors a reviewer needs.
 *
 * The `@@` headers are the part of a large diff that is cheap and useful — they
 * say WHERE the changes are, so the model can read those regions instead of the
 * whole patch. The body is deliberately absent: shipping it would defeat the
 * budget this branch exists for.
 */
function summaryBlock(input: ReviewPromptInput): string[] {
  const headers = hunkHeaders(input.diff)
  const listed = headers.slice(0, AI_REVIEW_MAX_HUNKS)
  const omitted = headers.length - listed.length
  const lines: string[] = []
  if (input.lang === 'zh') {
    lines.push(`diff 大小：${diffByteLength(input.diff)} 字节；超过 ${AI_REVIEW_MAX_BYTES} 字节的内嵌上限，所以没有内嵌全文（按块摘要见下）。`)
    lines.push('')
    lines.push(`变更块（从 diff 的 @@ 头提取，共 ${headers.length} 处，最多列出 ${AI_REVIEW_MAX_HUNKS} 处）：`)
  } else {
    lines.push(`Diff size: ${diffByteLength(input.diff)} bytes; above the ${AI_REVIEW_MAX_BYTES}-byte inline limit, so the body is not included (per-hunk summary below).`)
    lines.push('')
    lines.push(`Changed hunks (taken from the diff's @@ headers; ${headers.length} in total, at most ${AI_REVIEW_MAX_HUNKS} listed):`)
  }
  if (listed.length === 0) {
    lines.push(input.lang === 'zh' ? '（没有解析到 @@ 头：这份 diff 可能不是标准 unified 输出）' : '(no @@ header found: the diff may not be standard unified output)')
  }
  lines.push(...listed)
  if (omitted > 0) {
    lines.push(input.lang === 'zh' ? `（另有 ${omitted} 处变更块未列出）` : `(${omitted} more hunks not listed)`)
  }
  lines.push('')
  if (input.lang === 'zh') {
    lines.push(`获取完整内容：请读取 ${input.fullPath}，或在该主机（${input.alias}）的仓库根 ${input.root} 上自行执行 git diff / git show 取回完整差异，再用上面的 @@ 头定位。`)
  } else {
    lines.push(`Get the full text: read ${input.fullPath}, or run git diff / git show yourself in the repository root ${input.root} on host ${input.alias}, then use the @@ headers above as anchors.`)
  }
  return lines
}

/**
 * The no-text prompt: untracked and binary files have no diff to send, so the
 * model is asked to read the file and obtain the diff itself — never an empty
 * fenced block, which reads as "the change is empty".
 */
function pathOnlyBlock(input: ReviewPromptInput): string[] {
  if (input.lang === 'zh') {
    return [
      '没有可内嵌的 diff 文本（未跟踪文件或二进制文件没有文本差异）。',
      `请在该主机上读取 ${input.fullPath} 并自行获取差异（git diff / git show），然后按下面的要求审查。`,
    ]
  }
  return [
    'No diff text is available (an untracked or binary file has no textual diff).',
    `Read ${input.fullPath} on that host and obtain the diff yourself (git diff / git show), then review it against the requirements below.`,
  ]
}

/**
 * The prompt that goes into the composer draft.
 *
 * `mode` is what the caller decided (see {@link pickReviewMode}), but an empty
 * diff is normalized to `pathOnly` here as well: an empty file is not an empty
 * CHANGE, and an empty fenced block would answer the wrong question.
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const mode: ReviewMode = input.diff === '' ? 'pathOnly' : input.mode
  const lines: string[] = []
  // The cap warning is the FIRST line on purpose: it is the one fact that must
  // not be buried (a review of a prefix presented as a review of the change is
  // the failure mode this whole module guards).
  if (input.capped) lines.push(cappedWarning(input.lang))
  lines.push(input.lang === 'zh' ? '请审查下面这个文件的改动。' : 'Please review the change to the file below.')
  lines.push('')
  lines.push(...contextLines(input))
  lines.push('')
  let body: string[]
  if (mode === 'full') body = fullBlock(input)
  else if (mode === 'summary') body = summaryBlock(input)
  else body = pathOnlyBlock(input)
  lines.push(...body)
  lines.push('')
  lines.push(input.lang === 'zh' ? '审查要求：' : 'Review requirements:')
  lines.push(...reviewRules(input.lang))
  return lines.join('\n')
}

// ------------------------------------------------------- whole-commit review

/** How many changed files a commit prompt enumerates before it stops. */
export const AI_REVIEW_MAX_FILES = 100

/** One `git show --name-status` row, as the prompt needs it. */
export interface CommitFileLike {
  /** Single letter (`R`/`C` for renames/copies). */
  status: string
  path: string
  /** Rename/copy source. */
  origPath?: string
}

/** Everything a whole-commit prompt needs — all of it already on the history pane. */
export interface CommitReviewInput {
  /** SSH host alias the commit was read from (named, no secrets). */
  alias: string
  /** Repository root on that host (absolute POSIX path). */
  root: string
  hash: string
  subject: string
  /** Message body below the subject ('' when there is none). */
  body: string
  /** Files the commit touched (`git show --name-status`); empty when unread. */
  files: readonly CommitFileLike[]
  /** Raw `git show --patch` text ('' when the commit has no textual diff). */
  patch: string
  mode: ReviewMode
  /** The patch is a `GIT_CAP`-capped PREFIX (`loadCommitPatch.truncated`). */
  capped: boolean
  lang: ReviewLang
}

/** `A\tsrc/a.ts`, or `R\tsrc/a.ts → src/b.ts` for a rename. */
function commitFileLine(file: CommitFileLike): string {
  if (file.origPath === undefined || file.origPath === file.path) return `${file.status}\t${file.path}`
  return `${file.status}\t${file.origPath} → ${file.path}`
}

/** The commit's identity and files, in both languages. */
function commitFacts(input: CommitReviewInput): string[] {
  const lines: string[] = []
  if (input.lang === 'zh') {
    lines.push(`提交：${input.hash}`, `标题：${input.subject}`)
    if (input.body.trim() !== '') lines.push(`提交说明：\n${input.body.trim()}`)
    lines.push(`主机：${input.alias}`, `仓库根：${input.root}`)
  } else {
    lines.push(`Commit: ${input.hash}`, `Subject: ${input.subject}`)
    if (input.body.trim() !== '') lines.push(`Commit message:\n${input.body.trim()}`)
    lines.push(`Host: ${input.alias}`, `Repository root: ${input.root}`)
  }
  if (input.files.length === 0) return lines
  const listed = input.files.slice(0, AI_REVIEW_MAX_FILES)
  const omitted = input.files.length - listed.length
  lines.push('')
  lines.push(input.lang === 'zh'
    ? `改动文件（${input.files.length} 个，最多列出 ${AI_REVIEW_MAX_FILES} 个）：`
    : `Changed files (${input.files.length} total, at most ${AI_REVIEW_MAX_FILES} listed):`)
  lines.push(...listed.map(commitFileLine))
  if (omitted > 0) lines.push(input.lang === 'zh' ? `（另有 ${omitted} 个文件未列出）` : `(${omitted} more files not listed)`)
  return lines
}

/** The fenced, verbatim `git show --patch` body. */
function commitFullBlock(input: CommitReviewInput): string[] {
  const intro = input.lang === 'zh' ? '完整 patch：' : 'Complete patch:'
  const body = input.patch.endsWith('\n') ? input.patch.slice(0, -1) : input.patch
  const fence = diffFence(input.patch)
  return [intro, `${fence}diff`, body, fence]
}

/**
 * The size-reduced commit prompt: the file list above is the map, and the model
 * is told how to fetch the patch instead of being handed a truncated prefix.
 */
function commitSummaryBlock(input: CommitReviewInput): string[] {
  const hunks = hunkHeaders(input.patch).length
  const bytes = diffByteLength(input.patch)
  if (input.lang === 'zh') {
    return [
      `patch 大小：${bytes} 字节，共 ${hunks} 处变更块${input.capped ? '（已被截断）' : `（超过 ${AI_REVIEW_MAX_BYTES} 字节的内嵌上限）`}，所以没有内嵌全文。`,
      `获取完整内容：请在该主机（${input.alias}）的仓库根 ${input.root} 上执行 git show ${input.hash} 取回完整 patch，必要时再逐个读取上面列出的文件。`,
    ]
  }
  return [
    `Patch size: ${bytes} bytes, ${hunks} hunks${input.capped ? ' (truncated)' : ` (above the ${AI_REVIEW_MAX_BYTES}-byte inline limit)`}, so the body is not included.`,
    `Get the full text: run git show ${input.hash} in the repository root ${input.root} on host ${input.alias}, then read the files listed above as needed.`,
  ]
}

/** The no-text commit prompt (empty commit, binary-only change, merge). */
function commitPathOnlyBlock(input: CommitReviewInput): string[] {
  if (input.lang === 'zh') {
    return [
      '该提交没有可内嵌的文本 diff（可能是空提交、仅二进制改动或合并提交）。',
      `请在该主机（${input.alias}）的仓库根 ${input.root} 上执行 git show ${input.hash} 查看完整改动，然后按下面的要求审查。`,
    ]
  }
  return [
    'This commit has no inline textual diff (empty commit, binary-only change, or a merge).',
    `Run git show ${input.hash} in the repository root ${input.root} on host ${input.alias}, then review it against the requirements below.`,
  ]
}

/** One rule that only makes sense for a WHOLE commit (cross-file coherence). */
function commitRule(lang: ReviewLang): string {
  if (lang === 'zh') return '5. 以整个提交为单位：核对提交信息与改动是否一致，以及多个文件之间的关联改动是否有遗漏或不一致。'
  return '5. Review the commit as a whole: does the message match the change, and are the related edits across files consistent and complete?'
}

/**
 * The prompt for reviewing a WHOLE commit from the history pane (F6 v2).
 *
 * Same byte discipline as the single-file prompt (a capped `git show --patch`
 * must never be presented as the complete change), but the shape differs: a
 * commit is a set of files, so the facts list the files and the model is told
 * how to fetch the patch. `mode` is what the caller decided; an empty patch is
 * normalized to `pathOnly` here as well.
 */
export function buildCommitReviewPrompt(input: CommitReviewInput): string {
  const mode: ReviewMode = input.patch === '' ? 'pathOnly' : input.mode
  const lines: string[] = []
  if (input.capped) lines.push(cappedWarning(input.lang))
  lines.push(input.lang === 'zh' ? '请审查下面这个提交的改动。' : 'Please review the changes in the commit below.')
  lines.push('')
  lines.push(...commitFacts(input))
  lines.push('')
  if (mode === 'full') lines.push(...commitFullBlock(input))
  else if (mode === 'summary') lines.push(...commitSummaryBlock(input))
  else lines.push(...commitPathOnlyBlock(input))
  lines.push('')
  lines.push(input.lang === 'zh' ? '审查要求：' : 'Review requirements:')
  lines.push(...reviewRules(input.lang), commitRule(input.lang))
  return lines.join('\n')
}
