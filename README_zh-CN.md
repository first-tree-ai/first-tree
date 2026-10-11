# First-Tree

<p align="center">
  <a href="README.md">English</a> | 中文
</p>
<p align="center">
  <a href="https://first-tree.ai/?utm_source=github&utm_medium=readme&utm_campaign=nav-app"><strong>打开应用</strong></a> ·
  <a href="#开始使用"><strong>开始使用</strong></a> ·
  <a href="#它如何工作"><strong>它如何工作</strong></a> ·
  <a href="docs/quickstart.md"><strong>快速开始</strong></a> ·
  <a href="docs/onboarding-guide.md"><strong>文档</strong></a> ·
  <a href="CONTRIBUTING.md"><strong>贡献指南</strong></a> ·
  <a href="https://github.com/agent-team-foundation/first-tree/discussions"><strong>讨论区</strong></a>
</p>
<p align="center">
  中文说明用于帮助中文用户快速了解项目；GitHub 协作、实现细节和最新入口以<a href="README.md">英文 README</a>为准。
</p>

**让 Agent 带着团队上下文工作。**

First Tree 是一个开源工作空间，让 AI Agent 基于团队共享上下文工作，而不是
每次都从零解释背景。

核心是 Context Tree：一套由团队维护的记忆系统，记录决策、归属、代码仓库、
职责、约束和过往工作。Agent 在工作前读取它；工作完成后，有价值的结果可以
回到其中。

这样形成了一种人和 Agent 的工作循环：每个任务都能带着更多团队上下文开始，
每个有价值的结果都能让下一次任务更理解团队。

<p align="center">
  <img src="assets/workspace-screenshot.png" alt="First Tree 工作空间：Agent 汇报 GitHub issue 进展，团队上下文与参与者在侧边栏一览无余" width="100%">
</p>

<p align="center">
  <sub><b>工作循环的实际样子。</b>Agent 汇报它为一个 GitHub issue 做完了什么 &mdash;&mdash;
  与此同时，关联的 issue、团队的历史对话、以及每一个参与其中的人和 Agent 都保持可见，
  让下一个任务能从同样的共享上下文出发。</sub>
</p>

## 为什么是 First Tree

现在做 AI Agent 工作空间的产品很多。First Tree 的不同在于：它不是只提供一个
“让 Agent 干活”的地方，而是提供一个让 Agent 工作持续积累团队上下文的地方。
每一次工作都会读取已有上下文，并把新的决策、产物和经验沉淀回去，让下一次工作
更理解团队。

```text
用户意图 -> 读取团队上下文 -> 带上下文的 Agent 工作
-> 人的审核/控制 -> 可沉淀产出 -> 自动更新团队上下文
```

这个工作循环解决的是团队使用 Agent 时最容易断掉的部分：

- 上下文留在某个人的终端、提示词或笔记里
- Agent 看不到团队记忆，反复重复旧决策
- 工作结束在对话、PR 或文档里，但不会更新共享上下文
- 人被拉进来决策时，看不到足够背景
- 每个新的 Agent 任务都像从零开始，即使团队已经学到过东西

First Tree 基于一个不同判断构建：

> Agent 工作应该基于团队上下文执行，执行过程可见，在正确时刻接受人的
> 审核/控制，并形成可沉淀产出，再在重要时更新团队记忆。

这让 First Tree 能支持两种使用方式：

- **聚焦 Copilot 工作** - 在一个持续工作流里和 Agent 深度协作，用于
  设计、写代码、写文档、研究或复杂问题拆解。
- **并行审核工作** - 让 Agent 同时推进多个任务，只在需要决策、处理阻塞、批准
  或审核时把人带入流程。

在这两种模式里，First Tree 都给团队一个地方，用来：

- 让 Agent 读取团队共同维护的 Context Tree
- 在持久对话中开始和继续 Agent 工作
- 看见进行中的工作、阻塞状态和需要人审核的节点
- 查看某个请求背后的过程、产物和依据
- 把有价值的结果变成更新后的团队上下文

它不是另一个 Agent，也不只是另一个工作空间。它是人和 Agent 团队的上下文循环。

