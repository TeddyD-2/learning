# Desired features

Ideas for the learn UI that haven't been built yet. Newest at the bottom.

- **Approve the plan from the UI.** The learner should never have to switch to the Claude Code chat to keep a lesson going. A presented plan should end with a built-in approve button ("Looks good, start" / "Change something…" with a text box) that blocks the lesson until it's clicked, like `quiz` does. Until that exists, the teach skill asks for the go-ahead with `ask_user_question`, which already renders in the UI.
- **Don't let a waiting question time out.** Claude Code aborts an MCP tool call that sends nothing for too long (a quiz left open for hours failed with "sent no response or progress"). While `quiz`, `ask_user_question` or `match` is waiting on the learner, the server should send MCP progress notifications as a heartbeat. Alternatively, `.mcp.json` can set a per-server `timeout`. The question should stay answerable whenever the learner comes back.
