## ADDED Requirements

### Requirement: The MVP question bank covers the Go backend direction
The system SHALL provide a medium-difficulty, Simplified Chinese Go backend question bank covering Go and the standard library; concurrency, runtime, and performance; HTTP, RPC, and APIs; databases and storage; caches, messaging, and distributed-system fundamentals; and testing, observability, and engineering practice.

#### Scenario: Release bank is validated
- **WHEN** the MVP question bank is prepared for release
- **THEN** it contains at least 90 active reviewed main questions
- **AND** each of the six domains contains at least 15 active questions

### Requirement: Every question is reviewed structured content
Every active main question MUST have a stable ID, content version, domain, medium difficulty, reviewed source wording, weighted Rubric, predefined follow-up goals, and knowledge explanation.

#### Scenario: Valid question is imported
- **WHEN** a question contains every required field and its Rubric weights total 100
- **THEN** the question-bank validator accepts it for import

#### Scenario: Invalid question is rejected
- **WHEN** a question is missing a required field, uses an unknown domain, has invalid weights, or duplicates an active ID and version
- **THEN** validation fails and the bank is not imported

### Requirement: Questions exclude coding tasks
The MVP question bank MUST NOT contain code-reading, code-writing, pseudocode-writing, executable programming, or automated-judging tasks.

#### Scenario: Coding task is present
- **WHEN** question-bank validation detects a prohibited coding task
- **THEN** validation fails before the question can become active

### Requirement: Users choose only the supported interview size
The system SHALL accept only 5, 10, or 15 main questions for the fixed Go backend direction and SHALL NOT allow users to choose domains, difficulty, or individual questions.

#### Scenario: Supported question count
- **WHEN** a user selects 5, 10, or 15 questions
- **THEN** the system can create a blueprint using the corresponding coverage rule

#### Scenario: Unsupported configuration
- **WHEN** a user submits another count, direction, difficulty, or domain selection
- **THEN** the system rejects the configuration

### Requirement: Blueprints satisfy domain coverage
The system SHALL create a fixed blueprint before the first main question is shown.

#### Scenario: Five-question blueprint
- **WHEN** a five-question interview is created
- **THEN** the blueprint contains five different domains
- **AND** the omitted domain is recorded as unassessed

#### Scenario: Ten-question blueprint
- **WHEN** a ten-question interview is created
- **THEN** all six domains are represented
- **AND** Go plus concurrency/runtime/performance receive increased representation

#### Scenario: Fifteen-question blueprint
- **WHEN** a fifteen-question interview is created
- **THEN** all six domains contain at least two questions

### Requirement: Selection avoids recent questions where possible
The system SHALL prefer questions not used in the user's three most recent interviews while preserving the selected coverage rule.

#### Scenario: Enough unseen questions exist
- **WHEN** enough eligible unseen questions exist for the required blueprint
- **THEN** no main question from the user's three most recent interviews is selected

#### Scenario: Avoidance would break coverage
- **WHEN** avoiding every recent question would leave too few eligible questions for the required domain coverage
- **THEN** the system may repeat recent questions before violating coverage

### Requirement: Blueprint selection is reproducible
The system SHALL persist the selection seed, ordered question IDs, and versions used to create a blueprint so retries cannot create a different interview.

#### Scenario: Blueprint creation is retried
- **WHEN** blueprint creation is repeated for the same interview after a transient failure
- **THEN** the resulting ordered question selection is unchanged

### Requirement: Interview questions are immutable snapshots
The system SHALL copy each selected question's source wording, domain, version, Rubric, follow-up goals, and knowledge explanation into the interview.

#### Scenario: Question bank changes after interview creation
- **WHEN** a source question is later edited or retired
- **THEN** the existing interview continues to use its original snapshot

### Requirement: Main-question rephrasing is surface-only
The system MAY alter word order, forms of address, and transition wording, but MUST NOT add or remove conditions or change technical terms, difficulty, assessment goals, or Rubric items.

#### Scenario: Rephrasing succeeds
- **WHEN** generated wording passes the surface-equivalence constraints
- **THEN** the system stores both the reviewed source wording and displayed wording

#### Scenario: Rephrasing fails
- **WHEN** generated wording fails validation or the model call fails
- **THEN** the system displays the reviewed source wording
- **AND** the interview remains usable

### Requirement: Internal question sources remain private
The system MUST NOT expose internal question-bank files, source references, Rubrics, follow-up goals, or complete knowledge explanations during an interview or in a report.

#### Scenario: User views an interview or report
- **WHEN** the system renders user-visible content
- **THEN** only the allowed question wording, feedback, and selected knowledge points are exposed