## 它如何工作

First Tree 围绕 Context Tree 连接五个部分：

1. **Context Tree** — 基于 Git 的团队记忆层，用于沉淀决策、归属、职责、
   约束和共享上下文。
2. **Web 工作空间** — 日常工作表面，用于对话、Agent、团队成员、电脑、GitHub
   和基于上下文的工作。
3. **CLI + daemon** — 把电脑登入 First Tree，并让本地 Agent 持续在线。
4. **Agent 运行时** — 在你的机器上运行 Agent，并通过 First Tree 路由消息。
5. **GitHub 集成** — 把代码工作、PR 和审核连接回工作空间。

这些部分共同保证 Agent 工作在执行前、执行中、执行后都和团队上下文连接在一起。

## 开始使用

打开 <https://first-tree.ai> 或你自己的部署登录。引导式流程会带你完成首次
使用：给团队命名、连接一台电脑、创建第一个 Agent、开始工作。

完整步骤见[快速开始指南](docs/quickstart.md)。

走到“连接一台电脑”这步时，引导流程会给出与发布通道匹配的 CLI 安装和登录
命令。托管生产环境使用：

```bash
curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh
~/.local/bin/first-tree login <connect-code>
```

请以 Web 控制台显示的命令为准，尤其是在使用 staging 或自托管部署时。
macOS/Linux 安装脚本已内置 Node.js，无需另行安装。为保持易读，这两行命令
相互独立，不提供 shell 级事务保护：整段粘贴时，安装行失败不会自动阻止登录
行运行，POSIX `sh` 也不保证 `curl | sh` 保留 `curl` 的失败状态。登录命令
显式使用 `~/.local/bin`，因此即使当前 shell 尚未刷新 `PATH` 也能立即执行。

## CLI

```text
first-tree
├── login <code>           把当前机器登入服务端
├── logout                  停止 daemon 并清除凭证
├── status                  CLI / daemon / 服务端 / auth 一屏概览
├── doctor                  跨子系统就绪检查
├── upgrade                 升级到最新发布版本
├── agent ...               Agent 管理
├── chat ...                对话与消息
├── org ...                 组织级操作
├── daemon ...              后台 daemon 生命周期
├── config ...              查看 / 修改本机 client.yaml
└── tree ...                Context Tree 接入、校验、自动化
```

每个命名空间跑 `first-tree <namespace> --help` 看完整子命令。

## 仓库结构

- `apps/cli/` — 发布的 CLI 包（`first-tree` / `ft`）
- `packages/shared/` — Zod schema、类型、配置系统（`@first-tree/shared`）
- `packages/server/` — Fastify API 服务（`@first-tree/server`）
- `packages/client/` — Cloud SDK/observability、Runtime 与内置 Providers（`@first-tree/client`）
- `packages/web/` — React Web 工作空间（`@first-tree/web`）
- `skills/` — First Tree Agent 使用的仓库内技能内容

## 文档

- [Quickstart](docs/quickstart.md) — 从注册到第一次 Agent 工作
- [Onboarding Guide](docs/onboarding-guide.md) — CLI 流程、SDK、故障排查
- [CLI Reference](docs/cli-reference.md) — 所有命令和环境变量
- [Observability](docs/observability.md) — 日志与 OpenTelemetry traces
- [docs/development/](docs/development/) — 贡献者参考
- [docs/troubleshooting/](docs/troubleshooting/) — 环境相关问题排查
- [docs/migration/](docs/migration/) — 从 `first-tree@0.4.x` 升级

## 开发

```bash
pnpm install                                # 安装依赖
docker compose up -d                        # 启动开发用 PostgreSQL
pnpm --filter @first-tree/server dev        # 服务端
pnpm --filter @first-tree/web dev           # Web 工作空间
pnpm check && pnpm typecheck                # Lint + 类型检查
pnpm test                                   # 运行测试
pnpm coverage                               # 本地单测覆盖率
pnpm coverage:summary                       # 汇总覆盖率报告
```

架构、约定、按 package 的开发流程详见 [AGENTS.md](AGENTS.md)。PR 流程详见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[Apache 2.0](LICENSE)

