# dsh-remote-vs · DSH 远程开发（VSCode 式）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

中文 | [English](./README.en.md)

Host 进程内的 SSH 主机管理 + helper 推送流水线 + 远端文件/终端/Git。
主机配在 DSH 设置里（“远程主机”项）；装了 `dsh-better-sidebar` 时另有
独立“远程”tab（工作区/文件/终端/Git），没装则退到原生右侧栏“远程”页
（同内容，引导页自助开，per-session 实例）。
P2 起原生工具在远端工作区里透明跑远端（见下）。

```text
┌─ 本机 DSH Host ─────────────────────────────────┐
│  本插件 Host 半      │  Client 半（浏览器）     │
│  主机/密钥/推送/路由 │  设置两节 + 原生入口接管 │
│  /api/dsh-remote/*   │  远程页(双面二选一)      │
└──────────────────────┴──────────────────────────┘
       │ ssh2（文件/进程/终端）+ helper RPC（远端 fs）
       ▼
┌─ 远端 Linux ─────────────────────────────────┐
│  ~/.dsh-helpers/<ver>/<arch>/dsh-ssh-helper  │
│  用户指定的远端工作目录                        │
└──────────────────────────────────────────────┘
```

## 安装

```sh
dsh plugin add github:xiray-xia/dsh-remote-vs
```

要求 DSH `0.2.1-alpha.3`。首次安装按提示在 profile 的 `pnpm-workspace.yaml`
里放行构建脚本后重跑；装完重启 `dsh web`，打开设置 → 远程主机开配。

## 能力

| 能力 | 说明 |
| --- | --- |
| 主机管理 | 增删改查、连接测试；证书 / 密码认证；配置存 `$DSH_HOME/dsh-remote.json`（0600），与 `dsh-ssh.json` 独立 |
| 密钥 bootstrap | 密码主机一键生成专用密钥对并下发 `authorized_keys`，之后走密钥 |
| 推送流水线 | 远端 arch/系统探测 → 版本比对 → 一致跳过 / 否则推送；executable 通道推送自编译 helper |
| 远端文件 | SFTP 浏览 / 读 / 写 / 新建 / 删除 / 改名 + CodeMirror 多开编辑 + 拖拽分割线 |
| 远端终端 | ssh2 PTY + WebSocket，xterm 渲染（复制粘贴/主题跟随/刷新重连） |
| Git 图谱 | 远端仓库状态 + 分支 + SVG 提交图 + 提交详情（exec + 前端解析，零 Host 增量）|
| 导入 | 从 `~/.ssh/config`、从现有 `dsh-ssh.json` 一键导入（只读一次，不耦合）|
| Agent 工具 | `remote_hosts` / `remote_exec` / `remote_read` / `remote_write` / `remote_ls` |
| **P2 透明远端执行** | 远端工作区里原生 `read/write/edit/bash/glob/grep/jobs` 直接跑在远端 |
| **P3 远端 @ 引用** | 远端会话 `@` 出远端文件候选（路由 fileReferences，scoped 实时/bare 走远端 rg 索引） |

## 工程结构

