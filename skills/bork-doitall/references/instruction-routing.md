# Extra Instruction Routing

## Capture and Scope

Treat instructions supplied with the invocation, including trailing prose, as task requirements. Preserve their exact text in a durable batch instruction record before launching workers. Assign stable IDs and record each instruction's target scope, applicable phases/roles, and routing reason. Reference this record from `plan.json`. User instructions take precedence over conflicting skill defaults, subject to higher-priority instructions and tool permissions.

Apply unqualified instructions to all supplied roots and their discovered sub-issue targets; bind explicitly scoped instructions to their canonical target, retaining issue/PR aliases through PR creation. Do not extract new targets from numbers or URLs appearing only in explanatory prose. An instruction can have multiple recipients. Resolve scope from meaning and workflow responsibility, not keyword matching. Ask only when ambiguity materially changes the work; independent targets can continue.

## Choose Recipients

| Instruction concerns | Recipients and responsibility |
| --- | --- |
| Behavior, acceptance criteria, compatibility, architecture, implementation limits | `bork-prify` implements; `bork-review` verifies; `bork-fix` preserves the constraint while fixing findings. Both `bork-goodcode` phases carry it as product intent. |
| Required tests or validation | `bork-prify` and `bork-fix` run applicable checks; `bork-review` assesses coverage and evidence; `bork-goodcode` enforces completion and evidence reuse rules. |
| Review emphasis or finding policy | `bork-review` through `bork-goodcode`; include in `bork-fix` when it affects remediation. Review emphasis adds attention without silently excluding required correctness checks. |
| Supplied profile | Coordinator retains approved path/hash and snapshot; each destination loads only its applicable sections and forwards role-scoped constraints through `instruction_paths`. |
| Commit identity, signing, commit content | `bork-prify` and `bork-fix` create commits; `bork-goodcode` verifies publication requirements. |
| PR title/body or publication/follow-up behavior | `bork-prify` for creation; `bork-goodcode` for its later updates, pushes and follow-up; target master for ready promotion. |
| Dependencies, base branches, concurrency, phase skips or stop conditions | Coordinator and target master; pass affected base/setup/action constraints to `bork-prify` or `bork-goodcode` and their workers as applicable. |
| Final response format or reporting detail | Coordinator and target master; pass to a child only when its output is also constrained. |

The table is guidance, not an exhaustive classifier. Every instruction needs an owner or an explicit inapplicable/conflict reason. Keep action restrictions such as "do not push" with every role that can perform that action, including nested orchestrators. If an instruction prevents a normal phase, honor it and report that phase as skipped or blocked; do not claim the default full workflow completed.

## Carry Through Every Handoff

Create durable role-specific instruction files containing the applicable instruction IDs, exact text, scope, and necessary context. Pass their absolute paths through the existing `instruction_paths` brief field, preserving repository instruction paths already present. Explicitly tell each worker prompt to read those paths before acting. Do not rely on inherited conversation or add unsupported fields to the runtime brief schema.

The target master receives all instructions for its target. When acting as `bork-goodcode`, it retains orchestration instructions and passes the relevant subset to both `bork-review` and `bork-fix`, in draft and ready runs and every subsequent cycle. Each recipient follows the same routing contract if it delegates further. A fix instruction constrains fixes; it does not bypass the review handoff. For an existing PR, route unmet implementation requirements to the reviewer for actionable findings before the fixer changes code.

Before launch or resume, check that every applicable instruction is present in the receiving role's files. Missing or unreadable required instructions block that role until repaired. Require role result records to identify the instruction IDs considered and their outcome or evidence, including a reason for anything inapplicable or blocked. Verify those dispositions before accepting phase completion; a process exit alone is insufficient.

Retain instruction files outside disposable worktrees. Reuse them on retries and resumes. For later user amendments, retain prior revisions, update affected role briefs before further dependent actions, and reconcile active workers so they do not continue under superseded instructions. Changed acceptance criteria invalidate affected review/validation evidence under the existing reuse rules. Never erase unrelated requirements when applying an amendment.
