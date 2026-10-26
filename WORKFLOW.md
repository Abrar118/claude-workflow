# My workflow

How I work with Claude Code day to day, and where each mod, skill and plugin fits.

## The loop

| Step | What happens | What helps |
|---|---|---|
| 1. Idea | I describe what I want, often by voice. Claude asks questions until the goal is clear. | `superpowers:brainstorming` |
| 2. Plan | Claude writes a plan with numbered tasks. The tasks show up in the side pane with a progress bar. | `superpowers:writing-plans`, **agent-panel** |
| 3. Build | Claude works through the tasks test-first. It logs every guess it makes so I can mark it right or wrong without stopping it. | `superpowers:test-driven-development`, **assumption-log** |
| 4. Queue | New ideas while Claude is busy go into a queue instead of interrupting. | **prompt-queue** (`/add-queue`) |
| 5. Debug | When I paste an error, Claude switches to step-by-step debugging instead of guessing. | **debug-on-paste**, `superpowers:systematic-debugging` |
| 6. Review | Claude reviews the diff. If I paste outside feedback, every claim gets checked with evidence before anything changes. | `/code-review`, **verify-outside-feedback** |
| 7. Ship | Formatting runs on every edit. Lint, typecheck and format checks run before a push. Risky commands, pushes to main and any merge into main need my OK. | **format-on-edit**, **push-preflight**, **safety-guard** |

## Watching cost and limits

- **prompt-deck** sits above the prompt and shows context use, the 5-hour and weekly limits, how long the prompt cache stays warm, and a suggested next prompt.
- **turn-meter** adds the time, tool calls and cost of each turn, and shows a toast when a turn costs far more than usual.
- **limit-guard** warns as the 5-hour limit fills up, and asks before starting subagents when it is nearly used up.
- The **status line** shows the model, effort, repo, branch, open PR, context bar and limits at a glance.

## Habits (from my CLAUDE.md)

- Short answers. No unrequested features, refactors or abstractions.
- The simplest code that works: reuse what's in the codebase, then the standard library, then dependencies that are already installed.
- Read the code before making claims about it.
- Use subagents only when fanning out across many items.
- Use `rg` instead of `grep`.

## Setup

- Terminal: [Kitty](https://sw.kovidgoyal.net/kitty/) with a dark theme (background `#1d1d20`). The mod panes use the same colors, hardcoded.
- Claude Code in fullscreen TUI mode, with voice input on.
- Model: Opus by default; Sonnet for lighter sessions.
