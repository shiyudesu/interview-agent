# 技术栈与架构

> 状态：已确认
> 版本基线日期：2026-08-09

## 1. 架构结论

项目采用 TypeScript 模块化单体：

```text
Browser
  │ REST JSON + SSE
  ▼
Fastify
  ├── React static assets
  ├── Authentication
  ├── Interview Engine
  ├── Pi adapters
  └── PostgreSQL
```

- 前后端源码分离，但部署为一个常驻 Node.js 服务。
- PostgreSQL 是业务状态的唯一权威存储。
- Interview Engine 控制所有状态迁移，模型不能自行推进面试。
- MVP 不使用 Redis、向量数据库、消息队列、WebSocket 或 Serverless Functions。
- 生产形态为 Docker 化 Node.js 服务和托管 PostgreSQL，具体云平台与区域暂不决定。

## 2. Workspace

使用 pnpm workspace 和 Turborepo：

```text
apps/
  web/                 React SPA
  server/              Fastify、认证、Pi 和依赖装配
packages/
  domain/              面试状态机和业务规则
  contracts/           TypeBox API Schema 和 DTO
  db/                  Drizzle Schema、迁移和 Repository
question-bank/         版本化题库 YAML
```

依赖方向：

```text
apps/web ───────────────▶ contracts ──▶ domain
apps/server ────────────▶ contracts + domain + db
packages/db ────────────▶ domain
packages/domain ────────▶ no infrastructure dependencies
```

边界规则：

- `domain` 不依赖 Fastify、Drizzle、Pi、Better Auth、TypeBox 或浏览器 API。
- `contracts` 使用 TypeBox 定义传输 Schema，并与 domain 类型显式转换。
- `db` 提供 domain 所需 Repository 的 Drizzle 实现。
- `server` 负责 HTTP、认证、模型、邮件、日志和具体依赖装配。
- `web` 不得导入 `server` 或 `db`。
- Turborepo 只使用本地缓存，不配置远程缓存。

## 3. Runtime Baseline

| Component | Version |
|---|---:|
| Node.js | `24.19.0` LTS |
| pnpm | `11.20.0` |
| TypeScript | `7.0.2` |
| Turborepo | `2.10.9` |
| PostgreSQL | `18.4` |
| Mailpit | `1.30.7` |

- 项目统一使用 ESM。
- 服务端开发使用 `tsx`，生产使用 `tsc` 编译，不打单文件 bundle。
- 环境变量由 Node.js `--env-file` 加载，并在启动时通过 TypeBox 完整校验。
- 所有直接依赖使用精确版本，不使用 `^` 或 `~`。
- `pnpm-lock.yaml` 是完整传递依赖的最终基线。
- TypeScript `7.0.2` 已通过前端、服务端、数据库、测试与构建依赖的类型冒烟检查，并在 CI 中持续验证。
- 当前不启用 TypeScript `6.0.3` 回退；只有兼容性检查出现无法通过上游升级解决的阻塞时，才通过显式 OpenSpec/ADR 变更回退。

## 4. Web

| Package | Version | Purpose |
|---|---:|---|
| `react` | `19.2.8` | UI |
| `react-dom` | `19.2.8` | DOM rendering |
| `react-router-dom` | `7.18.2` | Client routing |
| `@tanstack/react-query` | `5.101.4` | Server state |
| `vite` | `8.2.1` | Development and build |
| `@vitejs/plugin-react` | `6.0.5` | React compilation |
| `tailwindcss` | `4.3.3` | Styling |
| `@tailwindcss/vite` | `4.3.3` | Tailwind Vite integration |
| `radix-ui` | `1.6.7` | Accessible UI primitives |

- 不引入 Redux、Zustand 或 MobX。
- 服务端状态使用 TanStack Query，页面临时状态使用 React 本地状态。
- 不使用 SSR；Fastify 在生产环境提供前端静态资源和 SPA fallback。

## 5. HTTP API

| Package | Version | Purpose |
|---|---:|---|
| `fastify` | `5.11.3` | HTTP server |
| `@fastify/static` | `10.1.3` | Serve built web assets |
| `@fastify/helmet` | `13.1.0` | Security response headers |
| `@fastify/rate-limit` | `11.2.0` | Endpoint rate limits |
| `@fastify/sensible` | `6.0.5` | HTTP errors and utilities |
| `@fastify/type-provider-typebox` | `6.1.0` | Typed route schemas |
| `@fastify/sse` | `0.6.0` | Streaming response events |
| `@fastify/swagger` | `9.8.1` | OpenAPI generation |
| `@fastify/swagger-ui` | `6.1.1` | Local API documentation |
| `typebox` | `1.3.7` | Runtime boundary schemas |
| `ajv-formats` | `3.0.1` | JSON Schema formats |

