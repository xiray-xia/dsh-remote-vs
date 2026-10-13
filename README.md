# dsh-remote-vs · DSH 远程开发（VSCode 式）

Host 进程内的 SSH 主机管理 + helper 推送流水线 + 远端文件/终端/Git，
UI 以独立 tab 注册进 `dsh-better-sidebar`（不改动其本地文件树）。

## 能力

| 能力 | 说明 |
| --- | --- |
| 主机管理 | 增删改查、连接测试；证书 / 密码认证；配置存 `$DSH_HOME/dsh-remote.json`（0600），与 `dsh-ssh.json` 独立 |
| 密钥 bootstrap | 密码主机一键生成专用密钥对并下发 `authorized_keys`，之后走密钥 |
| 推送流水线 | 远端 arch/系统探测 → 版本比对 → 一致跳过 / 否则推送；executable 通道推送自编译 helper（见下）|
| 远端文件 | SFTP 浏览 / 读 / 写 / 新建 / 删除 / 改名 + CodeMirror 多开编辑 + 拖拽分割线 |
| 远端终端 | ssh2 PTY + WebSocket，xterm 渲染（复制粘贴/主题跟随/刷新重连） |
| Git 图谱 | 远端仓库状态 + 分支 + SVG 提交图 + 提交详情（exec + 前端解析，零 Host 增量）|
| 导入 | 从 `~/.ssh/config`、从现有 `dsh-ssh.json` 一键导入（只读一次，不耦合）|
| Agent 工具 | `remote_hosts` / `remote_exec` / `remote_read` / `remote_write` / `remote_ls` |
| **P2 透明远端执行** | 远端工作区里原生 `read/write/edit/bash/glob/grep/jobs` 直接跑在远端（见下）|

## P2 透明远端执行（Windows 原生）

单 Host 混合路由：原生工具按会话 cwd 落在哪个世界自动分发 —— 远端 alias 走
helper RPC（fs）/ ssh2（进程），本地一切不变；两者同 Host、共 GUI。

- 别名目录：`$DSH_HOME/remote-ssh/aliases/<id>`（空壳，只做路由键），自动注册进原生工作区列表，标题 `<server> > <base>`
- 路由开关（profile patch `- id: remote-vs` 下 `config.routingMode`，volatile，免重启）：
  `off`（默认，直通本地）/ `shadow`（记日志仍走本地）/ `enforce`（真路由）
- 新建工作区：原生"添加工作区…"入口已接管（本地/远端双 tab；远端腿=主机→推送→绑定向导）
- 预设：`Remote` 预设（bash 工具集）；enforce 下远端新会话自动切过去（默认预设才切，不践踏显式选择）
- 顶层真相（实测结论，非假设）：
  - 远端 `grep/glob` 经路由调远端 `rg`（两台实测机自带 rg 13；远端无 rg 则查不到）
  - 整包读 >8MiB 报 `FS_TOO_LARGE`（helper 官方上限），用流读/分页；**写无上限**（46MiB 整包写实测通过）
  - 删绑定后新调用明确拒绝（墓碑 fail-closed），历史记录可读
  - 断线：在途不重放；新调用自动重连
- 验证：`npx tsc -p tsconfig.scratch.json && node .spike/build/.spike/p2-router.js`
  （真远端 + 真 Cordis + 真路由类，46/46；P0 路由与 GUI 需重启 Host 后冒烟）
- 详见 `docs/P2-PLAN.md`（§8 验收矩阵逐项状态）

## Helper 自编译（P1）

官方从未发布 helper 二进制（Release assets 全空），本插件走自编译：

- 构建机：WSL2 Ubuntu-22.04（glibc 2.35，与目标远端一致），Node v24.21.0 + pnpm 11.28.5
- 源码：`dsh-v0.2.1-alpha.2` tag（与 Host 同版本，协议握手一致）
- 命令：官方原脚本 `pnpm exec tsx scripts/build-exe-for-ssh-helper.ts --target=node24-linux-x64`
- 唯一偏离：无 docker 跑不了 manylinux 2.28 重编，`scripts/ssh-helper/native.ts` 加了
  `DSH_GLIBC_CEILING` 环境覆盖（默认仍 2.28），本次以 2.35 构建（见缓存目录 `glibc-ceiling.patch`）
- 校验：官方 `verify-ssh-helper-artifact.ts --sandbox=required` 8 项全绿
- 缓存：`$DSH_HOME/dsh-remote-helpers/`（`*.tar.gz` + `.sha256` + `.helper.json` 含 binarySha256，供 P2 的 helperHash）

## 安全模型

- 所有 `/api/dsh-remote/*` 路由仅限 loopback + 同源访问。
- 密码 / 私钥口令以明文保存在 `dsh-remote.json`（0600），与现有 SSH 插件同一信任模型。
- 推送物逐包验 sha256（tarball 进、binary 出，双重校验）；helper 安装目录与工作区分开。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build
dsh plugin --profile web add link:<本目录绝对路径>
```

改完 client 后硬刷新浏览器即可；host 半改动需重启 `dsh web`。
