# dsh-remote-vs · DSH 远程开发（VSCode 式）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

中文 | [English](./README.en.md)

Host 进程内的 SSH 主机管理 + helper 推送流水线 + **VS Code 式远端工作台**
（资源管理器 / 搜索 / 源代码管理 / 提交图 / 多标签编辑器 / 悬浮编辑器 / 并排 Diff / 多终端）。
主机配在 DSH 设置里（“远程主机”项）；装了 `dsh-better-sidebar` 时另有
独立“远程”tab，没装则退到原生右侧栏“远程”页（同内容，引导页自助开，per-session 实例）。
编辑器还额外挂到会话视图槽，与“对话 / 轨迹”并列成一个**远程编辑器**标签，
这样代码区是整屏宽的；右侧栏那份是窄屏备用面。
P2 起原生工具在远端工作区里透明跑远端（见下）。

```text
┌─ 本机 DSH Host ─────────────────────────────────┐
│  本插件 Host 半      │  Client 半（浏览器）     │
│  主机/密钥/推送/路由 │  设置两节 + 原生入口接管 │
│  /api/dsh-remote/*   │  工作台（右侧栏 + 会话视图）│
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
dsh plugin --profile web add dsh-remote-vs
```

（从 npm 装，推荐；也可以直接跟仓库装：`dsh plugin --profile web add github:xiray-xia/dsh-remote-vs`。）

要求 DSH `0.2.2-alpha.2` 及以上（`engines.dsh` 门到底；**当前实测基线 `0.2.2-alpha.2`**）。
旧 Host（`0.2.1-rc.2` 一代）请用插件 `0.9.3`：新版的 Remote 预设用了 `0.2.2-alpha.2` 的工具 schema。
`--profile web` 指明装进哪个 profile —— 本插件是 Web 插件，
必须装进 Web GUI 所用的那个（`web` 是常见命名，以你自己的 profile 名为准）。