```text
dsh_remote_vs/
├── cordis.patch.yml        # 组合声明：插件行 + 私有本地 realm + 三路由 + preset-remote
├── src/
│   ├── index.ts            # 插件入口：store/pool/worlds/路由/工具/预设切换接线
│   ├── protocol.ts         # 前后端 wire 契约（路由表 + 纯类型，两边共用）
│   ├── paths.ts            # $DSH_HOME 下四件套寻址（库/密钥/构建缓存/别名目录）
│   ├── store.ts            # 主机 + 绑定 + 墓碑持久化（0600 JSON，原子写）
│   ├── pool.ts             # ssh2 长连接池（exec/shell/sftp/putFile，TOFU 主机键）
│   ├── sftp.ts             # 远端文件引擎（SFTP 窗口读写/目录树操作）
│   ├── keygen.ts           # 密码机密钥 bootstrap（生成→下发→翻转）
│   ├── deploy.ts           # 推送流水线（探测/比对/传包/双验/manifest）
│   ├── importers.ts        # ssh_config / dsh-ssh.json 解析导入
│   ├── routes.ts           # /api/dsh-remote/* 路由表 + 终端 WebSocket 升级
│   ├── terminal.ts         # PTY 会话注册表（刷新重连/断开清理）
│   ├── tools.ts            # 5 个 Agent 工具定义
│   ├── http.ts / loopback.ts # JSON 体读写 + 回环信任围栏
│   ├── git-format.ts       # git 命令构造 + 纯前端解析（Host 零增量）
│   ├── p2/                 # ── P2 透明路由 ──
│   │   ├── worlds.ts       # 世界判定（cwd 键/别名/墓碑）+ RPC/FS/进程远端上下文
│   │   ├── helper-rpc.ts   # ssh2 exec 通道上的 helper wire 协议（握手/心跳）
│   │   ├── router-fs.ts    # 透明 fs 路由（目标→世界映射/路径翻译/策略重写）
│   │   ├── router-subprocess.ts # 透明进程路由（argv0 归约/pwsh 门）
│   │   ├── ssh-proc.ts     # ssh2 进程运行时（setsid 组杀/marker/stdin/spill）
│   │   ├── shell-bash.ts   # 路由 bash 执行器（本地原样/远端去 DSH_*）
│   │   ├── router-spill.ts # 透明 spill 路由（session 世界键/远端目录）
│   │   ├── router-refs.ts  # 透明 @ 引用路由（agent 世界键，P3）
│   │   ├── file-refs.ts    # 远端 @ 搜索（fs-ssh 实时列/rg 索引/官方评分移植）
│   │   ├── bridge.ts       # 私有 realm 本地件发布（localFs 等早期服务）
│   │   └── bridge-refs.ts  # refs 独立桥（local-refs 依赖 workingDirectory，必须分离）
│   └── client/             # ── 浏览器半（React，打包进 lib/client.js）──
│       ├── index.tsx       # 双面决策（better 优先/settle 加速/原生兜底）+ 设置两节 + directoryFlow 双槽接管
│       ├── RemoteRoot.tsx    # 双面共用根（工作区/文件/终端/Git 四子页）
│       ├── NativeExplorer.tsx# 原生页类型定义 + seat 正文（无 sidebar 兜底）
│       ├── composer.ts / use-remote-chat-target.ts / selection-popup.ts # 远端 @引用/选中加对话
│       ├── api.ts          # /api/dsh-remote 类型化 fetch 封装
│       ├── HostsView / WorkspacesView / WorkspaceWizard / FilesView
│       ├── CodeEditor / TerminalView / XTerm / GitView / Dialog
│       ├── SettingsHosts.tsx        # 设置两节 occupant（主机管理/绑定列表，自取数）
│       ├── DirectoryFlow.tsx        # 原生入口 occupant（本地双模/远端向导）
│       ├── RemoteDirectoryPicker.tsx# 远端目录浏览弹窗
│       └── i18n.ts / theme.ts / ui.tsx # 双语词典/主题信号/共享样式
├── vendor/dsh-remote-helpers/ # helper 种子（随包发布，启动铺缓存，见下）
├── docs/                   # 本地工作文档（不推送 GitHub）
│   ├── P2-PLAN.md          # P2 架构/分期/验收矩阵（含逐项状态）
│   └── MAINTENANCE.md      # DSH 升级影响面 + helper 升级流程（升级先读它）
├── locale/                 # 插件元信息双语
└── lib/                    # 构建产物（gitignored，link 安装后重启即生效）
```

`vendor/dsh-remote-helpers/`（入库）是 helper 种子：插件启动时自动铺到
`$DSH_HOME/dsh-remote-helpers/`（缺啥补啥，永不覆盖），新机器装完即能推送。
新版本 helper 编好后把 4 件套（tarball + sha256 + helper.json + 补丁说明）
换进 vendor 并提交即可，见 `docs/MAINTENANCE.md` §4。

`.spike/`（gitignored）是真机验证脚本：`p2-router.ts` 主回归（真远端 + 真
Cordis + 真路由类）+ `grep-probe.mjs` 等探针，构建见 `tsconfig.scratch.json`。

## P2 透明远端执行（Windows 原生）

