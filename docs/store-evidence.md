# DSH STORE 生命周期证据 — 一次性 Profile 的安装 / 启动 / 卸载

本文件是 DSH STORE 上架契约第 8 条要求的证据记录：**可安装的插件必须在一次性 Profile 里完成
安装 → 配置组合 → 页面或工具可见 → 卸载回滚的验收**，单元测试不能替代。
配套的权限与失败边界声明见 [`PERMISSIONS.md`](../PERMISSIONS.md)。

声明基线：`dsh-worktree-space@1.0.5`。

---

## 1. 隔离：绝不碰日常 profile

验收必须在**一次性数据目录**里做，这样安装、启动、卸载都不会碰到用户日常的 `profiles/`：

```sh
# bash / zsh —— DSH_HOME 决定 profiles/ 的位置
export DSH_HOME="$(mktemp -d)/dsh-home"
```

```powershell
# PowerShell
$env:DSH_HOME = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-evidence-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $env:DSH_HOME | Out-Null
```

`DSH_HOME` 一旦这样设定，下面所有命令读写的都是那个临时目录；验收结束后整目录删掉即可。
（`dsh --profile <name>` 解析的就是 `$DSH_HOME/profiles/<name>`。）

## 2. 步骤与判定标准

按顺序执行，每一步的**通过标准**写在一起 —— 证据要能逐条对上，不接受「看起来没问题」。

### 2.1 安装

```sh
dsh plugin --profile evidence add dsh-worktree-space
```

- 该命令把 pnpm 参数原样转发给 profile，首次使用会初始化这个 profile。
- 通过标准：命令以 0 退出且无 `incompatible` 警告（若有版本警告，说明 `engines.dsh` 与实际宿主不符，
  应改声明而不是用 `allow-version --accept-risk` 掩盖）；`$DSH_HOME/profiles/evidence/node_modules/dsh-worktree-space/`
  存在且其 `package.json` 的 `version` 等于本次提交的版本；`$DSH_HOME/profiles/evidence/cordis.patch.yml`
  中出现插件的挂载行（`id: worktree-space` / `name: dsh-worktree-space`）。

  > 想从官方模板起步时，可用启动器的 `--from-default-profile web` 先把 `evidence` 按 web 模板初始化；
  > 具体用法以 `dsh --help` 在你所用 DSH 版本上的输出为准。

### 2.2 配置组合（启动前的静态验收）

```sh
dsh --profile evidence --dump-config
```

- 通过标准：组合出的条目树里出现 `worktree-space` 一行，且 `config` 是 profile 文档里的值；
  同时确认 `engines` 段落与实际宿主版本相符（这就是「Node.js / DSH 兼容范围已在 manifest 中声明」的验证点）。
- 这一步不挂载 UI，因此适合放进 CI；它是「配置组合」的机器可读证据，截图或日志请一并留存。

### 2.3 启动与可见性

```sh
dsh --profile evidence --no-open --port 0
```

- 通过标准：进程正常启动；在插件列表里能看到 **Worktree Space** 的名称、描述与 `icon.svg` 图标；
  能看到它自己的配置区（面板入口、侧边栏底部入口、扫描深度、最大遍历目录数、默认分支前缀、归档文档目录），
  改动立刻生效；侧边栏底部出现快捷入口，能打开管理页面；宿主 RPC 路由 `/api/dsh-worktree-space` 已注册。
- **端到端功能验收**（一次性仓库，不要用真实项目）：在临时目录里 `git init` 一个仓库 → 新建任务空间 →
  确认 `<任务空间>/<任务名>/<仓库名>` 是 worktree、任务空间已注册为工作区并开了会话 → 改一个文件 →
  「结束任务」确认分支合并、worktree 移除、文档归档到 `archived-docs/<工作区名>-<时间戳>/`。
- 留存：上面每一步的截图（插件列表、配置区、管理页面、结束任务结果）。

### 2.4 卸载与回滚

```sh
dsh plugin --profile evidence remove dsh-worktree-space
dsh --profile evidence --dump-config
```

- 通过标准：`profiles/evidence/node_modules/dsh-worktree-space/` 消失；`cordis.patch.yml` 里的挂载行被清掉；
  第二次 `--dump-config` 的条目树里不再有 `worktree-space`；启动后插件列表里不再出现该插件，侧边栏入口一并消失，
  且没有残留报错（宿主 RPC 路由注销，不留下需要手动清理的状态）。

## 3. 当前证据状态（本提交，如实记录）

| 步骤 | 状态 | 现有证据 |
| --- | --- | --- |
| 安装 | **已在本提交之前的历史版本上通过**；本提交（1.0.5）**待执行** | 作者本机的两个真实 profile 里存在安装目录：`<DSH_HOME>/profiles/web/node_modules/dsh-worktree-space/`（版本 `1.0.3`）与 `<DSH_HOME>/profiles/desktop/node_modules/dsh-worktree-space/`；`<DSH_HOME>/profiles/web/cordis.patch.yml` 里有 `id: worktree-space` / `name: dsh-worktree-space` 的挂载行 |
| 配置组合 | **待执行** | 本提交没有 `--dump-config` 的输出记录 |
| 启动与可见性 | **待执行** | 本体改动的上一版曾在 web profile 中随 DSH 启动加载；本提交未附截图 |
| 卸载回滚 | **待执行** | — |

**为什么是「待执行」而不是「已完成」**：本次修复只改动了 `package.json`、文档与打包白名单校验脚本，
没有改动 `src/`、`lib/index.js` 或 `client/client.js`，因此不需要重新构建；但**权威的一次性 Profile 验收
必须在有 shell 的机器上跑完**，本提交的编辑环境里 `pwsh` 不可用，无法执行 `dsh`、`pnpm` 或 `git` 命令，
所以这里只给出可复现的步骤与判定标准，不把「没有跑」写成「已通过」。

用第 1、2 节的命令跑完一次后，把输出与截图附在本文件下面，并把这四行状态改成「已通过（日期 + DSH 版本 +
Node 版本 + profile 名）」。**严禁在没有执行的情况下填写通过记录。**

## 4. 与自动策略的关系

DSH STORE 的八小时自动策略要求「文件 / 网络 / 命令 / 凭据信号均为空」才自动批准。本插件的功能就是文件读写
与调用 `git`，因此**永远无法**满足该条件；它对这两类信号的正确姿态是**如实声明**（见
[`PERMISSIONS.md`](../PERMISSIONS.md)），并在人工复核里给出上面这份生命周期证据。
本次修复能清掉的是另外两项可清除的判定：**Node.js 兼容性未声明**（已补 `engines.node` / `engines.dsh` /
`dsh.manifestVersion`）与**运行期依赖需要单独供应链复核**（已把三个仅构建期使用的包移入
`devDependencies`，运行期第三方依赖归零）。