- API 使用 `/api/v1` REST JSON。
- 用户命令通过普通 HTTP 请求提交，Agent 增量输出使用 SSE 格式。
- SSE 断线后通过 GET 重新获取权威状态，不永久保存或回放文本 delta。
- OpenAPI JSON 和 Swagger UI 仅在本地及测试环境启用。
- Web 与 API 正式部署同源；本地由 Vite proxy 转发 API，不启用通配 CORS。
- 前端使用 `packages/contracts` 和手写的 `fetch`/SSE 客户端，不生成客户端代码。

## 6. Interview Engine

Interview Engine 位于 `packages/domain`，负责：

- 创建并冻结面试蓝图。
- 验证当前允许执行的命令。
- 控制主问题、追问和题意澄清的状态。
- 执行追问次数、题量和终态规则。
- 聚合题目分、领域分和总分。
- 保证完整报告和不完整报告的生成条件。

模型不能直接计算总分、领域分、题目顺序、追问次数或状态迁移。

所有写命令必须：

- 携带 Idempotency Key。
- 在数据库事务中检查面试场次版本号。
- 只允许一个命令推进当前状态。
- 对重复提交返回同一 Operation 结果。

## 7. Pi 与模型调用

| Package | Version | Purpose |
|---|---:|---|
| `@earendil-works/pi-agent-core` | `0.84.1` | Interviewer text turns |
| `@earendil-works/pi-ai` | `0.84.1` | Provider abstraction and controlled calls |
| `typebox` | `1.3.7` | Model and tool schemas |
| `yaml` | `2.9.0` | Question-bank source parsing |
| `opencc-js` | `1.4.1` | Context-aware Traditional-to-Simplified question wording validation |

Pi packages 必须保持相同版本并精确锁定。TypeBox、YAML 和 OpenTelemetry API 与 Pi 当前依赖版本对齐。OpenCC 精确锁定为 `1.4.1`，用于题目措辞的上下文繁简转换校验。

职责划分：

- Pi Agent Core 只生成主问题表层改写、题意澄清、追问措辞和自然衔接语。
- 回答分类、评分点判断和报告分析数据使用 `pi-ai` 受控调用。
- 决策性数据必须符合 TypeBox Schema；展示性文本可以使用普通文本。
- 结构校验失败时最多进行 1 次带具体错误的修复调用。
- 网络错误或限流最多自动重试 2 次并指数退避。
- 重试耗尽后 Operation 失败，面试状态不推进，用户可以显式重试。

安全边界：

- Pi Agent 不注册文件、Shell、网络、数据库或业务推进工具。
- 用户内容作为明确分隔的不可信数据传给模型。
- 评分调用只接收当前主问题快照和作答材料。
- 报告生成读取结构化逐题评估，不直接依赖完整自由文本聊天记录。
- 模型输出必须经过 Schema 和 Interview Engine 双重校验。
- 不保存或请求模型思维链。

模型供应商通过环境变量配置：

```text
MODEL_PROVIDER
MODEL_ID
<provider credential>
```

仓库不设置默认供应商或模型。每个运行环境只配置一个供应商和模型，不做运行时切换或自动故障转移。

## 8. Data

| Package | Version | Purpose |
|---|---:|---|
| `drizzle-orm` | `0.45.2` | Database mapping and queries |
| `drizzle-kit` | `0.31.10` | SQL migration generation |
| `pg` | `8.23.0` | PostgreSQL driver and pooling |
| `@types/pg` | `8.21.0` | PostgreSQL driver types |