**这一条命令就够了，不需要放行任何构建脚本**：包本身没有 `prepare`/`postinstall`，依赖树里也没有任何
带安装脚本的包（`ssh2` 是**打进产物**的，不是依赖）；走仓库安装时还带着构建好的 `lib/`。
以前需要「在 profile 的 `pnpm-workspace.yaml` 里放行构建脚本后重跑」，那是 pnpm 12 对
「带安装脚本的依赖」的硬策略门（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` / `ERR_PNPM_IGNORED_BUILDS`），
依赖侧无法豁免，只能从树里消掉。装完重启 `dsh web`，打开设置 → 远程主机开配。

> 包内含预编译的 helper（`vendor/dsh-remote-helpers/`，约 45 MB），所以首次安装下载量偏大 ——
> 它是**唯一**的 helper 投放渠道（官方 Release 不带 helper 可执行文件），去掉它就没法给新主机部署。

## 能力

### 远端工作台（VS Code 式 UI）

| 能力 | 说明 |
| --- | --- |
| 资源管理器 | 懒加载目录树 + 展开折叠 + 隐藏文件开关；右键菜单：新建/改名/删除/复制/移动/粘贴/在此文件夹查找/插入 `@` 引用；git 状态色与文件夹聚合标记 |
| 搜索 | 两档：**文件名**（远端 `find`）与**内容**（远端 `grep`）。内容档带范围目录、`Aa`（大小写）/`ab_`（全字）/`.*`（正则）、结果按文件分组、命中高亮，点条目跳到该行 |
| 源代码管理 | **仓库目录选择器**（工作区里的 git 在子目录时用：浏览远端目录、一键跳到工作区内发现的仓库、手输相对/绝对路径，并逐目录提示会落在哪个仓库）；变更/暂存/未跟踪/忽略分桶，**未跟踪目录行可点击展开**，逐文件与**逐 hunk** 暂存/还原、丢弃（带确认）、提交；分支/远程/stash 面板；同步（fetch/pull/push） |
| 会话改动审阅 | 输入框上方的**可收纳**面板，按**会话**列出改了什么（一行一个文件、文件类型图标、右侧 `+a −b`）；点文件在远程编辑器里打开并画**整行着色 + 行内字符级差异**，右上角 `n/N ↑↓` 跳改动点，悬浮改动行可**撤销**这处改动（远端 `git apply -R`）。详见下文「会话改动审阅」 |
| 并排 Diff | 左右**严格等分** + 中间 gutter 逐 hunk 按钮 + **顶部横向滚动条**（一行很长也不会破坏对称）+ 行号钉在左侧，**只渲染视口内的行**（3000 行文件从 9000 个行容器降到约 174 个，滚动范围与整篇渲染完全一致）；可切「变更前 / 变更后」，变更后可编辑并保存 |
| 提交图 | SVG 分支/合并图 + 提交详情 + 点击提交展开变更文件 + 进文件看 diff |
| 多标签编辑器 | 打开/保存/重载、脏标记、多文件标签并存；图片预览、Markdown/HTML 预览（源码/预览切换） |
| 悬浮编辑器 | 三个入口：文件树 / 搜索结果 / 源代码管理右键「在悬浮编辑器中打开」，以及**双击会话视图的「远程编辑器」标签**把当前编辑器整体浮出（同一套标签、预览、Diff、查找、改动标记，不是另写一个编辑器）。窗口可拖标题栏移动、拖八个边角缩放、最大化/还原、双击标题栏切换最大化；**最小化成一个可拖动的悬浮球**（球上有未保存脏点，点一下或按 Enter 恢复，拖动可换位置）；`Ctrl+滚轮` 缩放编辑器字号；位置、大小、字号和球的位置跨刷新记住 |
| 语法高亮 | VS Code **Dark+ / Light+** 配色；覆盖 java/aidl/smali、c/c++、go、rust、js/ts、json、py、yaml、xml、html/css、md、sh、properties/rc/toml、diff 等；**兜底着色器**在语法包没命中时自动接管，不会出现整篇无色。诚实说明：kotlin / gradle / smali 用 Java 语法着色（没有专用语法包），效果是关键字/字符串/注释正确、专有语法不细分 |
| 查找 | 编辑器内 `Ctrl+F`（`Aa`/`ab_`/`.*`、`3/17` 计数、↑↓、`F3`/`Shift+F3`、`Esc`）；**选中文本按 `Ctrl+F` 直接填入**；查找框钉在右上角，滚动不带走 |
| 跳转 | 从搜索结果点进文件 → 跳到该行 + 垂直居中 + **落地行高亮**（约 2.6 秒后淡出）；同文件反复跳都生效 |
| 多终端 | 标签式多终端（`+` 新建、`✕`/中键关闭带确认）、可跨主机；刷新页面按 session id 自动重连回原会话，**socket 全断开后会话保留 10 分钟**（够刷新、够切浏览器标签页接回），超时才关闭远端 shell |
| 工作区 | 绑定列表 + 路由档位下拉 + 新建工作区双模向导（本地 / 远端） |

### 主机与通道

| 能力 | 说明 |
| --- | --- |
| 主机管理 | 增删改查、连接测试；证书 / 密码认证；配置存 `$DSH_HOME/dsh-remote.json`（0600），与 `dsh-ssh.json` 独立 |
| 密钥 bootstrap | 密码主机一键生成专用密钥对并下发 `authorized_keys`，之后走密钥 |
| 推送流水线 | 远端 arch/系统探测 → 版本比对 → 一致跳过 / 否则推送；executable 通道推送自编译 helper。失败后不再每次远端文件操作都重试：按 **5 秒起步、上限 5 分钟**的退避重试，设置页「推送」按钮可强制立即重试 |
| 远端文件 | SFTP 浏览 / 读 / 写 / 新建 / 删除 / 改名。边界已加固：0 字节文件不再卡死，每个 SFTP 操作 60s 超时回收通道；**单个目录列表上限 20000 条**（按"目录在前、其余按名"排序后取前 20000，宿主日志说明——协议里没有"已截断"字段，界面上没有标记） |
| 远端终端 | ssh2 PTY + WebSocket，xterm 渲染（复制粘贴/主题跟随/刷新重连）；**重新挂接只接管、不改尺寸**（刷新页面不会把运行中的 shell 缩成 80×24）；输出积压时对远端施加真背压；**单帧上限 1 MiB**，超过 64 Ki 字符的粘贴在客户端按码点分块发送，不再撑断连接 |
| 并发通道 | 每主机同时最多 **6 条**远端通道（不再撞远端 sshd 的 `MaxSessions`）；第 7 个排队最多等 **30 秒**，超时明确报 `remote host <alias> is busy`，而不是无限堆连接 |
| 超时与进程清理 | exec 跑在独立会话里（`setsid --wait`），超时先发 TERM、**3 秒后升级 KILL**，连同子进程一起收掉；远端没有 `setsid --wait` 时探测一次即知，退回旧行为并在宿主日志里写明"超时可能没停掉远端命令" |
| Git 图谱 | 远端仓库状态 + 分支 + SVG 提交图 + 提交详情（exec + 前端解析，零 Host 增量）|
| 导入 | 从 `~/.ssh/config`、从现有 `dsh-ssh.json` 一键导入（只读一次，不耦合）|

### Agent 能力

| 能力 | 说明 |
| --- | --- |
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
│   ├── git-ops.ts          # 远端 git 全量动作：status/diff/分支/远程/stash/提交/hunk 补丁构造 + 解析器
│   ├── fs-ops.ts           # 远端文件操作命令构造（复制/移动/删除/stat）
│   ├── search-ops.ts       # 远端内容搜索（grep 构造 + NUL 分隔解析 + 命中切分）
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
│       ├── store.tsx       # 双面共用的模块级状态（useSyncExternalStore；打开的文件/终端/视图都在这）
│       ├── RemoteRoot.tsx  # 右侧栏挂载面：VS Code 式活动栏（资源管理器/搜索/SCM/提交图/编辑器/终端/工作区）
│       ├── RemoteEditorView.tsx # 会话视图挂载面（与 对话/轨迹 并列的「远程编辑器」标签，整屏宽）
│       ├── RemoteExplorer.tsx   # 资源管理器：树 + 右键菜单 + 文件操作 + @ 引用 + 状态标记
│       ├── SearchView.tsx       # 搜索面板：文件名 / 内容 两档 + Aa/ab_/.* + 分组结果 + 跳转
│       ├── EditorPane.tsx       # 编辑器面板：多标签 + 信息栏（构建戳/tok 计数）+ 图片/MD/HTML 预览
│       ├── FloatingEditorWindow.tsx # 悬浮编辑器窗口（标题栏拖动/八向缩放/最大化/最小化悬浮球/字号缩放）
│       ├── float-tab-trigger.ts     # 双击「远程编辑器」标签浮出的文档级监听（标签属于宿主，只能按文字识别）
│       ├── FloatingPlaceholder.tsx  # 编辑器浮出后，中心视图与侧栏留下的「已悬浮」占位 + 停靠按钮
│       ├── float-editor.ts      # 悬浮窗几何/缩放/表面归属规则（纯函数，自检直接驱动）
│       ├── live-editor.ts       # 表面切换时的编辑器缓冲区与滚动/光标交接
│       ├── CodeEditor.tsx       # CodeMirror 封装：语法包表/主题/查找框/跳转/兜底着色接线
│       ├── scm/            # ── 源代码管理 ──
│       │   ├── ScmPanel.tsx     # 变更/暂存/未跟踪 + 逐文件逐 hunk 操作 + 提交框
│       │   ├── DiffView.tsx     # 并排 diff（顶部横向滚动条/hunk 按钮/可编辑变更后侧）
│       │   ├── HistoryPanel.tsx # SVG 提交图 + 提交详情 + 展开变更文件
│       │   ├── actions.ts       # 远端 git 动作层（exec 通道）
│       │   ├── diff-model.ts    # unified diff → 并排行投影（纯函数）
│       │   └── status-map.ts    # 状态分桶 + 树标记（纯函数）
│       ├── vsc/            # ── VS Code 皮肤与控件（零新依赖）──
│       │   ├── kit.tsx / vsc.css    # 图标/对话框/右键菜单/分段控件 + 全部样式（.rvs-root 作用域）
│       │   ├── editor-palette.ts    # Dark+/Light+ 配色 + 固定类名（rvs-ck-*）
│       │   ├── editor-theme.ts      # 编辑器容器主题（明暗热切换）
│       │   ├── editor-langs.ts      # 扩展名 → CodeMirror 语法包
│       │   ├── fallback-highlight.ts# 语法包没命中时的兜底着色（用 tokenize.ts）
│       │   ├── FindWidget.tsx       # Ctrl+F 查找框（固定右上角）
│       │   ├── reveal-line.ts       # 跳转 + 落地行高亮
│       │   ├── tokenize.ts / markdown.tsx # 只读面板分词器 / 零依赖 Markdown 渲染
│       ├── NativeExplorer.tsx# 原生页类型定义 + seat 正文（无 sidebar 兜底）
│       ├── composer.ts / use-remote-chat-target.ts / selection-popup.ts # 远端 @引用/选中加对话
│       ├── api.ts          # /api/dsh-remote 类型化 fetch 封装
│       ├── HostsView / WorkspacesView / WorkspaceWizard / TerminalView / XTerm / Dialog
│       ├── SettingsHosts.tsx        # 设置两节 occupant（主机管理/绑定列表，自取数）
│       ├── DirectoryFlow.tsx        # 原生入口 occupant（本地双模/远端向导）
│       ├── RemoteDirectoryPicker.tsx# 远端目录浏览弹窗
│       └── i18n.ts / theme.ts / ui.tsx # 双语词典/主题信号/共享样式
├── vendor/dsh-remote-helpers/ # helper 种子（随包发布，启动铺缓存，见下）
├── docs/                   # 本地工作文档（不推送 GitHub）
│   ├── P2-PLAN.md          # P2 架构/分期/验收矩阵（含逐项状态）
│   └── MAINTENANCE.md      # 本地私有（.gitignore），不入库：DSH 升级影响面 + helper 升级流程
├── locale/                 # 插件元信息双语
└── lib/                    # 构建产物（gitignored，link 安装后重启即生效）
```

