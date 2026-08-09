## ADDED Requirements

### Requirement: Users can authenticate with supported methods
The system SHALL allow a user to create or access an account through GitHub OAuth or a one-time code sent to a verified email address.

#### Scenario: Sign in with GitHub
- **WHEN** a user completes the configured GitHub OAuth flow
- **THEN** the system creates or resumes an authenticated account session

#### Scenario: Sign in with email OTP
- **WHEN** a user submits a valid unexpired email OTP within the allowed attempt limit
- **THEN** the system creates or resumes an authenticated account session

#### Scenario: Invalid email OTP
- **WHEN** a user submits an expired, invalid, or exhausted email OTP
- **THEN** the system rejects authentication without creating a session

### Requirement: Identity linking is explicit
The system MUST NOT implicitly merge identities because they return the same email address. An authenticated user SHALL be able to explicitly link a GitHub identity, including one with a different email address, without changing the account's primary email.

#### Scenario: Matching email is not implicitly linked
- **WHEN** a GitHub sign-in returns an email already owned by an account but the GitHub identity is not linked
- **THEN** the system rejects the sign-in as unlinked and instructs the user to authenticate through the existing method first

#### Scenario: User explicitly links GitHub
- **WHEN** an authenticated user completes the account-linking GitHub OAuth flow
- **THEN** the GitHub identity is added to that account
- **AND** the account's primary email remains unchanged

### Requirement: Account sessions protect user resources
The system SHALL require an authenticated session to create, resume, view, or delete interviews and reports belonging to an account.

#### Scenario: Authenticated owner accesses an interview
- **WHEN** the authenticated owner requests an interview or report
- **THEN** the system returns the requested resource if it is not deleted

#### Scenario: Another user requests an interview
- **WHEN** an authenticated user requests an interview owned by another account
- **THEN** the system does not disclose that interview or its contents

#### Scenario: Session is revoked
- **WHEN** an account session has expired or been revoked
- **THEN** protected requests require the user to authenticate again

### Requirement: History is chronological and state-aware
The system SHALL present an account's interview history in reverse chronological order with the interview date, direction, question count, status, and overall score only when a complete report exists.

#### Scenario: Completed interview in history
- **WHEN** a completed interview appears in history
- **THEN** the entry displays its overall score and links to the transcript and immutable complete report

#### Scenario: Early-ended interview in history
- **WHEN** an early-ended interview appears in history
- **THEN** the entry links to the transcript and incomplete report without displaying an overall score

#### Scenario: Abandoned interview in history
- **WHEN** an abandoned interview appears in history
- **THEN** the entry displays its abandonment status and available transcript without a report or overall score

### Requirement: Only one interview may remain active
The system SHALL allow an account to have at most one interview in an active or report-pending state.

#### Scenario: User already has an active interview
- **WHEN** a user attempts to create another interview while one is active
- **THEN** the system requires the user to resume the existing interview or explicitly abandon it before creating another

#### Scenario: Previous interview is terminal
- **WHEN** the user's previous interview is completed, early-ended, abandoned, or deleted
- **THEN** the user may create a new interview

### Requirement: Users can delete an interview
The system SHALL allow an authenticated owner to delete an interview. Confirmation SHALL immediately make its transcript, evaluations, Operations, and report inaccessible and non-restorable to users.

#### Scenario: Delete an interview
- **WHEN** the owner confirms deletion of an interview
- **THEN** the interview and all related user content become immediately inaccessible
- **AND** all related content is physically removed within seven days

#### Scenario: Access deleted interview
- **WHEN** any user requests an interview after deletion was confirmed
- **THEN** the system does not return the interview or report

### Requirement: Users can delete their account
The system SHALL allow an authenticated user to delete the account and all related data. Confirmation SHALL immediately revoke account sessions and make all account data inaccessible and non-restorable.

#### Scenario: Delete account
- **WHEN** a user completes the required account-deletion confirmation
- **THEN** all account sessions are revoked
- **AND** account, identity, interview, transcript, evaluation, Operation, and report data become inaccessible
- **AND** the content is physically removed within seven days

### Requirement: Purge audit data is non-reversible
After physical deletion, the system MUST retain at most a non-reversible account identifier hash, deletion time, data category, and purge result. It MUST NOT retain email addresses, questions, answers, scores, reports, OAuth tokens, or other recoverable user content.

#### Scenario: Purge completes
- **WHEN** a deletion request is physically purged
- **THEN** only the permitted non-reversible audit metadata remains

