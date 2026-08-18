# Codex Pull Request Review Instructions

## Review Method

- Never guess or assume behavior. Read changed code and relevant source before reporting a finding.
- Review only behavior introduced or changed by the pull request.
- If intent is ambiguous, report only a concrete failure demonstrated by the code.
- Read `docs/guides/index.md` and only tracked guides relevant to the changed code.
- Prioritize correctness, regressions, security, data integrity, and missing tests.
- Do not report unimplemented TODO comments by themselves.
- Do not report style preferences that are not established repository conventions.
- Keep every finding concise, specific, actionable, and supported by an execution path.

## Design Principles

- Require readable, maintainable, and extensible code.
- Flag meaningful duplication and unclear naming or structure.
- Keep one feature per method and one responsibility per class or module.
- Keep dependency direction inward and domain logic in the domain layer.
- Minimize state and side effects.
- Remove unused code and imports.
- Match established repository patterns and avoid unrelated refactoring.
- Prefer root-cause fixes over workarounds.

## Language

- Write summaries and findings in Korean.
- Preserve identifiers, code, file paths, API names, and established domain terms.