`vendor/dsh-remote-helpers/`（入库）是 helper 种子：插件启动时自动铺到
`$DSH_HOME/dsh-remote-helpers/`（缺啥补啥，永不覆盖），新机器装完即能推送。
新版本 helper 编好后把 4 件套（tarball + sha256 + helper.json + 补丁说明）
换进 vendor 并提交即可（详细步骤在本地维护文档 `docs/MAINTENANCE.md` §4，该文件被 .gitignore，不随仓库分发）。

`.spike/` 与 `scripts/`（都 gitignored，**不随仓库分发**）是开发期的验证与自检脚本：
`.spike/` 里是真机验证脚本 —— `p2-router.ts` 主回归（真远端 + 真 Cordis + 真路由类）+
`grep-probe.mjs` 等探针（用本地的 `tsconfig.scratch.json` 构建），以及不需要真机的
`model-check.mjs` / `reveal-check.mjs` / `fallback-check.mjs` / `client-load-check.mjs` /
`tool-schema-check.mjs`；`scripts/` 里是纯 node 的回归闸门（`node scripts/check-*.mjs`，
其中 `verify-lib.mjs` 核对构建产物）。两者都见下文"开发"。

## 远端工作台（VS Code 式）

![侧栏四个视图：文件树、搜索、源代码管理、历史](docs/media/sidebar-views.gif)

