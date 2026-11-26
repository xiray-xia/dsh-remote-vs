/**
 * 面板一行 → 一份**只读**的并排 diff（数据来源是会话账本，不是 git 工作区）。
 *
 * 面板原来只能"打开文件 + 就地画标记"：看这一处改动的上下文，得先打开文件、再靠
 * 行背景去读。SCM 的并排 diff（`scm/DiffView.tsx`）能给出"改前 / 改后"两栏，但它
 * 读的是 `git diff`（工作区对索引/HEAD），与会话账本**不是同一个基线**：账本比的是
 * 会话起点，工作区里可能还有会话开始之前就存在的未提交改动。
 *
 * 于是这里补的是账本这一侧的两块材料，让并排渲染器能直接复用：
 * 1. **改前全文**：Host 只给 hunk（`RemoteChangesDiff.hunks`），不给基线内容。但
 *    "改后"全文能读（`fileOp.read`），而 unified hunk 已经说清了每一次删除/新增 ——
 *    把删除行填回去、把新增行跳过，就**精确**还原出改前全文（纯函数，可断言）；
 * 2. **一份完整的 unified patch 文本**：hunk 里带着 `@@` 头与逐行内容，拼起来就是
 *    `parseUnifiedDiff` / `buildDiffModel` 要的输入。**不**用 `diff.patch`：整文件
 *    反向补丁在"新建文件"和"字节截断"两种情况下是空的，而 hunk 永远在。
 *
 * 两栏都只能**看**：这是会话的历史比较，不是可编辑的工作区副本（DiffView 按
 * `EditorTab.sessionDiff` 关掉编辑与 hunk 写操作）。
 */
import type { RemoteChangedFile, RemoteChangesDiff, UnifiedHunk } from '../../protocol.ts'
import type { DiffPayload } from '../scm/actions.ts'
import { noticeOfDiff, type DiffNotice } from './diff-outcome.ts'

/**
 * 这一行能不能给出会话 diff。
 *
 * 二进制/非 UTF-8 文件没有可读的文本 hunk，超大文件连字节都被 Host 扣下 —— 这两种
 * 行"查看差异"只会得到一个空视图，所以菜单项直接不出现（回到"打开文件"）。
 */
export function canShowChangeDiff(file: Pick<RemoteChangedFile, 'binary' | 'oversized'>): boolean {
  return file.binary !== true && file.oversized !== true
}

/** 按 `\n` 切行，去掉尾随空行（与 `scm/diff-model.ts` 的约定一致）。 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 由"改后全文"与 hunk 还原"改前全文"。
 *
 * 依据是 unified diff 的定义：hunk 之外两侧相同，hunk 内 `-` 行只存在于改前、`+` 行
 * 只存在于改后、` ` 行两边都有。所以沿改后文件走一遍，遇到 `-` 就把该行填进改前，
 * 遇到 `+` 就跳过，其余照抄即可 —— 不需要基线内容，也不需要浏览器端再算一次 diff。
 *
 * 防御：hunk 头给出的 `newStart` 若落后于游标（重叠 / 乱序的坏数据），按游标继续，
 * 绝不回退（回退会重复输出行，把并排视图整体错位）。
 *
 * @param newText - 改后全文（远端当前内容；读不到时传 ''）。
 * @param hunks - Host 给的 hunk（按行号升序）。
 * @returns 改前全文（行之间用 `\n`，末尾不带换行；`''` = 改前没有内容）。
 */
export function beforeTextOf(newText: string, hunks: readonly UnifiedHunk[]): string {
  const lines = splitLines(newText)
  const before: string[] = []
  let cursor = 0
  for (const hunk of hunks) {
    /**
     * 新文件一侧的插入点，0-based。
     *
     * 规范 unified hunk 头在**零长度一侧**的起始号是"前一行"的号（git 的约定：
     * `@@ -5,2 +4,0 @@` 表示在 new 的第 4 行之后删除两行）。所以 `newCount === 0`
     * 时插入点是 `newStart`（复制前 newStart 行），其余情况是 `newStart - 1`。
     * 老代码一律减 1，纯删除 hunk 会少复制一行、整段基线错位一格（审核 N1）。
     */
    const start = hunk.newCount === 0 ? Math.max(0, hunk.newStart) : Math.max(0, hunk.newStart - 1)
    while (cursor < start && cursor < lines.length) {
      before.push(lines[cursor] as string)
      cursor += 1
    }
    for (const raw of hunk.lines) {
      const sign = raw.charAt(0)
      if (sign === '-') {
        before.push(raw.slice(1))
        continue
      }
      if (sign === '+') {
        cursor += 1
        continue
      }
      // 上下文行：优先取"改后"的字节（那才是屏幕上真实存在的那一行）。
      before.push(cursor < lines.length ? (lines[cursor] as string) : raw.slice(1))
      cursor += 1
    }
  }
  while (cursor < lines.length) {
    before.push(lines[cursor] as string)
    cursor += 1
  }
  return before.join('\n')
}

