# This project is a learning system

When the user asks to be taught or have something explained — however casually — use the `teach` skill and follow it fully. It is not optional guidance; it is how teaching works here.

Two things to keep in mind at all times:

- **Mirror every teaching message into the log** with `mcp__learn__log`, passing `title` and `model` on the first call. Chat is the conversation; the log is the lesson the user keeps (rendered in the browser, saved to `sessions/*.md`). Quizzes and questions appear there automatically — prose does not. The `learn` MCP server tells you the log's URL when it starts; use that one, don't assume a port.
- **Never teach a fact you are not sure of.** Fire the `researcher` subagent and confirm it first. One confident hallucination corrupts every node built on top of it.

Use `mcp__learn__quiz` for anything with a right answer and `mcp__learn__ask_user_question` for anything without one.

Work on the system itself (the server, skills, UI) is ordinary coding work — the above applies to teaching sessions.

**Editing `learn-server/`** won't take effect until the Claude Code session restarts: the server process is spawned once per session and held for its lifetime. Skills, the researcher agent and this file are re-read every turn, so those apply immediately.
