# Desired features

Ideas for the learn UI that haven't been built yet. Newest at the bottom.

- **Approve the plan from the UI.** The learner should never have to switch to the Claude Code chat to keep a lesson going. A presented plan should end with a built-in approve button ("Looks good, start" / "Change something…" with a text box) that blocks the lesson until it's clicked, like `quiz` does. Until that exists, the teach skill asks for the go-ahead with `ask_user_question`, which already renders in the UI.
- ~~**Don't let a waiting question time out.**~~ Done: `.mcp.json` sets a 24-hour per-server `timeout`, and the server sends MCP progress heartbeats every 25 s while a tool waits on the learner, when the client provides a progress token.
- **Hot reload of server code**, so edits to `learn-server/*.js` don't need a Claude Code restart. A thin process keeps stdio and the port, swaps in fresh handler modules, and sends `notifications/tools/list_changed` (unverified whether Claude Code honours it).
