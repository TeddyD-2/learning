@echo off
rem Open the learn UI. Browses saved sessions; attaches to the live one if Claude Code is running.
node "%~dp0learn-server\mcp.js" --serve
