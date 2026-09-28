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
  存在且其 `package.json` 的 `version` 等于本次提交的版本；profile 的 `package.json` 把它写进
  `dsh.profile.bundles`。**注意**：`cordis.patch.yml` 不会因此多出挂载行——`dsh plugin add` 只做 pnpm
  安装并登记 bundle，`- id: worktree-space` 那一行是之后在插件页里改过设置（或从插件市场启用）时由插件
  管理器写下的；本机日常 web profile 里那一行连同它的 `config` 就是这样来的。

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
- **profile 必须带上 Web 应用的 bundle 层**：`dsh plugin` 初始化出来的空 profile 里没有
  `@deepseek-ai/dsh-web-app`，插件会停在 `pending (waiting for service: connection)`，宿主打印
  `warning: 1 entry did not activate`——这不是插件的问题，用 `dsh evidence --from-default-profile web`
  从官方 web 模板建 profile 即可。
- 「RPC 路由已注册」的机器可读验法：这些路由是 `POST /api/dsh-worktree-space/<endpoint>`（endpoint
  见 `src/host/index.js` 的 `ENDPOINTS`），带会话 cookie 请求 `task.preference` 得 200 与
  `{"ok":true,"value":{…}}`，随便编一个 endpoint 得 404。客户端 bundle 的地址在启动数据里
  （`plugins/??dsh-worktree-space/client.js&rev=<rev>`），取回应得 200，字节数等于 `client/client.js`
  加上宿主加载器补的那层包装。
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

## 3. 验收记录（2026-09-28，一次性 profile `evidence`）

环境：Windows、Node.js `v24.18.0`、DSH `0.1.7-rc.2`；被测包是 `npm pack` 出来的
`dsh-worktree-space-1.0.5.tgz`（303232 字节，与 `pnpm check:package` 校验的 18 个文件同源）。`DSH_HOME`
全程指向临时目录，没有碰日常 `profiles/`。

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 安装 | **已通过** | `dsh plugin --profile evidence add <tarball>` 退出 0，输出 `+ dsh-worktree-space 1.0.5`；`incompatible` 一次都没出现；profile 的 `package.json` 增加该依赖并把它写进 `dsh.profile.bundles`；装出来的 `package.json` 是 `version 1.0.5`、`engines={"node":">=22.19.0","dsh":">=0.1.7-rc.1"}` |
| 配置组合 | **已通过** | `dsh --profile evidence --dump-config` 退出 0（1249 行），组合树末尾出现 `# == dsh-worktree-space` / `- id: worktree-space` / `name: dsh-worktree-space` |
| 启动与可见性 | **已通过** | 启动无警告（没有 `did not activate`）；启动数据里出现客户端条目 `{"id":"dsh-worktree-space","url":"plugins/??dsh-worktree-space/client.js&rev=1ea18b4cf4b3",…}`；该 bundle 取回 **200、203853 字节**（本地 `client/client.js` 203777 字节，外加宿主加载器补的 76 字节包装与 `sourceMappingURL`）；宿主 RPC 已注册并作答：`POST /api/dsh-worktree-space/task.preference` → 200 `{"ok":true,"value":{"defaultBranchPrefix":"task/","archiveDocumentsDirectory":""}}`，未知 endpoint → 404 |
| 卸载回滚 | **已通过** | `dsh plugin --profile evidence remove dsh-worktree-space` 退出 0，输出 `- dsh-worktree-space 1.0.5`；`profiles/evidence/node_modules/dsh-worktree-space/` 消失；`package.json` 的依赖与 `bundles` 里都不再有它；`--dump-config` 里 `worktree-space` 出现 **0** 次（1246 行）；再启动一次无报错，页面里 `dsh-worktree-space` 出现 **0** 次 |

### 3.1 端到端功能验收（一次性仓库）

同一个一次性 profile 里，用插件自己的 RPC 走完了创建 → 计划 → 结束：

1. `task.create`（源根下只有一个 `repo-alpha`）→ 建出 `<tasksRoot>/evidence/repo-alpha`（worktree，分支
   `task/evidence`）与 `worktree-space.json` / `worktree-space.md`。把 tasks root 指到源根**里面**时被
   拒绝：`tasks root is inside the source root: … work and source must be isolated`（隔离规则有效）。
2. 在 worktree 里改一个文件并提交 → `task.plan` 报 `mergeTarget: "main"`、`commits: 1`、
   `changedFiles: 0`。
3. `task.done`（`merge: true, deleteBranch: true`）→ `merged: true, removed: true, branchDeleted: true,
   containerRemoved: true, failed: false, warnings: []`。
4. 源仓库结果：`2b2952d Merge branch 'task/evidence'`（`--no-ff`），`feature.txt` 已出现在 main 检出里，
   分支只剩 `main`，`git worktree list` 只剩主检出；任务目录已删除（`tasksRoot` 本身保留，因为它是用户
   指定的根，插件只删自己建的那一层）。

跑完后一次性 profile 与临时仓库都已删除，`remove` 之后 profile 回到 `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app` 两个 bundle。

### 3.2 两点如实说明

- **GUI 截图未附**：headless Chrome 面对开着长连接的 GUI 不会自行退出（跑满两分钟仍不返回），所以这一轮
  的可见性证据是上面那些机器可读输出（启动数据里的客户端条目、bundle 的实际字节数、RPC 的实际回答），
  **不是**插件列表与配置区的截图。截图请在带图形界面的机器上按 2.3 节补一次。
- **pnpm 的 peer 警告**：`add` 的输出里有 `[WARN] Issues with peer dependencies found`。这是 peer 依赖的
  常规提示（`@deepseek-ai/cordis` 等由 DSH profile 提供），**不是**版本不兼容警告；`incompatible` 一次
  都没有出现。

## 4. 与自动策略的关系

DSH STORE 的八小时自动策略要求「文件 / 网络 / 命令 / 凭据信号均为空」才自动批准。本插件的功能就是文件读写
与调用 `git`，因此**永远无法**满足该条件；它对这两类信号的正确姿态是**如实声明**（见
[`PERMISSIONS.md`](../PERMISSIONS.md)），并在人工复核里给出上面这份生命周期证据。
本次修复能清掉的是另外两项可清除的判定：**Node.js 兼容性未声明**（已补 `engines.node` / `engines.dsh` /
`dsh.manifestVersion`）与**运行期依赖需要单独供应链复核**（已把三个仅构建期使用的包移入
`devDependencies`，运行期第三方依赖归零）。