/**
 * 把 hunk 拼成一份完整的 unified patch 文本（`buildDiffModel` 的输入）。
 *
 * 用 `diff --git` 开头：`parseUnifiedDiff` 以它为文件块的起点，缺了就一个 hunk 都
 * 解析不出来（面板会显示"没有差异"）。hunk 头按 Host 给的四个数字原样写回。
 *
 * @param display - 文件显示路径（写进 `a/` `b/` 两行；只用于展示与解析配对）。
 * @param hunks - Host 给的 hunk。
 * @returns patch 文本；没有 hunk 时 `''`。
 */
export function unifiedPatchOf(display: string, hunks: readonly UnifiedHunk[]): string {
  if (hunks.length === 0 || display === '') return ''
  const out: string[] = [`diff --git a/${display} b/${display}`, `--- a/${display}`, `+++ b/${display}`]
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)
    for (const raw of hunk.lines) out.push(raw === '' ? ' ' : raw)
  }
  return `${out.join('\n')}\n`
}

/**
 * 会话 diff 的完整载荷（`DiffPayload`，`scm/DiffView.tsx` 的入参）。
 *
 * 没有 hunk、或连路径都拼不出来时返回 `undefined`（调用方据此说"没有可显示的差异"），
 * 而不是给一张会被渲染成"整篇都改了"的空表。
 *
 * @param diff - 账本给出的这份文件比较（必须是 `kind: 'text'`）。
 * @param newText - 远端当前内容（读不到时传 ''：改后一栏为空，仍然能看改前）。
 * @param display - 面板给的显示路径（用来在 `diff.display` 为空时兜底）。
 * @returns 载荷；没有 hunk / 没有可用路径时 `undefined`。
 */
export function sessionDiffPayload(
  diff: RemoteChangesDiff,
  newText: string,
  display = diff.display,
): DiffPayload | undefined {
  if (diff.kind !== 'text' || diff.hunks.length === 0) return undefined
  const patch = unifiedPatchOf(display === '' ? diff.path : display, diff.hunks)
  if (patch === '') return undefined
  return {
    diff: patch,
    oldText: beforeTextOf(newText, diff.hunks),
    newText: splitLines(newText).join('\n'),
    unsupported: false,
  }
}

/**
 * 账本 diff + 一次"改后"读取的**可见结论**。
 *
 * 为什么需要它（审核 M2/S4）：两种"数据不全"会让并排视图变成假的：
 * 1. `diff.truncated` —— Host 的 after 文本被字节上限扣下，hunk 是 before 对空文本
 *    算出来的（整篇假差异），撤销也不可能成立；
 * 2. `read.truncated` —— 改后一栏的读取本身被截断（8 MiB 上限），`beforeTextOf`
 *    会拿"完整基线"去对"前缀正文"，两栏整体错位。
 * 两种情形都不打开，只给一句说明。二进制读取同理（没有可读文本可比）。
 */
export interface SessionDiffRead {
  /** 远端当前内容（读失败时传 ''，改后一栏空着、改前仍可看）。 */
  text: string
  /** 读取撞上了 8 MiB 上限：`text` 只是前缀。 */
  truncated?: true
  /** 读取判定为二进制。 */
  binary?: true
}

export type SessionDiffOutcome =
  | { ok: true; payload: DiffPayload }
  | { ok: false; notice: DiffNotice }

/**
 * 把"账本 diff + 改后读取"翻成"能打开的两栏"或"必须说明的结论"。
 *
 * @param diff - 账本给出的这份比较（`null` = 没拿到）。
 * @param read - 改后一栏的读取结果。
 * @param display - 面板给的显示路径（账本行偶尔给 ''）。
 */
export function sessionDiffOutcome(
  diff: RemoteChangesDiff | null,
  read: SessionDiffRead,
  display = diff === null ? '' : diff.display,
): SessionDiffOutcome {
  // 账本这一侧先说：读不到 / 二进制 / 被字节上限扣下 / 已无差异。
  const notice = noticeOfDiff(diff)
  if (notice !== undefined || diff === null) return { ok: false, notice: notice ?? 'missing' }
  // 改后那一侧：截断的前缀会让两栏错位，二进制的读取没有可比文本。
  if (read.truncated === true) return { ok: false, notice: 'truncated' }
  if (read.binary === true) return { ok: false, notice: 'binary' }
  const payload = sessionDiffPayload(diff, read.text, display)
  if (payload === undefined) return { ok: false, notice: 'empty' }
  return { ok: true, payload }
}
