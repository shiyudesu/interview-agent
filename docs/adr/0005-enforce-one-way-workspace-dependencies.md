# Enforce one-way workspace dependencies

The monorepo will keep the interview domain independent from Fastify, Drizzle, Pi, and browser code, with contracts and database adapters depending inward on domain types. This requires explicit boundary mapping but prevents infrastructure from becoming part of the interview rules and allows the same operation handlers to move to a worker later.
