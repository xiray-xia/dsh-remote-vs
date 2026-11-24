# 第三方组件与许可证（THIRD-PARTY NOTICES）

`dsh-remote-vs` 自身以 MIT 许可发布（见 [LICENSE](./LICENSE)）。本文件列出**随发行包分发**或**由本包声明依赖**的
第三方组件、版权人与许可证，并说明许可证全文的获取位置。

口径（2026-11-23，插件 `0.25.0`；按 `package.json`、`pnpm-lock.yaml` 与 `node_modules` 实际版本核对）：

- **内联** = 该包的代码被构建进本包产物。宿主半（`lib/index.js`、`lib/p2-*.js`）按 `tsdown.config.ts` 的
  `noExternal: ['ssh2']` 打包（`cpu-features` 与 `sshcrypto.node` 保持 external，纯 JS 路径才是实际发布形态）；
  浏览器半（`lib/client.js`）除平台共享模块（`react`、`react-dom`、`cordis`、`@deepseek-ai/dsh-client-ui-*`）外全部内联。
- **安装** = 未内联，由 `package.json` 的 `dependencies` 在安装时放进 `node_modules/`，运行时加载。
- **宿主提供** = `peerDependencies`，由 DSH 宿主提供，不随本包分发。
- 内联进宿主产物的 ssh2 链**只存在于 `devDependencies`**（构建期内联），使用者安装本包后 `node_modules/` 里
  不会有这些目录，因此正文直接给出其版权行，并在第 5 节附上许可证正文。

## 1. 内联进宿主产物（`lib/index.js`、`lib/p2-*.js`）

| 组件 | 版本 | 许可证 | 版权行（LICENSE 原文） |
|---|---|---|---|
| ssh2 | 1.17.0 | MIT | `Copyright Brian White. All rights reserved.` |
| asn1（ssh2 依赖） | 0.2.6 | MIT | `Copyright (c) 2011 Mark Cavage, All rights reserved.` |
| safer-buffer（asn1 依赖） | 2.1.2 | MIT | `Copyright (c) 2018 Nikita Skovoroda <chalkerx@gmail.com>` |
| bcrypt-pbkdf（ssh2 依赖） | 1.0.2 | BSD-3-Clause（`package.json`）；LICENSE 同时含 bcrypt_pbkdf 与 Joyent 的 ISC 式条款 | `Copyright 1997 Niels Provos <provos@physnet.uni-hamburg.de>`、`Copyright (c) 2013 Ted Unangst <tedu@openbsd.org>`、`Copyright 2016, Joyent Inc` / `Author: Alex Wilson <alex.wilson@joyent.com>` |
| tweetnacl（bcrypt-pbkdf 依赖） | 0.14.5 | Unlicense（public domain） | 无版权行，正文见 5.3 |

## 2. 内联进浏览器产物（`lib/client.js`）

以下 41 个包全部为 MIT；版权行统一为“`Copyright (C) <年份> by Marijn Haverbeke <marijn@haverbeke.berlin> and others`”
一族，个别包的年份/邮箱/共同作者不同，逐包原文见其 `LICENSE`。

| 组件族 | 版本 | 许可证 | 版权行（原文要点） |
|---|---|---|---|
| `@codemirror/*`：autocomplete、commands、lang-cpp、lang-css、lang-go、lang-html、lang-java、lang-javascript、lang-json、lang-markdown、lang-python、lang-rust、lang-xml、lang-yaml、language、legacy-modes、search、state、streamparser、view | 6.x：autocomplete 6.20.3、commands 6.11.1、lang-cpp 6.0.3、lang-css 6.3.1、lang-go 6.0.1、lang-html 6.4.12、lang-java 6.0.2、lang-javascript 6.2.5、lang-json 6.0.2、lang-markdown 6.5.2、lang-python 6.2.1、lang-rust 6.0.2、lang-xml 6.1.0、lang-yaml 6.1.3、language 6.13.1、legacy-modes 6.5.3、search 6.5.11、state 6.7.6、streamparser 6.0.0、view 6.43.14 | MIT | `Copyright (C) 2018-2021`（lang-go、lang-yaml 为 `2024`）`by Marijn Haverbeke <marijn@haverbeke.berlin> and others` |
| `@lezer/*`：common、cpp、css、go、highlight、html、java、javascript、json、lr、markdown、python、rust、xml、yaml | common 1.5.3、cpp 1.1.6、css 1.3.9、go 1.0.1、highlight 1.2.3、html 1.3.13、java 1.1.5、javascript 1.5.6、json 1.0.3、lr 1.4.11、markdown 1.8.0、python 1.1.19、rust 1.0.3、xml 1.0.6、yaml 1.0.4 | MIT | `Copyright (C) <2018 或 2020> by Marijn Haverbeke <marijn@haverbeke.berlin> and others`；`@lezer/yaml` 写的是 `<marijnh@gmail.com>`；`@lezer/json` 还列 `Arun Srinivasan <rulfzid@gmail.com>` |
| `@xterm/xterm`、`@xterm/addon-fit` | 6.0.0、0.11.0 | MIT | `Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)`、`Copyright (c) 2014-2016, SourceLair Private Company`、`Copyright (c) 2012-2013, Christopher Jeffrey`；addon-fit 为 `Copyright (c) 2019, The xterm.js authors`。内联的 `xterm.css` 头部另保留经作者许可 fork 自 Fabrice Bellard jslinux vt100 的设计出处说明（`Copyright (c) 2011 Fabrice Bellard`） |
| style-mod、crelt、w3c-keyname、@marijn/find-cluster-break | 4.1.4、1.0.7、2.2.8、1.0.4 | MIT | 依次为 `Copyright (C) 2018 ... and others`、`Copyright (C) 2020`、`Copyright (C) 2016 ... and others`、`Copyright (C) 2024`，作者均为 Marijn Haverbeke |

