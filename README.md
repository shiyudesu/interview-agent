# interview-agent

文字模拟面试 Web 应用。

## Documents

- [业务范围](docs/product.md)
- [技术栈与架构](docs/tech-stack.md)
- [领域语言](CONTEXT.md)

## Database migrations

Set `DATABASE_URL` in the root `.env`, then generate and apply checked-in PostgreSQL
migrations with:

```bash
pnpm db:generate
pnpm db:migrate
```

Production deployments run migrations as a separate release step; application startup never
pushes or migrates the schema. The production image includes the compiled migration runner and
checked-in migration assets, so an operator can run:

```bash
./node_modules/.bin/interview-agent-db-migrate
```

## Question bank

Validate repository YAML without a release-size requirement, then atomically synchronize it into
the migrated PostgreSQL database:

```bash
pnpm question-bank:validate
DATABASE_URL=postgresql://... pnpm question-bank:import
```

An empty development bank is valid and imports as a no-op. Source removal does not retire
persisted questions; add a newer inactive version as an explicit tombstone. See
[`question-bank/README.md`](question-bank/README.md) for version and activation rules.