单 Host 混合路由：原生工具按会话 cwd 落在哪个世界自动分发 —— 远端 alias 走
helper RPC（fs）/ ssh2（进程），本地一切不变；两者同 Host、共 GUI。

- 别名目录：`$DSH_HOME/remote-ssh/aliases/<id>`（空壳，只做路由键），自动注册进原生工作区列表，标题 `<server> > <base>`
- 路由开关（设置 → 远程主机页顶部下拉；底层是 profile patch `- id: remote-vs` 下 `config.routingMode`，volatile，免重启）：
  `off`（默认，直通本地）/ `shadow`（记日志仍走本地）/ `enforce`（真路由）
- 新建工作区：原生"添加工作区…"入口已接管（本地/远端双 tab；远端腿=主机→推送→绑定向导）
- 预设：`Remote` 预设（bash 工具集）；enforce 下远端新会话自动切过去（默认预设才切，不践踏显式选择）
- 顶层真相（实测结论，非假设）：
  - 远端 `grep/glob` 经路由调远端 `rg`（两台实测机自带 rg 13；远端无 rg 则查不到）
  - 整包读 >8MiB 报 `FS_TOO_LARGE`（helper 官方上限），用流读/分页；**写无上限**（46MiB 整包写实测通过）
  - 超长进程输出落 Host 临时 spill 文件（`readFrom` 返 tail + 路径，全文住文件里，与官方一致）
  - 删绑定后新调用明确拒绝（墓碑 fail-closed），历史记录可读
  - 断线：在途不重放；新调用自动重连
- 验证：`npx tsc -p tsconfig.scratch.json && node .spike/build/.spike/p2-router.js`
  （真远端 + 真 Cordis + 真路由类，61/61；P0 路由与 GUI 需重启 Host 后冒烟）
- 详见 `docs/P2-PLAN.md`（§8 验收矩阵逐项状态）

## Helper 自编译（P1）

官方从未发布 helper 二进制（Release assets 全空），本插件走自编译：

- 构建机：WSL2 Ubuntu-22.04（glibc 2.35，与目标远端一致），Node v24.21.0 + pnpm 11.28.5
- 源码：`dsh-v0.2.1-alpha.2` tag（与 Host 同版本，协议握手一致）
- 命令：官方原脚本 `pnpm exec tsx scripts/build-exe-for-ssh-helper.ts --target=node24-linux-x64`
- 唯一偏离：无 docker 跑不了 manylinux 2.28 重编，加了 `DSH_GLIBC_CEILING`
  环境覆盖（默认仍 2.28），本次以 2.35 构建（见缓存目录 `glibc-ceiling.patch`）
- 校验：官方 `verify-ssh-helper-artifact.ts --sandbox=required` 8 项全绿
- 缓存：`$DSH_HOME/dsh-remote-helpers/`（`*.tar.gz` + `.sha256` + `.helper.json`
  含 binarySha256，供 P2 的 helperHash）
- 升级重编全流程见 `docs/MAINTENANCE.md` §4

## 安全模型

- 所有 `/api/dsh-remote/*` 路由仅限 loopback + 同源访问。
- 密码 / 私钥口令以明文保存在 `dsh-remote.json`（0600），与现有 SSH 插件同一信任模型。
- 推送物逐包验 sha256（tarball 进、binary 出，双重校验）；helper 安装目录与工作区分开。
- 远端会话可读显式本机绝对路径（工具 spill 文件契约要求）；同模型信任下可接受，见 `docs/P2-PLAN.md` §4 备注。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build
dsh plugin --profile web add link:<本目录绝对路径>
```

改完 client 后硬刷新浏览器即可；host 半改动需重启 `dsh web`。
DSH 发新版时先读 `docs/MAINTENANCE.md` 再动手。

## 开源许可

MIT © 2026 xiray-xia —— 见 [LICENSE](./LICENSE)。

`vendor/` 里的 helper 种子由 DeepSeek Harness 源码（MIT）按 `dsh-v0.2.1-alpha.2`
tag 以官方原脚本构建，具体流程与唯一有记录的偏离见上文"Helper 自编译"节
（种子包里的 `glibc-ceiling.patch`）。
