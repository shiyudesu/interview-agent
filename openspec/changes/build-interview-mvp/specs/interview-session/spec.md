## ADDED Requirements

### Requirement: An interview starts from a frozen blueprint
The system SHALL create an interview from the authenticated user's selected question count and SHALL freeze the complete ordered blueprint before displaying the first main question.

#### Scenario: Interview starts successfully
- **WHEN** an eligible user creates an interview with 5, 10, or 15 questions
- **THEN** the system persists the complete blueprint
- **AND** displays only the first main question

### Requirement: Progress reveals only question position
During an active interview, the system SHALL display the current main-question number and total main-question count. It MUST NOT display the current domain, score, remaining follow-up allowance, Rubric, or reference answer.

#### Scenario: User views active interview
- **WHEN** an interview is awaiting a response
- **THEN** the user sees question progress without hidden assessment metadata

### Requirement: Users can submit explicit response commands
The system SHALL support separate commands for submitting an answer, supplementing the current answer material, marking the question unknown, skipping the question, and requesting clarification.

#### Scenario: Submit non-empty answer
- **WHEN** the user submits non-empty answer text for the current prompt
- **THEN** the system records it as answer material and begins analysis

#### Scenario: Submit empty answer
- **WHEN** the user submits empty or whitespace-only answer text
- **THEN** the system rejects the command without changing interview state

#### Scenario: Mark unknown
- **WHEN** the user explicitly marks the current main question as unknown
- **THEN** the system records an unknown outcome with zero points and does not ask a system follow-up

#### Scenario: Skip question
- **WHEN** the user explicitly skips the current main question
- **THEN** the system records a skipped outcome with zero points and does not ask a system follow-up

### Requirement: Question clarification does not reveal answers
The user SHALL be able to request clarification of the current prompt. Clarification MUST only rephrase the prompt or state its boundary and MUST NOT reveal hints, Rubric items, expected points, or answer content.

#### Scenario: User requests clarification
- **WHEN** the user requests clarification while a response is expected
- **THEN** the system returns clarification text
- **AND** leaves the interview awaiting a response
- **AND** does not consume a system follow-up allowance or change scoring

### Requirement: System follow-ups are bounded and goal-constrained
The system SHALL ask at most two system follow-ups for one main question: at most one clarification probe and at most one depth probe. Every follow-up MUST target a predefined goal from the question snapshot.

#### Scenario: Incomplete answer needs clarification probe
- **WHEN** validated analysis finds an incomplete or ambiguous answer and an unused clarification goal applies
- **THEN** the system may ask one clarification probe

#### Scenario: Answer supports depth probe
- **WHEN** validated analysis finds an applicable unused depth goal
- **THEN** the system may ask one depth probe

#### Scenario: Follow-up limit is reached
- **WHEN** both permitted system follow-ups have been used
- **THEN** the system finalizes assessment without another system follow-up

#### Scenario: Answer is already sufficient
- **WHEN** validated analysis finds the answer sufficiently addresses the Rubric
- **THEN** the system does not ask an unnecessary system follow-up

### Requirement: Irrelevant responses receive one clarification opportunity
When answer text is wholly unrelated to the current prompt, the system SHALL issue at most one clarification opportunity. If the next response remains wholly unrelated, the question SHALL receive an irrelevant zero-point outcome.

#### Scenario: First irrelevant response
- **WHEN** validated analysis classifies the answer as wholly unrelated and no irrelevant-response clarification has been used
- **THEN** the system asks the user to answer the current question

#### Scenario: Response remains irrelevant
- **WHEN** the next response remains wholly unrelated
- **THEN** the system records an irrelevant zero-point outcome and does not continue probing

### Requirement: Users have an explicit supplement window
After the current main question has been assessed and no further system follow-up is required, the system SHALL keep that question selected until the user explicitly continues.

#### Scenario: User supplements before continuing
- **WHEN** the interview is awaiting continuation and the user submits a supplement
- **THEN** the supplement is added to the current question's answer material
- **AND** the current question is reassessed before continuation

#### Scenario: User continues
- **WHEN** the interview is awaiting continuation and the user chooses to continue
- **THEN** the current question becomes frozen
- **AND** the next main question is displayed or report generation begins

#### Scenario: User attempts to edit prior text
- **WHEN** the user attempts to replace or edit a previously submitted answer
- **THEN** the system rejects the edit and preserves the original answer material

### Requirement: Mutating commands are idempotent and concurrency-safe
Every mutating interview command MUST carry an Idempotency Key and expected interview version. The system SHALL ensure that a command advances the interview at most once.

#### Scenario: Same command is retried
- **WHEN** the same authenticated user repeats a command with the same Idempotency Key
- **THEN** the system returns the original Operation and result without duplicating messages, evaluations, or transitions

#### Scenario: Two clients submit competing commands
- **WHEN** two commands use the same expected interview version
- **THEN** at most one command advances the interview
- **AND** the other receives a version conflict with the current canonical state