两个挂载面共用一份状态（`store.tsx`）：**右侧栏「远程」**（装了 better-sidebar 走独立 tab，
否则走原生右栏页）与**会话视图「远程编辑器」**（与 对话/轨迹 并列，代码区整屏宽）。

- **活动栏**：资源管理器 / 搜索 / 源代码管理 / 提交图 / 编辑器 / 终端 / 工作区；面板首次访问后
  保持挂载，切回来不重新拉取、不闪。隐藏期间**不做远端工作**（目录列表、SCM 的 stash/分支/远程查询、
  编辑器图片读取都等回到前台再补一次），可见性是对插件根节点实测的（IntersectionObserver），
  不靠宿主传参。
- **切工作区不空白**：每个（工作区, 仓库目录）最近一次读到的 git 状态留在内存里，切回时**同一帧**画出
  更改列表、分支和文件树上的状态标记，再在后台重读替换；期间面板标「缓存 · 后台刷新中」，更改列表与
  暂存/提交/丢弃等按钮照常作用于该工作区（⟳ 与「重置仓库目录」在后台读期间置灰 —— 再点只会对同一棵树
  重复排队）。同一**仓库目录**同时最多一条 git 读（换目录时新旧目录的读会并行，它们本来就是两个目录）；
  手动刷新的结果一定晚于点击（排在后台读之后取最新结果），切走的读只写自己那份缓存、绝不上屏；后台读
  失败保留原列表并显示原因，不会把工作区误判成"没有仓库"。刷新浏览器/重启 Host 后第一次切换仍要等
  一次，这是有意的。
