# Aurora progress

A terminal-first progress band for Claude Code. It draws above the prompt:

```
⠹ Aurora demo   ━━━━━━━━━━━━━━━━━━╸━━━━━━━━━━━━━━━━  2/4 · 50% · 0m 42s  ▾ ✕
  ├ ✔ Count xadmin modules       haiku · 9s
  ├ ✔ Find TODO comments         haiku · 11s
  ├ ⠼ List console commands      ━━━━━╸──── 2/3 grouping  haiku · 12s
  └ ○ Summarize recent commits   queued
```

- A violet → teal gradient bar with a moving glint while work runs; it turns green when done.
- One row per task: a spinner while running, ✔ / ✘ when it ends, model and elapsed time.
- Each subagent's own step bar, when it reports steps.
- Subagents show up on their own, even when nothing reports progress.
- Other mods' bands stack underneath instead of being replaced.

## Install

Requires Claude Code 2.1.287 or later (function hooks, early access).

```
/plugin marketplace add Skalin/aurora-progress
/plugin install aurora-progress@aurora-progress
```

Restart the session or run `/reload-plugins`.

## Use

The model reports progress with two tools:

- `mcp__aurora-progress__progress` (main session): `title` and `tasks` once, then `done` as parts finish, and `finished: true` at the end. Task titles that equal an Agent `description` light up when that subagent runs.
- `mcp__aurora-progress__step` (subagents): `total`, `done` and a short `note`. A subagent started for a planned task is asked to report steps automatically.

Commands: `/aurora clear` hides the band, `/aurora toggle` folds the task rows. `✕` dismisses it, `▾` folds it, and a finished band clears on your next prompt.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