### Requirement: Model failures do not corrupt interview state
The system SHALL persist the command Operation before model work. Accepting a valid user command MAY
advance the optimistic version, refresh effective activity, and record technical processing metadata,
but MUST NOT persist any new answer material, interviewer text, evaluation facts, question outcomes,
or question progress produced by that accepted command until required model output has completed and
passed validation. Business facts accepted before the command, including the provisional assessment
that precedes a supplement, remain unchanged while processing.

#### Scenario: Model operation succeeds
- **WHEN** the model response completes and passes Schema and Interview Engine validation
- **THEN** the system atomically stores the final result and advances state

#### Scenario: Model operation fails
- **WHEN** model retries and any allowed structure repair are exhausted
- **THEN** the Operation is marked failed
- **AND** the interview returns to the previous business phase with no new answer material, messages, evaluation facts, outcomes, or question progress
- **AND** the accepted command's optimistic version and effective activity remain recorded
- **AND** the user can explicitly retry the failed Operation

### Requirement: Streaming is presentation-only
The system SHALL stream model text through SSE without treating text deltas as durable state.

#### Scenario: Stream completes
- **WHEN** a model text operation completes successfully
- **THEN** the system atomically stores the final text and completes the Operation

#### Scenario: Browser disconnects
- **WHEN** the SSE connection closes before the Operation completes
- **THEN** server-side processing continues
- **AND** the browser can retrieve the canonical Operation and interview state through JSON endpoints

### Requirement: Model-assisted commands return durable acceptance before completion
The system SHALL return the canonical pending or processing Operation after durable command
acceptance without waiting for model or report execution to finish. Execution SHALL continue under
server ownership independently of the originating HTTP and SSE connections.

#### Scenario: Accepted model command returns before provider completion
- **WHEN** a valid model-assisted command has committed its Operation and processing metadata while the provider call remains incomplete
- **THEN** the command endpoint returns `202` with that Operation ID
- **AND** no model-produced business facts have been persisted yet

#### Scenario: Browser subscribes after command acceptance
- **WHEN** the browser receives the processing Operation from the command endpoint
- **THEN** it can subscribe to that Operation's SSE endpoint before model completion
- **AND** receives validated presentation events followed by one terminal status

#### Scenario: Originating request disconnects
- **WHEN** the command HTTP connection closes after durable acceptance
- **THEN** server-owned execution continues
- **AND** finalization commits or records a retryable failure independently of that connection

#### Scenario: Accepted execution is interrupted by process termination
- **WHEN** the server terminates after durable acceptance but before finalization
- **THEN** PostgreSQL retains the canonical pending or processing Operation
- **AND** stale reclaim or explicit retry can resume without duplicating interview facts

### Requirement: Active interviews are recoverable
The system SHALL allow the owner to resume an active interview from another page load or device using PostgreSQL state.

#### Scenario: User resumes within the activity window
- **WHEN** the owner opens an active interview less than 24 hours after its last effective activity
- **THEN** the system restores the current question, phase, messages, and available actions

#### Scenario: User leaves the page
- **WHEN** the browser closes, navigation occurs, or the user signs out
- **THEN** the interview remains active until explicitly terminated or expired

### Requirement: Effective activity extends the expiry window
Submitting an answer, supplement, clarification request, unknown command, skip command, continue command, or valid retry SHALL update the interview's last effective activity time. Passive viewing MUST NOT update it.

#### Scenario: User performs effective activity
- **WHEN** an allowed active-interview command is accepted
- **THEN** the 24-hour inactivity window starts again from that activity

#### Scenario: User only views the interview
- **WHEN** the user loads or refreshes the interview without an accepted command
- **THEN** the last effective activity time is unchanged

### Requirement: Inactive interviews expire
The system SHALL mark an active interview abandoned when more than 24 hours have elapsed since its last effective activity.

#### Scenario: Expired interview is accessed
- **WHEN** an active interview is read or mutated after the inactivity deadline
- **THEN** the system first transitions it to abandoned
- **AND** rejects further answers or continuation

#### Scenario: Sweeper finds expired interview
- **WHEN** the periodic sweeper finds an interview past its inactivity deadline
- **THEN** it transitions the interview to abandoned without creating a report

### Requirement: Users can end or abandon an interview
The system SHALL expose separate actions for ending with an incomplete report and abandoning without a report.

#### Scenario: End early
- **WHEN** the user chooses to end the interview and at least one main question has produced an outcome
- **THEN** the system begins incomplete-report generation
- **AND** no overall score is produced

#### Scenario: Abandon interview
- **WHEN** the user confirms abandonment
- **THEN** the interview becomes abandoned
- **AND** no report is generated

### Requirement: Terminal interviews are read-only
Completed, early-ended, and abandoned interviews MUST NOT accept answer, supplement, clarification, skip, continue, or retry commands that would change interview content.

#### Scenario: Mutate terminal interview
- **WHEN** a user submits an interview-progress command to a terminal interview
- **THEN** the system rejects the command without changing stored history
