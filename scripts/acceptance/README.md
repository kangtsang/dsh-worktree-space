# 验收

本目录有两套东西，用途不同、产出也不同，但共用 `install-hosts.ps1` 装出来的 DSH 版本——那是最容易记错的一环，
所以放在一起。

| | 入口 | 产出 | 谁用 |
| --- | --- | --- | --- |
| **发布证据** | `run-all.ps1` | `docs/store-evidence.md` 第 5 节那张矩阵 | 无人值守，换声明窗口时重跑 |
| **手工验收** | `start-acceptance.ps1` | 一个活着的进程 | 一个人、一个浏览器 |

矩阵脚本装齐所有声明版本、六阶段跑完、输出进证据表；手工脚本打包装好起 web 就停在那儿，**由人决定功能对不对**。
两者不合并：合并会让矩阵脚本背上一个「启动后挂起等超时」的循环，而它没有任何场景需要这个循环。

> ⚠️ **这些脚本会递归删除文件。** 动手改之前先读完本文件，尤其是「删除范围」那一节。
> 本插件的验收脚本曾因一个变量名把整个用户目录删掉，过程见 `docs/store-evidence.md` 第 1 节。

## 前提条件

| # | 需要什么 | 不满足会怎样 |
| --- | --- | --- |
| 1 | **Windows + PowerShell**。用到 `Get-NetTCPConnection`、`Get-CimInstance Win32_Process`、`taskkill /T /F`、`Start-Process`、`.bin\dsh.cmd` | macOS / Linux 上**完全跑不了**，没有降级路径。PowerShell 5.1 与 7 都可 |
| 2 | **`node`、`npm.cmd`、`pnpm` 在 PATH 上**。DSH 要求 node >= 22.19.0 | `install-tarball.ps1` 或安装步骤直接找不到命令 |
| 3 | **能访问 npm registry** | `install-hosts.ps1` 装不上任何 DSH 版本 |
| 4 | **约 2 GB 空闲磁盘**。四个版本装完是 1.8 GB / 10.6 万文件，约 3 分钟 | 装到一半磁盘满 |
| 5 | **端口空闲**。矩阵从 34800 起连着四个，手工默认 34822 | 占用时**直接失败并报出端口号（和占用它的 PID）**，不会闷头换一个——地址要写下来才查得回 |
| 6 | **执行策略允许运行**。用 `pnpm acceptance:*` 入口会自动带 `-ExecutionPolicy Bypass`；直接 `.\run-all.ps1` 可能被拦 | 被拦时改用 npm script 入口 |

**不需要**的：

- 不需要 `pnpm install`。`pnpm pack` 只读 `package.json` 的 `files` 字段，在没有 `node_modules` 的干净克隆上就能打包
- 不需要 git。脚本只按 `$PSScriptRoot\..\..` 找 `package.json`，任何一份仓库副本都能跑
- 不需要预先装 DSH。`install-hosts.ps1` 装的就是要用的那些，**手工验收也复用它**

**建议**：矩阵的默认根落在 `%TEMP%`，而 `%TEMP%` 正是本项目事故里被整个删掉过的目录。守卫保证脚本自己只删
`<RunRoot>\homes` 和 `<RunRoot>\logs`，但把一次性产物放在一个会被系统或人工定期清理的地方仍然不是好主意。
正式跑之前显式指定一个自己的目录：

```powershell
.\scripts\acceptance\run-all.ps1 -RunRoot D:\dsh-acceptance\run -HostsRoot D:\dsh-acceptance\hosts
```

---

# 一、发布证据矩阵

```powershell
.\scripts\acceptance\install-hosts.ps1      # 按清单声明装齐各个 DSH 版本
.\scripts\acceptance\install-tarball.ps1    # pnpm pack 出被测 tarball
.\scripts\acceptance\run-all.ps1            # 从新到旧逐个版本跑六阶段
.\scripts\acceptance\guard-tests.ps1        # 删除守卫的回归测试（不装任何东西）
```

