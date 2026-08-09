# Use PostgreSQL as authoritative state

PostgreSQL is the source of truth for interview state, question snapshots, messages, scores, and reports; Pi Agent state is reconstructed for each request and remains ephemeral. The MVP will not add Redis or vector search because durable recovery and deterministic selection from the structured question bank are fully served by PostgreSQL.
