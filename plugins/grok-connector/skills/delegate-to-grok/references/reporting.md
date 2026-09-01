# Reporting a Grok Build delegation

Report, in this order:

1. Connector, job id and terminal status.
2. The verdict when present. State plainly that `EMPTY_SCOPE` and `COULD_NOT_REVIEW` are not approvals.
3. Scope: kind, file count and `+added/-removed`. Name the base ref for a branch review.
4. Findings ordered by severity, each as `file:line — SEVERITY — title`, with paths and line numbers exactly as returned.
5. Permission denials, schema errors and provider errors when present.
6. For writes: every changed file and the rollback reference.
7. Usage and cost when the provider reported them.
8. The native session id, labelled as provider-specific.

Never:

- Never report success from a zero exit code. Only `status: COMPLETED` means completed.
- Never present a cross-provider handoff as a lossless session resume. It is a derived context.
- Never apply a fix from a review without asking which findings to address.
- Never substitute your own analysis when the bridge failed. Report the failure and stop.
