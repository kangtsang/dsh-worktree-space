# 容器里的验收实例

把这个分支的插件装进一个 **Linux 容器里的 DSH 网页版**，给人点着验收。它是
`scripts/acceptance/` 那套（宿主侧、PowerShell、装多个 DSH 版本跑矩阵）之外的**另一条**
路：那条验的是安装/启动/回滚，这条是给人一个能点开的页面。

```bash
cd docker/acceptance
docker compose up -d --build
docker logs -f dsh-wts-acceptance        # 等到 URL= 那一行
```

`URL=` 那一行就是要开的地址（里面带 token，首次访问会换成 cookie）。同一份内容也写在
容器里的 `/dsh/acceptance.env`：

```bash
docker exec dsh-wts-acceptance cat /dsh/acceptance.env
```

**要点：**

- 插件 tarball 必须先放进这个目录（构建上下文），文件名和 `Dockerfile` 里 COPY 的一行一致：
  `npm pack --pack-destination docker/acceptance`。
- 装插件走的是 `dsh plugin --profile accept add <tarball>`，不是 `pnpm add`：DSH 只加载
  profile 的 `dsh.profile.bundles` 里列的东西，`pnpm add` 只把包放进 node_modules，profile
  起来时**不带插件**，于是每个用例都看起来像功能坏了。
- 绑 `0.0.0.0` 走 profile 的 patch 层（`--patch`），**不走 `--host`**：DSH 0.2.0-rc.2 的 web app
  在 flag 上直接拒绝 `--host 0.0.0.0`（`dsh-web-app/lib/startup.js`：「intentionally not supported
  yet for safety…use 127.0.0.1 instead」），而容器里只听 loopback 的进程在 `-p` 之外够不着。
  `webserver` 这一行自己的 config schema 允许的就是 `127.0.0.1` 或 `0.0.0.0`
  （`dsh-host-webserver`），所以 entrypoint 写一份 `/dsh/acceptance-host.yml` 用 `--patch` 覆盖。
  注意该行 config 是**整体替换、不深合并**，所以 `port` 必须一起写，否则整行校验失败。
- `--trusted-host localhost:<port>`：不声明授权域名，`/api` 的浏览器信任闸门会拒绝来自 `localhost`
  的调用。
- **发布端口只绑宿主 loopback**（compose 里的 `127.0.0.1:34822:34822`，不是 `34822:34822`）。
  容器里必须绑 `0.0.0.0` 才能被 `-p` 够到，而 DSH 拒绝暴露这个面的理由（web UI 会执行代码）
  在容器外同样成立——所以这一行是那条安全承诺的落点，不要放宽。
- 两个具名卷（`dsh-home`、`dsh-workspace`）让重启只需几秒：profile 已种好、插件已装、源根还在。
  要回到干净状态就 `docker compose down -v`。

## 源根与任务空间落在哪

| | |
| --- | --- |
| 源根 | `/workspace/source`，里面是 `repo-a`、`repo-b` 两个真 git 仓库（已 init + 一次提交） |
| 容器根 | `/workspace/worktree-space`（插件从源根推导，见 `reason.js`/`paths.js` 的规则） |
| 任务空间 | `/workspace/worktree-space/source/<任务>/`（项目层 = 源根目录名 = `source`） |
| 工作区登记 | `/dsh/storages/workspace.json` |

## 用例

| # | 验什么 | 怎么点 | 期望 |
| --- | --- | --- | --- |
| C1 | 面板创建会注册成 DSH 工作区（对照：旧行为） | 左侧「New Worktree Space」→ 选 `/workspace/source` → 任务名 `accept-panel` → 建 | 工作区列表出现它；`workspace.json` 的 `global.workspaceIds` 多一条 |
| C2 | **agent 侧 create 也注册**（本次修复的核心） | 新会话里让 agent 用 `task_worktree_space` 建 `accept-agent` | 工具返回的 `warnings` **为空**；工作区列表出现它；`workspace.json` 新增条目；`/workspace/worktree-space/source/accept-agent/` 下有 worktree |
| C3 | **done 会注销登记**（本次修复） | 在 C2 的任务空间上按「结束任务」，让容器被删 | 任务空间目录消失、工作区列表里那条也消失、`workspace.json` 少一条 |
| C4 | **中文提示**（本次修复） | 手工 `rm` 掉某任务空间的 `worktree-space.json`，再对它按「结束任务」；另建一个任务空间、`rm -rf` 掉里面的 worktree 目录（保留记录）再按「结束任务」 | 前者中文 E2005、后者中文 E2004，且都点名路径 |

## 容器里**看不到**的两条（Linux 上本来就不成立）

| # | 为什么 |
| --- | --- |
| C5 | 归档遇链接的拒收：Linux 上普通用户**可以**建符号链接，探针判定「本机允许建链接」，于是照旧归档成功——这条修复在 Linux 上是 no-op，因为 bug 本身不存在 |
| C6 | 结束前的占用检查（E5011）：Linux 上打开的文件既不挡改名也不挡删除，探针不会命中 |

这两条要在 Windows 上验（本机实测过：持有句柄时改名报 EPERM、删除报 being used；
`mklink` 报没有权限）。容器验收覆盖的是跨平台那一半。