`run-all.ps1` 默认把 DSH 安装放在 `%TEMP%\dsh-acceptance\hosts`、运行目录放在
`%TEMP%\dsh-acceptance\run`。两个都可以用 `-HostsRoot` / `-RunRoot` 改，端口从 `-PortBase 34800`
起按版本顺序分配。

版本列表**从 `package.json` 的 `dsh.compatibility.dshReleases` 读**，不在脚本里另写一份，
所以不会和清单声明走偏。

跑完 `run-all.ps1` 会打印每格结果，并留下 `<RunRoot>\homes` 与 `<RunRoot>\logs` 供查验；
**脚本不清理它们**，由你自己看完再删。

### 可见性探测的三个前提

第 4 阶段判定「插件可见」时，这三点缺一个就会看到像插件坏了的假象：

1. **必须带会话 cookie。** 启动 url 里的 token 在首次访问首页时换成 `dsh-auth-*` cookie。不带它，
   `POST /api/...` 一律 405、`GET /api/...` 一律 404——连宿主自己确定存在的路由也一样。那是鉴权在前，
   不是路由缺失。
2. **信封里的 `method` 是 `/api/` 之后的整段**，即 `dsh-worktree-space/task.preference`，
   只写 `task.preference` 会被判 `RPC method does not match endpoint.`。
3. **bundle 地址是页面相对的**：`plugins/??dsh-worktree-space/client.js&rev=<rev>`。
   路径多一个斜杠会落到 SPA 兜底页——**返回 200、`text/html`、字节数和首页一模一样**，看着完全正常。

---

# 二、手工验收实例

一条命令把当前工作树变成浏览器能打开的实例，然后停下来等人在页面上驱动：

```powershell
.\scripts\acceptance\start-acceptance.ps1 -Port 34822
```

四步打包、安装、建 profile、启动 web 实例都做完了，脚本停在页面上，**由你决定功能对不对**。Ctrl-C 或
`-HoldSeconds` 到期后关闭，`case.env` 里留下 URL、路径和日志位置。

> **`stop-tree.ps1` 是共享的，不是入口。** 它只定义一个函数 `Stop-ProcessTree`，被 `run-one.ps1`、
> `start-acceptance.ps1`、`invoke-bounded.ps1`、`install-hosts.ps1` 以 dot-source 引入，自己什么都不执行。
> 四个脚本都要杀进程树，所以定义一份比各写一份更诚实——本目录的守卫是靠 AST 从入口脚本里抽出来测的，
> 重复四份就等于有四份可以各自漂移的守卫。它本身**一个 `Remove-Item` 都没有**（注释里那两处是在解释
> 它为什么故意不留删除面），也没有非 ASCII 字节。

| | |
| --- | --- |
| **做** | 检查 bundle 新鲜度 → `npm pack` → 建 profile → `dsh plugin add` 装 tarball → 建 fixture 仓库 → 启 web 实例 → 停在那儿 |
| **不做** | **不构建**（只检查 `lib/`、`client/` 是否比 `src/` 新，旧了就拒绝）、不判断功能对错，不跑测试矩阵，不装 DSH 版本，不清理自己建的目录 |

### ⚠️ 它不构建，只检查

脚本**不会**替你跑 `node build.mjs`。改完源码直接跑它，打的是 `lib/` 里**已经躺着的那份产物**——
而这件事**页面上看不出来**：陈旧 bundle 和新 bundle 在浏览器眼里一模一样，npm 安装时还会重新盖一次
`package.json` 的时间戳，所以「装上去是什么时候」也答不了这个问题。

所以脚本在打包**之前**比一次时间：`lib\index.js`、`client\client.js` 里最新的时间，早于 `src\`、
`client\`（除 bundle 自身）里最新的文件时间，就**直接失败**并打印是哪几个文件、该怎么处理：

```
The bundle is older than the source it was built from, so packing now would serve the previous build:
  newest source : ...\src\host\index.js  (2026-10-03 16:04:58)
  built at      : 2026-10-03 14:44:06
