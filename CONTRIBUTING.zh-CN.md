# 为 first-tree 贡献

> 本文是 [CONTRIBUTING.md](CONTRIBUTING.md) 的中文译本。**英文版为准**：若两种语言的表述有出入，
> 以 [CONTRIBUTING.md](CONTRIBUTING.md) 以及其中链接的英文协议文本为准。本译本不定义任何独立的
> 中文专属贡献流程，所有贡献都走与英文指南相同的 PR 流程。

感谢你帮忙。本文是简明的贡献者指南；更深入的架构与按 package 的开发流程见 [AGENTS.md](AGENTS.md)。

## 仓库结构

monorepo 结构与架构规则见 [AGENTS.md](AGENTS.md)。速查：

- `apps/cli/` — 对外发布的 `first-tree` CLI。
- `packages/server/` — Fastify API 服务。
- `packages/client/` — Cloud SDK / 可观测性、Runtime，以及内置 Provider。
- `packages/web/` — React 管理后台。
- `packages/shared/` — 内部 Zod schema、类型与配置。
- `skills/` — 各 skill 的 markdown 负载。

## 本地环境

- Node.js 22.13+（推荐 24）
- pnpm 10+
- Docker（通过 `docker-compose` 起本地 PostgreSQL）

完整本地开发入口见 [DEVELOPMENT.md](DEVELOPMENT.md)，包含 `.env`、数据库迁移、服务地址与
GitHub App 配置链接。最小循环是：

```bash
pnpm install
docker compose up -d
pnpm --filter @first-tree/server dev
pnpm --filter @first-tree/web dev
```

## 提交 PR 前必须通过的检查

```bash
pnpm check         # biome lint + format
pnpm typecheck
pnpm test
```

三项都必须全绿。如果改动涉及命令面（命令、参数、帮助输出），在同一个 PR 里更新
[docs/cli-reference.md](docs/cli-reference.md)。

## 按主题的必读文档

- **HTTP 路由 / JWT / 多组织：** [docs/development/http-path-conventions.md](docs/development/http-path-conventions.md)
- **在已有生产安装旁边跑开发版 CLI：** [docs/development/local-dev-isolation.md](docs/development/local-dev-isolation.md)

## 约定

以 [AGENTS.md](AGENTS.md) 的 “Coding Conventions” 与 “Git Conventions” 两节为准。

要点：

- TypeScript：不用 `any`，非必要不用 `as` 断言，Zod 是 DTO 的唯一来源。
- GitHub 上一切用英文——代码、注释、提交信息、PR、issue、分支名、CI 日志。
- 不要手工改 Drizzle 迁移；使用 `drizzle-kit generate` / `drizzle-kit migrate`。

## PR 检查清单

- 分支名符合 `feat/* | fix/* | refactor/* | test/* | docs/* | chore/*`。
- 提交信息符合 Conventional Commits（`feat: ...`、`fix: ...`、`refactor: ...` 等）。
- 本地 `pnpm check && pnpm typecheck && pnpm test` 全绿。
- **不要**修改任何 `package.json` 里的 `version`——版本由 CI 在打 tag 时处理。
- 如果 PR 改动了命令面，同一个 PR 里更新 `docs/cli-reference.md`。

## 贡献者许可协议（CLA）

在 PR 可以被合并之前，每个以人类身份提交的作者都必须先签署贡献者许可协议。自动化 bot 账号豁免。

- **个人贡献者：** 阅读
  [Individual Contributor License Agreement (ICLA) v1.0](https://gist.githubusercontent.com/bestony/5a32ba8d5daa68b95adab6a9bba9c1cc/raw/dffb751c6fcb4c0d3b6df087e2353f149ab0e24b/icla.md)，
  然后在 PR 上发布这条**英文原文**评论（自动化按原文识别，不要翻译或改写）：
  `I have read the CLA Document and I hereby sign the CLA`
- **代表组织签署的贡献者：** 由有权签署人填妥
  [Corporate Contributor License Agreement (CCLA) v1.0](https://gist.githubusercontent.com/bestony/5a32ba8d5daa68b95adab6a9bba9c1cc/raw/dffb751c6fcb4c0d3b6df087e2353f149ab0e24b/ccla.md)
  并发送到 `legal@first-tree.ai`。基金会必须先核验该 CCLA 及其 Schedule A 中列出的 GitHub
  用户名，这些贡献者才会被视为已覆盖。

`CLA` workflow 会把 ICLA 签署元数据记录到专用分支 `cla-signatures` 上的
`signatures/version1/cla.json`。该记录包含 GitHub 用户名与稳定的账号标识、评论内容、仓库与
pull request 标识、签署时间戳，以及签署时 GitHub 公开的昵称与邮箱。该分支只是签名台账；
代码改动仍然通过针对 `main` 的 pull request 进行。

## 提交 issue

bug、功能想法和问题都欢迎。请尽量附上：

- 你使用的 CLI / server / web 版本（`first-tree --version`、Docker 镜像 tag、浏览器）。
- 尽量小的复现步骤。
- 日志或截图——如何提取结构化日志见 [docs/observability.md](docs/observability.md)。

## 安全

请勿把安全问题作为公开 issue 提交。协调披露流程见 [SECURITY.md](SECURITY.md)。
