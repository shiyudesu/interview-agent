# Keep interview flow deterministic

The Interview Engine owns the interview blueprint, state transitions, follow-up limits, scoring workflow, and terminal states. Pi Agent Core is used only for interviewer text turns, while decision-bearing analysis, scoring, and report data use schema-constrained `pi-ai` calls; neither path may advance interview state independently.