- PostgreSQL 保存账户关联、面试状态、题目快照、消息、Operation、评分和报告。
- Pi 的进程内状态仅在单次操作中有效，每次按需重建上下文。
- Schema 变更生成并提交 SQL migration；生产禁止使用 schema push。
- 题库使用按知识领域拆分的版本化 YAML，并通过 TypeBox 校验后导入 PostgreSQL。
- 每道题使用稳定 ID。
- 创建面试蓝图时复制主问题、Rubric 和追问目标快照。
- 历史评分只读取场次快照，不读取后来更新的题库内容。
- 报告以版本化结构化 JSON 保存，由 Web 渲染；HTML 或 Markdown 不是权威数据。
- 题库版本、场次题目快照、最终消息、评估和报告按不可变历史记录使用；不保存向量、流式 delta 或不完整模型文本。
- 业务表到用户表使用限制删除的外键，账户删除必须先经过立即隐藏、延迟清除的项目编排；Better Auth 自身子表仍可随认证用户级联清除。
- 所有业务绝对时间使用 PostgreSQL `timestamp with time zone`；Better Auth 框架管理的时间列为保持适配器兼容继续使用 `timestamp without time zone`，项目扩展的账户删除时间除外。
- `interview_sessions` 通过仅覆盖 `active` 与 `report_pending` 的部分唯一索引限制每个用户至多一个未结束面试；终态与 `deleting` 不占用该名额。
- 面试与完整题目快照必须在同一事务写入。`(interview_id, position)` 唯一且位置为正；延迟约束触发器在提交时要求快照数量等于所选题量、最小位置为 1、最大位置为所选题量，因此任何重复、缺口或越界蓝图都不能提交。
- 面试插入后，所有者、方向、所选题量和选择种子不可修改，蓝图不能扩容或转让；状态、阶段、版本、当前位置、活动时间以及待处理 Operation/报告时间等聚合生命周期字段仍可正常更新。向既有蓝图插入超出所选题量的快照会由延迟完整性约束在提交时拒绝。
- 约束迁移会锁定面试、快照和 Operation 表，并在安装延迟触发器前验证所有既有面试的完整连续蓝图；旧数据无效时迁移整体失败。
- 场次题目快照的来源 ID/版本、面试/位置和完整题目内容创建后不可修改；仅冻结状态与评估结果等生命周期字段可更新。面试仍存在时也禁止直接删除快照，防止删除后按同一 ID/位置替换；删除面试时的外键级联不受影响。
- Operation 通过 `(owner_user_id, idempotency_scope, idempotency_key)` 唯一；同一范围和键必须保持命令类型、面试、期望版本和输入指纹一致，否则返回显式幂等冲突。Operation ID、所有者、面试、范围、键、命令类型、期望版本、输入和输入指纹创建后不可修改，面试仍存在时也禁止直接删除后重建。删除面试时的外键级联不受影响。
- `processing` Operation 必须持有租约所有者、租约 Token 哈希和有效时间范围。待处理领取使用带状态谓词的原子 `UPDATE ... RETURNING`；只有 `lease_expires_at < now` 才可显式回收，完成允许发生在到期时刻，且必须匹配当前租约。尝试次数持久化但不设数据库上限，由具体 handler 决定策略。

每次决策性模型调用记录：

- Provider。
- Model ID。
- Prompt 版本。
- Schema 版本。
- 题目版本。
- 调用用途。

## 9. Operation Execution

MVP 不运行独立任务队列，但从第一天保留持久化 Operation 边界：

```text
HTTP command
  → create or load Operation
  → OperationRunner executes
  → persist result
  → advance interview state
```

- Operation 保存幂等键、类型、状态、尝试次数和输入引用。
- Operation handler 必须可重试，但失败只在错误被持久化标记为可重试后接受显式重试；非可重试失败不会自动或静默重试。
- 成功或失败完成必须匹配当前租约所有者和 Token，且与面试状态迁移、评估或报告写入可在同一个 Repository Unit of Work 中提交。
- 浏览器断线不会主动取消服务端处理。
- 模型成功完成后才原子保存最终文本；不保存流式 delta 或不完整正式消息。
- 进程崩溃留下的处理中 Operation 可以由用户重试继续处理。
- 未来需要异步处理时，优先加入 PostgreSQL-backed queue，由 Worker 调用相同 OperationRunner。

面试过期同时使用：

- 读取或写入前的惰性超时判断。
- 服务进程内的低频 sweeper，处理长期无人访问的记录。

不增加外部调度服务。

## 10. Authentication and Email

| Package | Version | Purpose |
|---|---:|---|
| `better-auth` | `1.6.26` | GitHub OAuth, email OTP and sessions |
| `@better-auth/drizzle-adapter` | `1.6.26` | Better Auth PostgreSQL mapping |
| `nodemailer` | `8.0.11` | SMTP email delivery |
| `@types/nodemailer` | `8.0.1` | Nodemailer types |

- Better Auth 使用 PostgreSQL Session 和同源安全 Cookie。
- 支持 GitHub 登录、邮箱 OTP 和用户主动绑定另一登录方式。
- 配置 `disableImplicitLinking: true`，不按相同邮箱自动合并账户。
- 配置显式账户绑定允许不同邮箱；绑定后账户主邮箱保持不变。
- 普通 GitHub 登录遇到已有邮箱账户时返回未绑定错误，用户必须先使用原方式登录，再从账户设置发起绑定。
- 认证模块只依赖项目定义的 `EmailSender` 接口。
- 本地 `EmailSender` 使用 Nodemailer 通过 SMTP 发送到 Mailpit。
- 生产邮件供应商暂不决定。
- OAuth Token 仅按认证框架维持账户关联的最低需要保存。
- 业务表、Interview Engine 和 Pi 不得访问认证凭据。
- OTP、登录、回答提交和模型重试使用独立限流策略。
- API 使用 Origin/CSRF 检查和安全响应头。

