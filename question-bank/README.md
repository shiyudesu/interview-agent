# Question bank source

Repository question sources use YAML schema version `1.0`. Store `.yaml` or `.yml` files
under the matching domain directory:

- `go_language/`
- `concurrency_runtime_performance/`
- `http_rpc_api/`
- `database_storage/`
- `cache_messaging_distributed/`
- `testing_observability_engineering/`

Development validation permits an empty bank and does not enforce release counts:

```sh
pnpm question-bank:validate
```

The 90-question, 15-per-domain release gate belongs to OpenSpec task 4.12 and will use a
separate release command.

## Format

Each file contains one YAML document and one declared domain. Every question repeats that
domain so moves and accidental cross-domain placement are detectable.

```yaml
schemaVersion: "1.0"
domain: go_language
questions:
  - id: go.context.cancellation
    contentVersion: 1
    domain: go_language
    difficulty: medium
    questionType: conceptual
    sourceWording: "请解释 context.Context 如何在调用链中传播取消信号。"
    rubric:
      - id: cancellation-propagation
        description: "说明取消信号沿派生 Context 传播"
        weight: 60
      - id: resource-release
        description: "说明接收方应观察 Done 并及时释放资源"
        weight: 40
    followUpGoals:
      - id: clarify-propagation
        kind: clarification
        goal: "澄清取消信号影响的调用链范围"
      - id: deepen-cleanup
        kind: depth
        goal: "说明 goroutine 如何响应取消并退出"
    knowledgeExplanation: "Context 通过 Done 通道传播取消，调用方和被调用方共同负责及时停止工作。"
    active: true
    reviewed: true
    reviewMetadata:
      reviewedBy: reviewer-id
      reviewedAt: "2026-08-10T00:00:00Z"
      simplifiedChineseVerified: true
      technicalTermsVerified: true
```

`questionType` is limited to `conceptual`, `scenario`, `design`, or `troubleshooting`.
Questions must not ask candidates to read, write, complete, execute, or submit code or
pseudocode, and must not define automated-judge tasks. Technical names such as `Context`,
`goroutine`, HTTP, SQL, and RPC should remain unchanged in reviewed Simplified Chinese wording.

Rubric item IDs and follow-up goal IDs are unique within a question. Rubric weights are positive
integers totaling 100, and every question has at least one `clarification` goal. An active
question must be reviewed. Reviewed questions require the complete verification metadata shown
above; unreviewed inactive drafts use `reviewMetadata: null`.

The validator rejects unknown fields, duplicate YAML keys, aliases/anchors, explicit YAML tags,
multiple documents, oversized or deeply nested structures, unsupported schema versions,
duplicate question ID/content-version pairs across files, blank content, domain mismatches, and
obvious coding-task markers.

For resource safety, each domain file is limited to 1,000,000 UTF-8 bytes, 5,000 lines, 50,000
lexer tokens, 5,000 collection entries, nesting depth 24, 10,000 parsed nodes, and 100,000
characters per scalar. The validator stats and reads at most the byte limit plus one byte before
running a bounded YAML lexer pre-scan; only files that pass those checks reach AST parsing.

Rubrics, follow-up goals, knowledge explanations, review metadata, and repository source details
are internal assessment data. Public API response schemas must not expose them.