- **编辑器**：多标签 + 信息栏（路径、语言、**构建戳**、`tok N` 着色 token 数、已保存状态、重载/保存）。
  信息栏三个标记是给排障用的：构建戳判定"浏览器跑的是不是刚编的包"，`tok 0` 判定语法包是否命中。
- **悬浮编辑器**：文件树 / 搜索结果 / 源代码管理右键「在悬浮编辑器中打开」，或双击「远程编辑器」标签，
  编辑器整体浮到页面最上层的窗口里（同一份标签与缓冲区，关闭/停靠后回原表面）。标题栏可拖动、八个边角
  可缩放、可最大化/还原；**最小化成一个 44px 悬浮球**（不占整条标题栏，可拖到任意角落，单击/Enter 恢复，
  有未保存改动时球上带黄点），`Ctrl+滚轮` 调字号；未保存内容在「主界面 ↔ 悬浮窗」以及标签页切换之间
  显式交接（磁盘侧基线单独保留，脏标记不会误判成已保存），不会被切换动作吞掉。
- **查找与跳转**：`Ctrl+F` 查找框固定右上角（`position: fixed` 锚定编辑器矩形，任何祖先滚动都不带走）；
  选中文本按 `Ctrl+F` 直接填入；从搜索结果跳转会**居中 + 落地行高亮**。
- **终端**：标签式多终端，session id 逐个持久化，刷新页面自动重连回原会话；**重连只接管、不改尺寸**
  （活着的 shell 不会被缩成 80×24——真实尺寸由能测到自己的那个标签发 `resize` 帧）；socket 全断开后
  会话保留 **10 分钟**，超时才关闭远端 shell（以前是永不回收，关掉浏览器后远端 shell 一直占着 sshd 会话槽）。
