# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Backlog (planned for v0.2.0)
- Optional collection of non-completion usage surfaces:
  `/v1/organization/usage/{images, audio, embeddings, vector_stores, code_interpreter_sessions, moderations}`.
  Skipped in v0.1.0 because the cost endpoint already covers their spend.

## [0.1.0] — 2026-05-08

### Added
- Initial release.
- `runCollector({ apiKey, organizationId?, from, to, fetch? })` factory.
- Calls OpenAI's `/v1/organization/costs` for real USD spend.
- Calls OpenAI's `/v1/organization/usage/completions` for token counts.
- Joins both endpoints by `(date, project_id)`; cost is distributed across
  users in the same `(date, project_id)` proportional to token volume.
- Cursor-based pagination on both endpoints (`next_page` cursor).
- Errors: `OpenAiSpendError`, `OpenAiSpendConfigError`, `OpenAiSpendAuthError`,
  `OpenAiSpendRateLimitError`, `OpenAiSpendApiError`.
- Auth-error classification: 401 from either endpoint surfaces as
  `errorType: 'auth'` with a hint that Admin API keys are required.
- Zero dependencies, ESM, Node ≥ 18.