```

停在这里花掉一次回车；装一个旧包、对着页面排查一个**已经在工作区里、而且完全正确**的改动，
花掉的是一个下午。

明知这次不该带上工作区里的源码改动，用 `-SkipBuildCheck` 跳过。

不装 DSH 是有意的：版本由 `install-hosts.ps1` 装一次就够，每次重装 2 GB / 3 分钟没有意义。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-CaseRoot` | `D:\dsh-acceptance\case` | 验收根。DSH home、日志、fixture、容器都在它下面 |
| `-Port` | `34822` | 端口。**不能用 3080**——那是桌面实例的默认值，占着会让 webserver 插件激活失败 |
| `-DshVersion` | `0.2.0-rc.2` | 用哪个已装版本 |
| `-HostsRoot` | `D:\dsh-acceptance\hosts` | DSH 安装根 |
| `-HoldSeconds` | `3600` | 打印 URL 后维持多久 |
| `-SkipPack` | 否 | 复用已有的 tarball，只改 profile 配置时用 |
| `-SkipBuildCheck` | 否 | 跳过「bundle 比源码旧」的检查。只在**明知**这次不该带上工作区的源码改动时用 |
| `-FixtureRepos` | `2` | fixture 里几个 git 仓库。1 个够验证流程，2 个能看出按仓库并排的 worktree |
| `-PluginRepo` | 本仓库 | 要打包的仓库。不是脚本自己的目录——`npm pack` 读的是工作目录下的 `package.json`，不指定会在脚本旁边找然后 ENOENT |

### 每次重建的范围

只有一处递归删除：**上一次的 DSH home**，且删除前要通过四道检查——路径必须是 `$CaseRoot` 的直接子目录、
叶子名必须正好是 `home`、不能是根本身、路径上不能有 reparse point（`Remove-Item -Recurse` 在 Windows 上
会跟随 junction）。

`Remove-Item -Recurse` 跟随 junction 这一点是这里唯一真正危险的地方，所以检查是逐级向上走完的，不是只看终点。
本项目出过整个用户目录被删的事故，根因是 `$home` 是只读自动变量、赋值静默失败——脚本里所有变量名都避开了自动变量。

### 容器根在 case 根之外 ⚠️

**跑之前要知道的一件事**：容器根不是脚本能配置的，它由插件从 source root 推导——取 source root 在卷根下的
第一个目录，拼 `worktree-space`（`src/host/task/paths.js` 的 `firstDirectoryBelowRoot`）。

所以 case 根是 `D:\dsh-acceptance\case` 时，容器根是：

```
D:\dsh-acceptance\worktree-space      ← 在 case 根的上一级
```

**它在脚本的重建范围之外**，上一次跑残留的容器和分支不会被清掉。后果是：拿残留分支的名字去创建，会在
`E3001 分支已存在` 上失败——看起来像插件坏了，其实是个陈旧目录。

脚本检测到这一情况会在输出里提示，并打印出那个路径。确认不需要了就手动删；它是唯一需要手工处理的东西，
删之前先看一眼内容。

fixture 故意放深一层（`case\fixture\source`）就是为了让容器根和 case 根平级，而不是落在 case 根里面——
落在里面会让日志和 `case.env` 混在一起。

### 排查

`case.env` 里记了这一轮的全部路径：

```
DSH_HOME=...      插件配置和凭据都在这里
FIXTURE=...       source root
REPOS=...         分号分隔
CONTAINER_ROOT=   插件实际用的容器根
AUDIT_LOG=        操作日志文件
PORT=...          这一轮的端口
URL=...           这一轮的地址（含 token）
PID=...           服务器进程号
LOGS=...          全部命令输出
```

**读地址读这个文件，不要等后台任务的输出回传**：回传会被打断，而 `case.env` 是脚本自己写的、可重复读的落盘结果。

启动失败时脚本会把命令输出和 stderr 原样打出来，不截断——证据里必须能看到实际发生了什么。

---

# 改这些脚本时请保留

## 删除范围

`run-one.ps1` 是矩阵里唯一会删东西的脚本，它只能删两类路径：

| 路径 | 约束 |
| --- | --- |
| `<RunRoot>\homes\home-<版本号>` | `<RunRoot>\homes` 的**直接**子目录，名字精确匹配，整条路径上**没有 reparse point** |
| `<RunRoot>\logs\log-<版本号>` | 同上，根换成 `<RunRoot>\logs` |