- **已知边界（诚实说明）**：
  - 切到「远程编辑器」标签**没有公开 API**，插件只能按标签文字点击外壳自己的 tab，失败时给 toast
    提示手动切（`revealEditor()`）；
  - 未跟踪目录在状态里是**一行**（`dir/`），点它**展开**该目录里的文件（只发一条限定路径的
    `git status -uall -- dir/`，成本随目录而不随仓库；再点收起）；展开态是「展开那一刻」的快照，
    折叠再展开即刷新；
  - 打开文件读取上限 8MiB（helper 官方常量），超限以只读方式呈现；
  - 查找框用固定定位浮在代码上方（与 VS Code 一致），不占布局空间；
  - 输出背压是**按 shell** 的：某个跟不上的标签会连带暂停该 shell 的所有标签（宁可让最慢的消费者
    拖住远端命令，也不让宿主内存无界增长）；
  - 目录列表超过 20000 条会被截断，而协议里没有"已截断"字段 ⇒ 界面上没有任何标记，只有宿主日志里的
    `listing <path> on <alias> shows 20000 of N entries`。

## 会话改动审阅（Cursor 式）

![会话改动审阅：面板列出本次会话改动的文件，点开后整行着色并标出行内字符级差异，右上角可逐个改动点跳转，鼠标悬停即可撤销这一处改动](docs/media/session-change-review.gif)

输入框上方那条**可收纳**的面板（标题「本次改动」）按**会话**回答"这一轮改了什么"。数据来自插件自己的
会话改动账本（`/api/dsh-remote/changes`），不是 DSH 的 `workspaceChanges` —— 后者看不见被路由的会话
（探针实测：58 个远端会话、0 个改动事件）。

- **面板**：一行一个文件（文件类型图标 + 相对路径 + 右侧 `+a −b`），宽度与输入卡**左右对齐**；
  点标题栏折叠/展开，`⟳` 强制立即重扫。没有改动时显示「本会话还没有改动文件。」；统计不出来时显示
  **具体原因**（见下面的边界），不会丢一个空列表让人猜。
- **点文件**在远程编辑器里打开，并画上改动标记：新增行**绿色行背景**，删除的字符用**行内删除线 chip**
  表示（被删的字符在新文件里不存在，只能用插入的 widget 画），左侧 gutter 一列改动色条。
- **跳改动点**：编辑器右上角悬浮 `n/N ↑↓`（快捷键 `Alt+Shift+Cmd/Ctrl+↓/↑`），在改动点之间循环跳转；
  编辑器里一敲字，标记即作废并提示「位置已过期」。
- **撤销这处改动**：悬浮在改动行上点一下 → 远端 `git apply -R`。上下文对不上时远端直接拒绝（文件一个
  字节都不动）；标签页里有未保存内容时先拒绝，绝不会用远端补丁盖掉你的编辑；成功后光标留在原处，
  标记自动重读刷新（不会因为"撤销了"就整片标记消失）。
- **跟随会话工作区**：侧栏、编辑器下拉、文件树三者跟着**当前会话所在的工作区**走；用户手动切换后同一
  会话内不再被拉回，换会话重新跟随。跟随能力在 store 层，**侧栏从未打开过也照样跟随**；在改动面板点
  文件属于"看结果"，不算手动切换。
- **仓库目录**：沿用「源代码管理 → 仓库目录」里用户选的那个（显式选择永远优先）；会话根不是仓库时，
  只在**唯一候选**（根下一层只有一个仓库）时自动采用，多个候选会明确提示去「源代码管理」设置里指定。

**已知边界（如实写）**：

- 改动统计以**会话起点**为基线（不是 HEAD）：会话开始前就存在的未跟踪文件不会被算成本次改动。
- 已跟踪文件的数字随**轮次结束**刷新（面板每 3 秒轮询兜底，通常一两秒内跟上）；**新文件**（在 shell 里
  创建的）靠**慢扫描**发现，单次预算最长约 **3 分钟**，重扫间隔按上次耗时自适应（至少 5 秒，大仓库会
  自然拉长）；点 `⟳` 可强制立即重扫。
