# 验收脚本 — 生命周期矩阵的机器可读证据

`docs/store-evidence.md` 第 5 节那张矩阵，就是这套脚本跑出来的。它存在仓库里，是为了让**下一次
换声明窗口时能重跑**，而不是把结论抄一遍就作废。

> ⚠️ **这些脚本会递归删除文件。** 动手改之前先读完本文件，尤其是「删除范围」那一节。
> 本插件的验收脚本曾因一个变量名把整个用户目录删掉，过程见 `docs/store-evidence.md` 第 1 节。

## 怎么跑

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

## 前提条件

| # | 需要什么 | 不满足会怎样 |
| --- | --- | --- |
| 1 | **Windows + PowerShell**。用到 `Get-NetTCPConnection`、`Get-CimInstance Win32_Process`、`taskkill /T /F`、`Start-Process`、`.bin\dsh.cmd` | macOS / Linux 上**完全跑不了**，没有降级路径。PowerShell 5.1 与 7 都可 |
| 2 | **`node`、`npm.cmd`、`pnpm` 在 PATH 上**。DSH 要求 node >= 22.19.0 | `install-tarball.ps1` 或安装步骤直接找不到命令 |
| 3 | **能访问 npm registry** | `install-hosts.ps1` 装不上任何 DSH 版本 |
| 4 | **约 2 GB 空闲磁盘**（默认在 `%TEMP%` 下）。四个版本装完是 1.8 GB / 10.6 万文件，约 3 分钟 | 装到一半磁盘满 |
| 5 | **端口 34800 起连续可用**（默认四个版本用 34800–34803） | 占用时**直接失败并报出端口号**，不会闷头换一个——因为证据里必须写明实际端口 |
| 6 | **执行策略允许运行**。用 `pnpm acceptance:*` 入口会自动带 `-ExecutionPolicy Bypass`；直接 `.\run-all.ps1` 可能被拦 | 被拦时改用 npm script 入口 |

**不需要**的：

- 不需要 `pnpm install`。`pnpm pack` 只读 `package.json` 的 `files` 字段，在没有 `node_modules` 的干净克隆上就能打包
- 不需要 git。脚本只按 `$PSScriptRoot\..\..` 找 `package.json`，任何一份仓库副本都能跑
- 不需要预先装 DSH。`install-hosts.ps1` 装的就是矩阵要用的那些

**建议**：默认根落在 `%TEMP%`，而 `%TEMP%` 正是本项目事故里被整个删掉过的目录。守卫保证脚本自己只删
`<RunRoot>\homes` 和 `<RunRoot>\logs`，但把一次性产物放在一个会被系统或人工定期清理的地方仍然不是好主意。
正式跑之前显式指定一个自己的目录：

```powershell
.\scripts\acceptance\run-all.ps1 -RunRoot D:\dsh-acceptance\run -HostsRoot D:\dsh-acceptance\hosts
```

## 已知的脆弱点

`run-one.ps1` 按固定路径找 DSH 的入口 `<HostsRoot>\<版本>\node_modules\@deepseek-ai\dsh\lib\bin.js`。
这是 DSH 包**内部**的布局，不是它的公开接口。四个 0.1.7–0.2.0 的版本上它都成立，但 DSH 一旦调整
bin 位置，脚本会以 `missing DSH at ...` 失败——这是刻意的：宁可明确报错，也不要静默换一条来路不明的入口。

## 删除范围

`run-one.ps1` 是唯一会删东西的脚本，它只能删两类路径：

| 路径 | 约束 |
| --- | --- |
| `<RunRoot>\homes\home-<版本号>` | `<RunRoot>\homes` 的**直接**子目录，名字精确匹配，整条路径上**没有 reparse point** |
| `<RunRoot>\logs\log-<版本号>` | 同上，根换成 `<RunRoot>\logs` |

其余一切——DSH 安装、tarball、`<RunRoot>` 本身、用户目录、盘根——在这个脚本里**结构上删不掉**：
`Assert-Under` / `Assert-DirectChild` 会在 `Remove-Item` 之前把它们逐个拒掉。
`install-hosts.ps1` 与 `run-all.ps1` 里**一条 `Remove-Item` 都没有**（`install-tarball.ps1` 只删它自己
刚打出的那个 tarball）。

`guard-tests.ps1` 用 PowerShell 的 AST 从 `run-one.ps1` 里**把守卫函数抠出来跑**，不是抄一份——
抄的版本会和真实代码漂移，而只存在于测试里的守卫证明不了任何事。改名或删除守卫函数，这个测试会直接失败。

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

## 可见性探测的三个前提

第 4 阶段判定「插件可见」时，这三点缺一个就会看到像插件坏了的假象：

1. **必须带会话 cookie。** 启动 url 里的 token 在首次访问首页时换成 `dsh-auth-*` cookie。不带它，
   `POST /api/...` 一律 405、`GET /api/...` 一律 404——连宿主自己确定存在的路由也一样。那是鉴权在前，
   不是路由缺失。
2. **信封里的 `method` 是 `/api/` 之后的整段**，即 `dsh-worktree-space/task.preference`，
   只写 `task.preference` 会被判 `RPC method does not match endpoint.`。
3. **bundle 地址是页面相对的**：`plugins/??dsh-worktree-space/client.js&rev=<rev>`。
   路径多一个斜杠会落到 SPA 兜底页——**返回 200、`text/html`、字节数和首页一模一样**，看着完全正常。

## 改这些脚本时请保留

- `run-one.ps1` 头部注释里的六条安全契约
- `run-one.ps1` 里全部五个守卫函数，以及 `guard-tests.ps1` 对它们的提取
- `run-all.ps1` 的「先解析后运行」检查
- 所有 `.ps1` 的 ASCII-only 约束（`guard-tests.ps1` 会检查）

`guard-tests.ps1` 跑完会打印 `GUARD-OK` 或 `GUARD-FAIL`，**无论哪种都不删任何东西**——
它只调用守卫，看它们拒不拒。