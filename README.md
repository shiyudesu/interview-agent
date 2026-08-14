# interview-agent

基于 TypeScript 模块化单体的文字模拟面试应用。Web 使用 React/Vite，Server 使用 Fastify，PostgreSQL 保存权威状态，Better Auth 提供 GitHub OAuth 与邮箱 OTP，Pi 适配器负责受约束的模型调用。

## 仓库结构

```text
apps/web          React SPA
apps/server       Fastify、Better Auth、Pi、Operation 与 SSE
packages/domain   无基础设施依赖的领域状态机和评分
packages/contracts TypeBox API、模型与配置契约
packages/db       Drizzle、PostgreSQL repository、迁移与维护任务
question-bank     版本化 Go 后端题库 YAML
```

依赖方向由 `pnpm workspace:check` 强制检查：Domain 不依赖传输、数据库、认证或模型框架，Web 只消费 Contracts。

## 环境要求

- Node.js `24.19.0`
- pnpm `11.20.0`
- Docker 与 Docker Compose
- 本地端口默认使用 PostgreSQL `5432`、Mailpit SMTP `1025`、Mailpit UI `8025`、Server `3000`、Web `5173`

仓库通过 `packageManager`、`engines` 和 `devEngines` 固定 Node/pnpm 版本。启用 Corepack 后安装依赖：

```bash
corepack enable
corepack prepare pnpm@11.20.0 --activate
pnpm install --frozen-lockfile
```

## 本地启动

1. 创建本地配置并替换两个 secret 占位值：

   ```bash
   cp .env.example .env
   ```

2. 启动干净的本地依赖并等待健康检查：

   ```bash
   pnpm services:up
   ```

3. 应用已提交的 PostgreSQL 迁移并导入发布题库：

   ```bash
   pnpm db:migrate
   pnpm question-bank:import
   ```

4. 启动 Server 与 Web：

   ```bash
   pnpm dev
   ```

常用地址：

- Web：<http://127.0.0.1:5173>
- Server：<http://127.0.0.1:3000>
- Mailpit：<http://127.0.0.1:8025>
- 本地 OpenAPI：<http://127.0.0.1:3000/documentation/>

Vite 将 `/api` 代理到 `BETTER_AUTH_URL`，并归一化代理的 Origin/Host。GitHub 登录只有在同时配置 `GITHUB_CLIENT_ID` 与 `GITHUB_CLIENT_SECRET` 后启用；邮箱 OTP 默认发送到 Mailpit。

`.env.example` 默认使用 Faux Provider，适合自动测试和不依赖真实模型的流程。执行真实模型面试必须配置一个受支持的 `MODEL_PROVIDER`、`MODEL_ID` 和对应凭据。Production 明确拒绝 Faux Provider。

停止本地服务：

```bash
pnpm services:down
```

该命令保留 PostgreSQL volume。只有明确需要丢弃全部本地数据时才运行 `docker compose down --volumes`。

## 数据库与题库

应用启动不会自动迁移或修改 Schema。常用命令：

```bash
pnpm db:check       # 检查 Drizzle Schema 与已提交迁移是否一致
pnpm db:migrate     # 应用已提交迁移
pnpm db:generate    # 仅在修改 Schema 后生成新迁移
```

生产镜像包含编译后的迁移 CLI 和迁移资产：

```bash
./node_modules/.bin/interview-agent-db-migrate
```

题库命令：

```bash
pnpm question-bank:validate
pnpm question-bank:validate:release
pnpm question-bank:import
```

Release 校验要求 90 道 active/reviewed 题目且六个领域各至少 15 道。导入在单个 PostgreSQL 事务中同步不可变版本，不会重写历史面试快照。详细规则见 [`question-bank/README.md`](question-bank/README.md)。

## 质量门禁

```bash
pnpm workspace:check
pnpm check
pnpm typecheck
pnpm compatibility:typescript
pnpm test
pnpm test:e2e
pnpm build
```

附加发布门禁：

```bash
pnpm question-bank:validate:release
pnpm model-quality:validate
pnpm scenario-coverage:validate
pnpm smoke:production
```

- `pnpm test` 包含 Domain/Contracts/Web 单元测试、真实 PostgreSQL Testcontainers 集成测试和 API 集成测试，因此需要 Docker。
- `pnpm test:e2e` 使用真实 React/Vite 浏览器应用和网络替身运行 8 条 Playwright 关键路径。
- 本机 WSL 默认使用 `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe` 并通过 CDP 连接；其他开发机使用系统 Chrome channel。可用 `PLAYWRIGHT_CHROME_PATH` 指定 Chrome。
- `pnpm model-quality:validate` 从 clean build 运行完整的八类版本化 evaluation fixture suite。
- `pnpm smoke:production` 使用动态端口创建独立的 clean PostgreSQL/Mailpit、构建生产镜像、迁移、导入题库、验证 OTP 登录和面试创建，并在结束时删除本次容器、volume、image tag 与临时文件。

CI 依次运行 workspace 边界、题库、模型 fixture、格式化、lint、类型、工具链兼容、全部测试、浏览器测试、构建和生产容器 smoke，不使用真实 OAuth、邮件或模型凭据。

## Production

构建镜像：

```bash
docker build --tag interview-agent .
```

发布顺序：

1. 为目标 PostgreSQL 运行镜像内迁移 CLI。
2. 从受审查的仓库版本运行 `pnpm question-bank:import`。
3. 使用 `.env.example` 中的必需变量启动应用镜像。

Production 只提供同源应用和 `/api`，不注册 Swagger。安全 Cookie、Origin/CSRF、Helmet、endpoint rate limit、payload limit 和可选 OTLP trace 在 Server 中统一配置。`OTEL_EXPORTER_OTLP_ENDPOINT` 是 OTLP/HTTP base URL，Server 自动使用其 `/v1/traces` 路径。

手工执行一次删除/过期维护周期：

```bash
pnpm --filter @interview-agent/db db:maintenance
```

## 技术文档

- [业务范围](docs/product.md)
- [技术栈与架构](docs/tech-stack.md)
- [领域语言](CONTEXT.md)
- [数据生命周期](docs/data-lifecycle.md)
- [模型质量门禁](docs/model-quality.md)
- [题库格式与同步](question-bank/README.md)
- [OpenSpec Scenario 覆盖清单](openspec/changes/build-interview-mvp/scenario-coverage.yaml)
- [OpenSpec 实现变更](openspec/changes/build-interview-mvp/)