- 非 git 工作区、或工作区里有多个仓库而没指定仓库目录时，面板显示明确原因
  （`no git repository at the workspace root, and N candidates below it — set the repository directory in Source Control`），不显示空列表。
- 二进制文件与超大文件只在行尾标「二进制 / 过大」，不给字符级差异。

## P2 透明远端执行（Windows 原生）

单 Host 混合路由：原生工具按会话 cwd 落在哪个世界自动分发 —— 远端 alias 走
helper RPC（fs）/ ssh2（进程），本地一切不变；两者同 Host、共 GUI。

- 别名目录：`$DSH_HOME/remote-ssh/aliases/<id>`（空壳，只做路由键），自动注册进原生工作区列表，标题 `<server> > <base>`
- 路由开关（设置 → 远程主机页顶部下拉；底层是 profile patch `- id: remote-vs` 下 `config.routingMode`，volatile，免重启）：
  默认 `enforce`（真路由）；可切 `off`（纯直通本地）/ `shadow`（记日志仍走本地）作为排障开关
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
- 源码：`dsh-v0.2.1-alpha.2` tag（**构建基线**：对齐的是 wire 协议号，不是 Host 版本号 —— 我们用到的
  协议号仍是 **2**，Host 升到 `0.2.2-alpha.2` 也不需要重编：插件自行停在 `dsh-ssh@0.2.1-rc.2`，
  新 Host 那一代 `dsh-ssh` 的协议 3 我们故意不跟，差异见维护文档 §2.26）
- 命令：官方原脚本 `pnpm exec tsx scripts/build-exe-for-ssh-helper.ts --target=node24-linux-x64`
- 唯一偏离：无 docker 跑不了 manylinux 2.28 重编，加了 `DSH_GLIBC_CEILING`
  环境覆盖（默认仍 2.28），本次以 2.35 构建（见缓存目录 `glibc-ceiling.patch`）
- 校验：官方 `verify-ssh-helper-artifact.ts --sandbox=required` 8 项全绿
- 缓存：`$DSH_HOME/dsh-remote-helpers/`（`*.tar.gz` + `.sha256` + `.helper.json`
  含 binarySha256，供 P2 的 helperHash）
- 升级重编全流程见本地维护文档 `docs/MAINTENANCE.md` §4（.gitignore，不随仓库分发）

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

**改完怎么生效：`pnpm run build` 之后重启 `dsh web` —— host 半与客户端半都是。**
**`lib/` 是入库的**：本包没有 `prepare`（pnpm 12 会拦），别人 `dsh plugin add github:…` 拿到的是仓库内容，
所以**改完源码必须 `npm run build` 并把 `lib/` 一起提交**（`node scripts/verify-lib.mjs` 会核对入口齐全、
已入库、能加载；自检脚本只在本机，见下）。
Host 在启动时把插件包读进内存（`initialBundleSnapshot`：先记录 mtime/ctime/size 作为 rev，再读字节；
响应头 `Cache-Control: public, max-age=31536000, immutable`），所以**只改 `src/client/**` 也一样**：
浏览器刷新——包括 `Ctrl+Shift+R`——只会取回启动时抓下的那批字节，rev 不变。判定方法：

1. 构建后 `lib/client.js` 里会注入构建戳（`MMDD-HHmm`），编辑器信息栏右侧显示的就是它；
2. 重启 `dsh web` → 刷新页面：**戳变了才算生效**（没变 = 拿到的还是启动时那批字节）；
3. 颜色类问题再看 `tok N`：`0` = 该扩展名没命中语法包，且兜底着色器也没接管（会给括号里的文件路径）。

> 唯一的例外是 DSH 自己的开发 watcher（`pnpm run dev:web`，走 `ClientModuleRegistry.rebuilt`）；
> 插件用户侧没有 watcher，`dsh web --help` 也没有 watch 选项，所以按"必须重启"执行。

自检（不需要真机、不需要 DSH，几十秒）：

