---
name: bork-batch
description: Group related GitHub issues into batches for bork-doitall.
---

# BORK Batch

Apply the shared [profile contract](../bork-doitall/references/profile.md) before starting. Preserve any supplied profile in nested calls; default to `generic`.

Inspect the issues the user names, identify related implementation work and dependencies, and present clear batches that can be passed to `bork-doitall`. This skill plans the grouping. `bork-doitall` owns execution, its approval gate, and its issue and PR workflow.

## Embedded Planning Mode

When called by `bork-doitall` for multiple canonical roots, apply the grouping criteria and coverage checks below to its already-discovered issue/PR targets, including verified descendants. Reuse the supplied evidence and inspect only missing context; do not restart doitall or launch another coordinator. Return logical group membership, rationale, dispositions, and evidenced dependencies to the caller. In this mode, replace the separate invocation output in steps 4, 6, and 7 with groups inside the caller's single execution plan. Doitall retains its target scope, dependency scheduler, separate target implementations and PRs, and sole `go` gate. Grouping alone does not combine PRs or authorize separate execution runs. Standalone use retains the workflow below.

## Workflow

1. Read the `bork-doitall` skill before preparing a handoff. Follow its instruction routing and read-only discovery rules for issue normalization and inspection. Do not start implementation or make external changes while grouping.
2. Inspect every supplied issue and enough related context to judge whether work belongs together. Check descriptions, labels, linked issues, parent and child relationships, affected components, acceptance criteria, dependencies, and existing PRs when relevant. Use read-only GitHub access. Do not infer a relationship from adjacent issue numbers or similar titles alone.
3. Partition the supplied issues into practical execution batches. Group issues when they share an implementation change, require the same code context, or have a meaningful dependency best handled in one coordinated run. Keep independent issues separate when combining them would obscure scope or make review harder. Preserve true implementation dependencies and ordering.
4. Account for `bork-doitall` behavior: each invocation treats all supplied roots and verified descendants as one batch. Present multiple groups as separate, explicitly numbered `bork-doitall` invocations. Do not imply that separate groups passed in one invocation will remain separate.
5. Account for every supplied issue exactly once, including blocked, duplicate, resolved, or otherwise non-actionable issues. State each disposition and its reason. Call out verified sub-issues that `bork-doitall` will discover under each root. Avoid listing a descendant as an independent root when another supplied root already covers it.
6. Present the recommendation in a compact, scannable form:
   - One batch per row or heading, with issue numbers and short titles.
   - A concise reason for each grouping or singleton.
   - Any dependency, execution order, overlap, uncertainty, or non-actionable disposition.
   - A copyable `bork-doitall` input for each proposed batch, using canonical issue numbers or URLs.
   - A coverage check confirming every supplied issue appears exactly once.
7. Recommend the grouping without asking for approval unless the next action is ambiguous. The user may rearrange it. When the user asks to proceed, pass only the chosen batch to `bork-doitall`. Let that skill show its complete execution plan and require its own explicit `go` before mutations.

## Example Output

| Batch | Issues | Why together |
| --- | --- | --- |
| 1 | #1, #4, #5 | They change the same access-control path and can share implementation and review. |
| 2 | #2 | This is an independent billing fix. |
| 3 | #3 | This depends on the API shape from batch 1, so it should run afterward. |

Follow the table with the separate `bork-doitall` inputs in execution order and identify any issue that cannot yet be batched safely.
