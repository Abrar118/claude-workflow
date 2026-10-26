# Global Instructions

## Tools
- **Use ripgrep (`rg`) instead of `grep`** for all search operations in Bash commands. It's installed and preferred.

## Outside feedback
- When I paste a review, critique or suggestions (code, research, plans, anything), use the `verify-outside-feedback` skill: give each claim a Confirmed / Refuted / Unclear verdict with evidence before agreeing or changing anything. Never name or guess the source.

## Working Preferences
- Provide concise, focused responses. Skip non-essential context; keep examples minimal. (Override per-request when you want depth.)
- Don't spawn a subagent for work doable directly in one response. Spawn multiple subagents in one turn when fanning out across items or reading multiple files.
- Never claim things about code you haven't opened. If a specific file is referenced, read it before answering.
- Avoid over-engineering. Only make changes directly requested or clearly necessary — no unrequested features, refactors, abstractions, or defensive code for impossible cases.
- Simplest code that works: first ask if it needs to exist, then reuse what's in the codebase, then stdlib, then native platform features, then installed deps; never add a dependency for a few lines. Read and trace the problem fully before picking the small fix; fix bugs at the root, in the shared function, not per caller. Non-trivial logic leaves one small runnable check. Never simplify away validation, security, data-loss error handling or accessibility.