```sh
node .spike/client-load-check.mjs # 真求值客户端模块：加载期错误（模块级 TDZ 之类）tsc、打包、其它 harness 都看不见
node .spike/tool-schema-check.mjs # 5 个 agent 工具：跑一遍 execute，用运行时的同一个校验器核对返回值和声明的输出 schema
node .spike/model-check.mjs      # 55 项：真 git 输出 → 解析器、diff 模型、hunk 补丁可应用性、类名↔CSS 契约
node .spike/reveal-check.mjs     # 5 项：跳转落点、落地高亮、同文件二次跳转
node .spike/fallback-check.mjs   # 12 项：兜底着色器在真 DOM 里给 java/cpp/shell 上色
node .spike/editor-dom-check.mjs # 12 项：真 CodeMirror 在 jsdom 里对 java/shell/cpp 产出着色 span
node .spike/i18n-check.mjs       # 中英词典一致性：无缺失键、无孤儿键、占位符形状一致
node .spike/ref-check.mjs        # 32 项：assertRef 接受合法修订后缀、拒绝一切注入面
node .spike/status-check.mjs     # 真 shell 里跑生成的 git 命令，验证退出码不再被管道掩盖
node .spike/cache-check.mjs      # 增量分词缓存 vs 整篇分词，9 种语言 × 8 种编辑形态逐字节比对
node .spike/layout-check.mjs     # 高度链与滚动条契约：标签栏固定不被顶走、编辑器滚动条够宽可点
node .spike/viewstate-check.mjs  # 滚动+光标跨重挂的往返（有状态 scrollTop，能区分"恢复"与"被重置"）
node .spike/tabswitch-check.mjs  # 真 React 驱动三种接线：两种读 ref 的必须失败，上报式必须成功
node .spike/letter-check.mjs     # 状态字母：未跟踪 ? 与冲突 U 不再撞车，其它映射与两处渲染点
```

`.spike/layout-fixture.html`（由 `build-fixture.mjs` 生成）是浏览器里量布局用的夹具：
它把**宿主真实的插槽 CSS** 和**线上 vsc.css** 机械内联进去，改完 CSS 重跑
`node .spike/build-fixture.mjs` 即可在真浏览器里量高度链、滚动容器与滚动条宽度——
纯 CSS 的问题 tsc、打包、jsdom 都看不见，这个夹具是唯一能复现它们的地方。

`markdown-check.ts` 需要先编译（它 import `.tsx`，Node 不能直跑）：
`npx tsc -p tsconfig.scratch.json && node .spike/build/.spike/markdown-check.js`。

> `.spike/` 被 `.gitignore` 排除，这些检查只在本地存在、没有 CI；因此**引用任何数字前都要当场跑一遍**，
> 不要照抄任何一处写着的数字（同一个 `model-check` 曾在 README / 本地维护文档 / 评审报告之间漂移出
> 44 / 48 / 55 三种，而它实际打印 55/55 —— 脚本里有 57 处 `check(` 调用点，其中 2 处在循环里且只在
> 失败时才触发，所以「调用点 57」与「跑出来 55」本来就该差 2）。

真机回归仍是 `npx tsc -p tsconfig.scratch.json && node .spike/build/.spike/p2-router.js`。
DSH 发新版时先读本地维护文档 `docs/MAINTENANCE.md`（§2 逐项耦合点 + §3 升级清单）再动手；该文件被 .gitignore，克隆仓库的人看不到，改动 host 半后的必做动作是 `pnpm run verify:lib` + 加载自检。

## 开源许可

MIT © 2026 xiray-xia —— 见 [LICENSE](./LICENSE)。

`vendor/` 里的 helper 种子由 DeepSeek Harness 源码（MIT）按 `dsh-v0.2.1-alpha.2`
tag 以官方原脚本构建，具体流程与唯一有记录的偏离见上文"Helper 自编译"节
（种子包里的 `glibc-ceiling.patch`）。
