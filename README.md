# learn

A Claude Code port of [amosblomqvist/learn](https://github.com/amosblomqvist/learn) — the teaching philosophy from [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU), rebuilt so it runs on Claude Code with your Claude subscription and nothing else. No pi, no Obsidian, no API keys.

The lesson happens in a terminal-styled page on localhost: markdown, LaTeX and mermaid rendered live, with interactive quizzes you answer from the keyboard. Every lesson is also saved as plain markdown you keep.

## Start a lesson

Run `claude` in this directory, then:

```
/learn how TCP actually gives you a reliable stream
```

or just ask to be taught something. The browser opens by itself on the first tool call; the page's URL is printed by the server and shown in Claude's tool output.

The first run asks you to approve the project's MCP server — say yes once. Requirements: Node 18+ and Claude Code. There's nothing to install; the server has zero dependencies. (marked, KaTeX and mermaid load from a CDN the first time, then the browser caches them.)

## Just read past lessons

Double-click **`learn.cmd`**, or from a shell:

```bash
npm start
```

If a lesson is already running, this opens that page instead of starting a second, disconnected copy — even when it landed on a fallback port.

## What happens

1. **Probe.** You get quizzed until the edge of what you already know is bracketed — something you get right, something you get wrong. Then you're asked what you actually want out of the topic.
2. **Plan.** Claude researches the field, plans a dependency graph (unconditional truths at the roots, your goal at the sink), draws it as a mermaid diagram, and waits for your go-ahead.
3. **Teach.** One node at a time: motivate → establish → connect → quiz-check. Nothing gets built on a node you haven't confirmed.

Lessons are written to `sessions/<timestamp>-<title>.md`. Quizzes and questions write themselves there — the question, the options with ✓/✗, your note and the explanation — so the transcript is complete even through a long probe phase with little prose. Claude adds the teaching prose with the `log` tool.

## The UI

```
↑↓ / j k     move
space or 1-9 select
enter        submit
tab          jump to the note field (ctrl+enter submits from there)
```

Quizzes are graded the moment you submit: ✓/✗, the correct answer, and the explanation. "I don't know" is always the last option and is recorded as an honest gap, not a wrong answer — Claude treats the two differently. The note field reaches Claude with any answer, so "I guessed" or "I was thinking of X" steers what comes next. Everything is clickable too.

The header shows the file the lesson is being saved to, and which model reported itself as teaching. **sessions** opens a drawer of every saved lesson — filter by name, click one to read it (*back to live* returns), hover one to delete it. **new** clears the board and starts a fresh log file; run `/clear` in Claude Code to match.

Reload the page any time — the whole session replays from the server. If you scroll up mid-lesson, a **↓ latest** button appears.

## Choosing the model

Two separate model choices, and they pull in different directions:

- **The session model** does the teaching. Set it with `/model` in Claude Code, or `model` in `.claude/settings.json` for future sessions. It matters most in Phase 2 — deciding what is genuinely an unconditional truth, and noticing when it is unsure enough to go check. That second one is the real accuracy lever, because a model that never doubts itself never fires the researcher.
- **The researcher's model**, set in `.claude/agents/researcher.md`, answers from pages it actually fetched. Grounded work, so Sonnet is reliable here and keeps the wait short.

If Opus feels slow, try `/fast` before trading down — it's Opus with faster output.

## Layout

```
.claude/
  skills/teach/SKILL.md       the philosophy and the probe → plan → teach process
  skills/visualize/SKILL.md   when and how to add a diagram
  agents/researcher.md        web research + fact-checking subagent
  commands/learn.md           /learn <topic>
  settings.json               pre-approves the learn tools
.mcp.json                     registers the learn MCP server
learn-server/
  mcp.js                      MCP stdio server: quiz, ask_user_question, log
  ui.js                       localhost HTTP + SSE bridge, sessions API
  log.js                      the session markdown log
  public/                     the terminal UI
sessions/                     your lessons, as markdown (gitignored)
learn.cmd                     open the UI on its own
```

## Tools Claude gets

| tool | what it does |
| --- | --- |
| `mcp__learn__log` | append a teaching message to the log and render it live (markdown + LaTeX + mermaid) |
| `mcp__learn__quiz` | graded single/multi-select question, marked instantly in the UI |
| `mcp__learn__ask_user_question` | ungraded question — preferences, direction, free text |

## Config

| env var | default | |
| --- | --- | --- |
| `LEARN_PORT` | `4242` | preferred UI port (falls forward through the next 20 if taken) |
| `LEARN_NO_OPEN` | unset | set to skip auto-opening the browser |
| `LEARN_SESSIONS_DIR` | `./sessions` | where lesson markdown is written |

Set them in the `env` block of `.mcp.json`.

**Editing the server:** Claude Code spawns `learn-server/mcp.js` when a session starts and keeps that process for the whole session, so changes to the server or the page don't apply until you restart the session. (Editing the skills, the agent or `CLAUDE.md` takes effect immediately — those are read per turn.)

## Differences from the pi original

- **Teaching happens in Claude Code**, so it runs on your Claude subscription. The `researcher` subagent uses Claude's `WebSearch`/`WebFetch` instead of OpenRouter.
- **The log replaces Obsidian.** Same markdown, same LaTeX, same mermaid — rendered in the browser and saved to `sessions/`.
- **Visuals are authored inline** (mermaid fences, inline SVG) instead of going through `svg-maker`/`mermaid-maker` subagents that render a PNG and look at it. Simpler and dependency-free; the tradeoff is that nothing visually verifies a diagram before you see it, so `visualize` carries authoring rules for the common failure modes instead.
- **The quiz UI is a web page**, not a pi TUI widget — same keys, same ✓/✗ grading, same "I don't know" and note field.

The pi originals aren't vendored here. If you ever want to diff against them:
[amosblomqvist/learn](https://github.com/amosblomqvist/learn) and
[amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents).
