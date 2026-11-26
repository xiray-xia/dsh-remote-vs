/**
 * 撤销失败时说人话：把 `git apply` 的 stderr 归成几种**可操作**的原因。
 *
 * 这条路原来只有一句「这处改动的上下文已经变了」。可实际失败原因不止一种，而且
 * 读法完全不同：
 * - 上下文真的变了 → 重新点该行重算标记，再看一遍；
 * - 文件已经不在仓库里 → 打开/重命名过，去列表里重新找；
 * - 权限 / 只读文件系统 → 远端那头的问题，换条路（终端 / 另一个写入者）；
 * - 仓库所有权不对（git 的 `dubious ownership`）→ 去配 `safe.directory` 或修所有权，
 *   换仓库目录解决不了它；
 * - 补丁本身坏了（截断 / 手改）→ 重新取一次改动内容；
 * - 其它 → 至少把 git 的原话留在后面。
 *
 * 样本来自 `git apply` 的真实 stderr 形状（git 2.55 / apply.c 与 setup.c 的消息；
 * 2026-11-26 审核用真远端 git 复跑过）：`patch failed: … / patch does not apply`、
 * `already exists in working directory`、`No such file or directory`、
 * `does not exist in index`、`Permission denied`、`unable to write new index file`、
 * `detected dubious ownership in repository at …`、`corrupt patch at line N`、
 * `patch fragment without header at line N`、`patch with only garbage at <file>:<line>`。
 *
 * **没有"不是 git 仓库"这一档**：`git apply` 不要求当前目录是仓库，跑在非仓库目录
 * 得到的仍是文件级错误（实测是 `No such file or directory`，归 path-missing）；
 * 把那种情形报成"重选仓库目录"会把人引到错误的修法上（审核 S3）。
 *
 * 纯函数 + 一张样本表，`scripts/check-apply-failure.mjs` 用真实 stderr 驱动。
 * 传输失败（socket/超时）不在这里：那是链路问题，调用方先用 `isConnectionFailure`
 * 拦掉，报成"补丁上下文变了"会把人引到错误的修法上。
 */

/** 撤销失败的原因分类。 */
export type ApplyFailureKind = 'context-moved' | 'path-missing' | 'permission' | 'ownership' | 'corrupt' | 'other'

/** 每种分类对应的字典键（zh + en 见 `i18n.ts`）。 */
const FAILURE_KEY: Record<ApplyFailureKind, string> = {
  'context-moved': 'changes.applyContextMoved',
  'path-missing': 'changes.applyPathMissing',
  permission: 'changes.applyPermission',
  ownership: 'changes.applyOwnership',
  corrupt: 'changes.applyCorrupt',
  other: 'changes.applyOther',
}

/** 一份 stderr 属于哪类原因。 */
export function classifyApplyFailure(detail: string): ApplyFailureKind {
  const text = detail.toLowerCase()
  // 顺序承重：所有权问题是 git 启动阶段就拒绝的（后面常跟着一堆补丁错误），
  // 必须先认出来，否则会被认成路径/上下文问题。
  if (/dubious ownership|safe\.directory|owner of the repository|repository at .* is owned by/.test(text)) return 'ownership'
  if (/permission denied|operation not permitted|read-only file system|unable to write|unable to create file|eacces|eperm/.test(text)) return 'permission'
  if (/no such file or directory|does not exist in index|did not match any file/.test(text)) return 'path-missing'
  if (/corrupt patch|patch fragment without header|patch with only garbage|malformed patch|unrecognized input|bad hunk header/.test(text)) return 'corrupt'
  if (/patch does not apply|patch failed|already exists in working directory|does not match index|while searching for/.test(text)) {
    return 'context-moved'
  }
  return 'other'
}

/** 一份 stderr 对应的字典键。 */
export function applyFailureKey(detail: string): string {
  return FAILURE_KEY[classifyApplyFailure(detail)]
}

/**
 * 失败提示的正文：分类那句话 + git 的原话（次要信息）。
 *
 * 原话一定留在后面：分类是我们对 stderr 的读法，读错了用户还能从原文看出来。
 * `detail` 为空时返回 `undefined`，由调用方退回既有的兜底文案。
 */
export function applyFailureText(detail: string, t: (key: string) => string): string | undefined {
  const text = detail.trim()
  if (text === '') return undefined
  return `${t(applyFailureKey(text))} · ${text}`
}