注：`@codemirror/lint` 虽在依赖树里（由 `@codemirror/lang-javascript` 声明），但产物没有任何代码引用它，故未内联、不列入上表。

## 3. 运行期依赖（未内联，随包安装）

| 组件 | 版本 | 许可证 | 版权行（LICENSE 原文） |
|---|---|---|---|
| ws | 8.22.0（`package.json` 声明 `^8.18.0`） | MIT | `Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>`、`Copyright (c) 2013 Arnout Kazemier and contributors`、`Copyright (c) 2016 Luigi Pinca and contributors` |
| zod | 4.6.6（精确 pin） | MIT | `Copyright (c) 2025 Colin McDonnell` |
| `@deepseek-ai/dsh-ssh` | 0.2.2-rc.5（精确 pin） | MIT（DSH 项目） | 见 npm 包内 `LICENSE` |
| `@deepseek-ai/dsh-fs-ssh` | 0.2.2-rc.5（精确 pin） | MIT（DSH 项目） | 见 npm 包内 `LICENSE` |
| `@deepseek-ai/schemastery` | 3.19.0（精确 pin） | MIT（DSH 项目） | 见 npm 包内 `LICENSE` |

## 4. 由宿主提供的 peer 依赖（不随本包分发）

`react`、`react-dom`（MIT，`Copyright (c) Facebook, Inc. and its affiliates.`）与其余 `@deepseek-ai/*`
（`cordis`、`dsh-*`；DSH 以 MIT 发布）由 DSH 宿主提供，本包只声明 peer、不打包其代码；§3 里的三个
`@deepseek-ai/*` 是本包的**运行期依赖**（非 peer），由 npm 随包安装、同样不内联。

`vendor/` 下的 helper 种子由 DeepSeek Harness 源码（MIT）按 `dsh-v0.2.2-rc.4` tag 用官方脚本构建，并内嵌
Node.js 运行时（MIT）；构建流程与两处偏离见 README「Helper 自编译」。

## 5. 许可证正文与获取位置

- **随安装提供的包**（第 3、4 节）：安装后 `.dsh` 剖面/工程里 `node_modules/<包名>/LICENSE` 即原文；pnpm
  布局下为 `node_modules/.pnpm/<包名>@<版本>/node_modules/<包名>/LICENSE`。
- **内联且不随安装提供的包**（第 1 节的 ssh2 链）：原文在本仓库开发树的同一条 `.pnpm` 路径下，
  另可在上游仓库（ssh2: `mscdex/ssh2`；asn1: `mcavage/node-asn1`；safer-buffer: `ChALkeR/safer-buffer`；
  bcrypt-pbkdf: `joyent/node-bcrypt-pbkdf`；tweetnacl: `dchest/tweetnacl-js`）取得；其正文按许可证要求
  抄录于 5.1–5.3。
- 内联的浏览器包（第 2 节）全部为 MIT，正文即 5.1 的通用 MIT 文本，各自版权行见上表。

### 5.1 MIT（以下包共用此正文；版权行见各表）

```text
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### 5.2 bcrypt-pbkdf（1.0.2，LICENSE 全文）

```text
The Blowfish portions are under the following license:

Blowfish block cipher for OpenBSD
Copyright 1997 Niels Provos <provos@physnet.uni-hamburg.de>
All rights reserved.

Implementation advice by David Mazieres <dm@lcs.mit.edu>.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. The name of the author may not be used to endorse or promote products
   derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.



The bcrypt_pbkdf portions are under the following license:

Copyright (c) 2013 Ted Unangst <tedu@openbsd.org>

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.



Performance improvements (Javascript-specific):

Copyright 2016, Joyent Inc
Author: Alex Wilson <alex.wilson@joyent.com>

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### 5.3 tweetnacl（0.14.5，Unlicense 全文）

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org>
```