其余一切——DSH 安装、tarball、`<RunRoot>` 本身、用户目录、盘根——在这个脚本里**结构上删不掉**：
`Assert-Under` / `Assert-DirectChild` 会在 `Remove-Item` 之前把它们逐个拒掉。
`install-hosts.ps1` 与 `run-all.ps1` 里**一条 `Remove-Item` 都没有**（`install-tarball.ps1` 只删它自己
刚打出的那个 tarball）。`start-acceptance.ps1` 只删上一轮的 DSH home，约束见上面那一节。

`guard-tests.ps1` 用 PowerShell 的 AST 从 `run-one.ps1` 里**把守卫函数抠出来跑**，不是抄一份——
抄的版本会和真实代码漂移，而只存在于测试里的守卫证明不了任何事。改名或删除守卫函数，这个测试会直接失败。
它跑完打印 `GUARD-OK` 或 `GUARD-FAIL`，**无论哪种都不删任何东西**——它只调用守卫，看它们拒不拒。

## 已知脆弱点

`run-one.ps1` 按固定路径找 DSH 的入口 `<HostsRoot>\<版本>\node_modules\@deepseek-ai\dsh\lib\bin.js`。
这是 DSH 包**内部**的布局，不是它的公开接口。四个 0.1.7–0.2.0 的版本上它都成立，但 DSH 一旦调整
bin 位置，脚本会以 `missing DSH at ...` 失败——这是刻意的：宁可明确报错，也不要静默换一条来路不明的入口。

## 别动的部分

- `run-one.ps1` 头部注释里的六条安全契约
- `run-one.ps1` 里全部五个守卫函数，以及 `guard-tests.ps1` 对它们的提取
- `run-all.ps1` 的「先解析后运行」检查
- 所有 `.ps1` 的 ASCII-only 约束（`guard-tests.ps1` 会检查）

## 为什么有这些看起来多余的写法

每一条都对应一个真实踩过的坑，不是洁癖：

| 写法 | 原因 |
| --- | --- |
| 变量绝不用 `$home` 这类名字 | PowerShell 变量名**不区分大小写**，`$home` 就是只读自动变量 `$HOME`。赋值静默失败，`Remove-Item $home -Recurse -Force` 删掉的是整个用户目录。事故就是这么来的 |
| `Set-StrictMode -Version Latest` + `$ErrorActionPreference = 'Stop'` | 失败的赋值会中止运行，而不是静默流进下一句 |
| `.ps1` 正文**只用 ASCII** | Windows PowerShell 5.1 把无 BOM 的 `.ps1` 按系统 ANSI 码页读，中文会乱码，**被吃掉的那个字节常常正好是收尾引号**，报错位置离真正的原因很远。本目录这坑踩过两次 |
| 所有 dsh 调用走 `invoke-bounded.ps1` | `ErrorActionPreference = 'Stop'` 配原生命令的 `2>&1`，只要 dsh 往 stderr 写一行正常的 warning，整轮矩阵就在中途终止 |
| `taskkill /T /F`，不用 `$p.Kill($true)` | PS 5.1 / .NET Framework 只有 `Kill()`，没有整树重载。`try{}catch{}` 会把 MethodNotFoundException 吞掉，**超时后进程根本没被杀掉**，端口一直被占 |
| `$null = $p.Handle` 写在等待之前 | 不缓存句柄，`Start-Process -PassThru` 返回的 `Process.ExitCode` 永远是空的——退出码这一项证据等于没有 |
| 删之前查 reparse point | Windows PowerShell 的 `Remove-Item -Recurse` 会**跟进 junction**，一个指向别处的链接会被跟着删穿 |
| 端口固定且先探测占用 | 宿主默认端口 3080 会和正在运行的 app 撞；端口 0 会让证据里查不到实际用了哪个。占用时直接失败，而不是闷头起在别处 |
| 先解析 `run-one.ps1` 再运行 | 半改坏的脚本会在**第一次删除之后**才报错 |
