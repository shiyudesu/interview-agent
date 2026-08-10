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