## 11. Deletion

- 用户确认删除后，数据立即从用户侧不可访问且不能恢复。
- 删除确认时立即撤销相关登录 Session。
- 不直接调用 Better Auth 的即时硬删除流程；认证表与业务表统一进入项目的延迟清除流程。
- 内容在 7 天内由清理任务物理删除。
- 清理后仅保留不可还原的账户标识哈希、删除时间、数据类别和执行结果。
- 清理请求上的临时结果或错误诊断随该请求一起删除，不复制到长期清理审计。
- 不保留邮箱、问题、回答、评分或报告。

## 12. Observability

| Package | Version | Purpose |
|---|---:|---|
| `pino` | `10.3.1` | Structured application logs |
| `pino-pretty` | `13.1.3` | Local log formatting |
| `@opentelemetry/api` | `1.9.0` | Telemetry API aligned with Pi |
| `@opentelemetry/sdk-node` | `0.221.0` | Node telemetry SDK |
| `@opentelemetry/auto-instrumentations-node` | `0.79.0` | HTTP and database instrumentation |
| `@opentelemetry/exporter-trace-otlp-http` | `0.221.0` | Optional OTLP export |

- 日志使用结构化 JSON；本地可以使用 `pino-pretty`。
- Trace 贯穿 HTTP、数据库、Operation 和模型调用。
- 当前不绑定日志或 Trace 平台；OTLP exporter 通过配置启用。
- 日志不得记录 OTP、OAuth Token、API Key、完整用户回答或模型思维链。

## 13. Testing and Quality

| Package | Version | Purpose |
|---|---:|---|
| `vitest` | `4.1.10` | Unit and integration tests |
| `@vitest/coverage-v8` | `4.1.10` | Coverage |
| `@testing-library/react` | `16.3.2` | React component tests |
| `@testing-library/jest-dom` | `7.0.0` | DOM assertions |
| `@testing-library/user-event` | `14.6.3` | UI interaction tests |
| `jsdom` | `30.0.1` | Browser-like unit environment |
| `testcontainers` | `12.1.0` | PostgreSQL integration tests |
| `@playwright/test` | `1.62.1` | Browser E2E tests |
| `@biomejs/biome` | `2.5.7` | Formatting and linting |
| `tsx` | `4.23.11` | TypeScript development scripts |

测试分层：

- domain 状态机和评分聚合使用纯单元测试。
- Repository、事务、幂等与约束使用 Testcontainers 中的真实 PostgreSQL。
- 模型流程使用 Pi Faux Provider，不在自动测试中调用真实模型。
- React 使用 Testing Library。
- Playwright 覆盖认证替身、完整面试、恢复、报告和删除关键路径。
- 格式化与 lint 使用 Biome，类型检查使用 TypeScript。
- 已有测试套件必须发现测试文件并通过独立的测试源码 TypeScript 检查；仅尚未进入 UI 测试阶段的 `apps/web` 暂时允许空测试集。
- Testcontainers 和其他依赖数据库当前时间的测试不使用 Turborepo 缓存，测试活动时间从 PostgreSQL `statement_timestamp()` 派生，避免跨日期假绿或假红。

类型依赖：

| Package | Version |
|---|---:|
| `@types/node` | `24.13.3` |
| `@types/react` | `19.2.18` |
| `@types/react-dom` | `19.2.4` |

## 14. Local Development

应用在宿主机运行，Docker Compose 只启动：

- PostgreSQL `18.4`。
- Mailpit `1.30.7`。

仓库同时提供生产用应用 Dockerfile。

本地启动不要求真实模型凭据，但执行真实面试时必须配置 provider 和 model。自动测试统一使用 Faux Provider。

## 15. Explicit Non-Choices

MVP 明确不引入：

- Next.js、SSR 和 React Server Components。
- GraphQL 和 tRPC。
- Prisma。
- Redis、pgvector、Elasticsearch 和消息队列。
- WebSocket。
- Redux、Zustand 和 MobX。
- ESLint 和 Prettier。
- 客户端代码生成。
- 多 Agent 编排。
- 多模型运行时切换和自动故障转移。
- Turborepo 远程缓存。
