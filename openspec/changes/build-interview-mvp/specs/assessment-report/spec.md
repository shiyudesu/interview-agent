## ADDED Requirements

### Requirement: Evaluation uses the complete answer material
The system SHALL evaluate one main question using its immutable question snapshot and all answer material submitted for that question, including the main answer, supplements, and system-follow-up answers.

#### Scenario: Question has supplements and follow-up answers
- **WHEN** the question is evaluated
- **THEN** every accepted answer-material item is considered against the same snapshot Rubric

### Requirement: Decision-bearing evaluation is schema-constrained
The model SHALL return a validated structured result containing response classification, Rubric-item evidence references, awarded item points, missing or incorrect points, and applicable predefined follow-up goals.

#### Scenario: Valid structured evaluation
- **WHEN** model output conforms to the current evaluation Schema and domain constraints
- **THEN** the system may use it to persist evaluation facts

#### Scenario: Invalid structured evaluation
- **WHEN** model output fails Schema or Interview Engine validation
- **THEN** the system attempts at most one directed structure repair
- **AND** persists no evaluation facts if repair fails

### Requirement: Scores are calculated deterministically
The Interview Engine SHALL calculate each question score from persisted Rubric-item points, each assessed domain score from its selected question scores, and the overall score from all selected main-question scores.

#### Scenario: Complete interview is scored
- **WHEN** every selected main question has an outcome
- **THEN** each question score is an integer from 0 through 100
- **AND** each assessed domain score is the rounded average of its selected question scores
- **AND** the overall score is the rounded average of all selected main-question scores

#### Scenario: Five-question interview omits a domain
- **WHEN** a domain has no selected question
- **THEN** the report marks that domain unassessed
- **AND** does not treat it as zero

### Requirement: Zero-point outcomes preserve their reason
Skip, unknown, unresolved irrelevant, and wholly incorrect outcomes SHALL receive zero points but MUST retain distinct reason labels.

#### Scenario: User skips
- **WHEN** a question ends through the explicit skip command
- **THEN** the question receives zero points with the skipped reason

#### Scenario: User marks unknown
- **WHEN** a question ends through the explicit unknown command
- **THEN** the question receives zero points with the unknown reason

#### Scenario: Response remains irrelevant
- **WHEN** a response remains wholly unrelated after the allowed clarification
- **THEN** the question receives zero points with the irrelevant reason

#### Scenario: Relevant answer earns no Rubric points
- **WHEN** answer material is relevant but matches no Rubric item
- **THEN** the question receives zero points with the incorrect reason

### Requirement: Normal completion always produces a complete report
After all selected main questions have outcomes and the final question is frozen, the system SHALL produce a complete report with an overall score even when every question has zero points.

#### Scenario: All questions score zero
- **WHEN** a user normally completes every selected main question and every question receives zero points
- **THEN** the system generates a complete report with an overall score of zero

#### Scenario: Report generation fails
- **WHEN** all question evaluations exist but report generation fails
- **THEN** the interview remains report-pending
- **AND** preserves all evaluations
- **AND** permits report-only retry without repeating interview questions

### Requirement: Early ending produces an incomplete report
When the user ends early after at least one main question has an outcome, the system SHALL produce an incomplete report without an overall score.

#### Scenario: User ends after some questions
- **WHEN** the user confirms early ending
- **THEN** the report is marked incomplete
- **AND** contains feedback only for completed question outcomes
- **AND** contains no overall score

### Requirement: Complete reports contain required summaries
A complete report SHALL contain the overall score, each assessed domain score, unassessed-domain markers, overall explanation, strengths, incorrect or incomplete knowledge points, prioritized improvement areas, learning suggestions, and per-question feedback.

#### Scenario: Complete report is rendered
- **WHEN** a user views a completed interview report
- **THEN** every required report section is available from the immutable report snapshot

### Requirement: Per-question feedback is evidence-based
Per-question feedback SHALL include displayed question wording, answer summary, score, matched Rubric points, missing or incorrect points, score rationale, and targeted improvement suggestions tied to stored answer evidence.

#### Scenario: Partially correct answer
- **WHEN** an answer matches some but not all Rubric items
- **THEN** feedback identifies the matched evidence and the missing or incorrect points

#### Scenario: Feedback evidence is unavailable
- **WHEN** a proposed feedback claim cannot reference the question snapshot or accepted answer material
- **THEN** the system rejects that claim from the stored report

### Requirement: Zero-point questions receive tailored feedback
Every zero-point question SHALL receive feedback appropriate to its reason without fabricating answer analysis.

#### Scenario: Unknown or skipped question
- **WHEN** the zero reason is unknown or skipped
- **THEN** feedback states the assessment goal, missing knowledge points, and learning direction

#### Scenario: Irrelevant answer
- **WHEN** the zero reason is irrelevant
- **THEN** feedback explains how the answer failed to address the question

#### Scenario: Wholly incorrect answer
- **WHEN** the zero reason is incorrect
- **THEN** feedback identifies incorrect concepts and the correct learning direction

### Requirement: Reports do not reveal complete reference answers
Reports MAY present key knowledge points required to explain feedback but MUST NOT provide an internal Rubric, follow-up goal list, question-bank source, or complete memorization-ready reference answer.

#### Scenario: User views detailed feedback
- **WHEN** the report explains missing knowledge
- **THEN** it exposes only the knowledge points needed for feedback
- **AND** keeps internal assessment content private

### Requirement: Reports are immutable versioned snapshots
The system SHALL store complete and incomplete reports as versioned structured JSON with the provider, model ID, prompt version, Schema version, and relevant question versions used to produce them.

#### Scenario: Model or prompt changes later
- **WHEN** a historical report is viewed after model, prompt, Schema, or question updates
- **THEN** the original report content and recorded versions remain unchanged

### Requirement: Reports are read-only and private
The MVP SHALL allow only the owning account to view a report in the application and MUST NOT provide report regeneration, rescoring, appeal, continued interviewer chat, download, export, or public sharing.

#### Scenario: Owner views report
- **WHEN** the owner opens a stored report
- **THEN** the system renders the immutable snapshot

#### Scenario: User requests unsupported report action
- **WHEN** a user attempts to regenerate, rescore, export, share, or continue chatting from a report
- **THEN** the system does not perform the unsupported action

