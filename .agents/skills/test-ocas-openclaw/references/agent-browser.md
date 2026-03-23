# Agent Browser Fallback Notes

Read this file only if you intentionally choose [$agent-browser](https://github.com/vercel-labs/agent-browser) instead of Playwright MCP or Chrome MCP.

## Current Recommendation

- Treat `agent-browser` as fallback-only for Telegram Web.
- Prefer Playwright MCP or Chrome MCP for the primary regression pass.

## Known Problems

- The browser can drift out of the intended topic and back to the chat list or `General`.
- Slash-command replies can appear in `General` even when the intended target was a topic.
- Telegram Web can show stale UI until a manual refresh.

## Workarounds

- Reload the page before a serious test pass.
- Keep the topic fragment in the URL when possible. For example, a topic URL can look like `#-1003841603622_3509`.
- If the page drops the topic fragment or navigates away from the topic, re-enter the topic before sending the next command.
- If a simple request appears hung for more than about one minute, check `~/.openclaw/openclaw-codex-app-server/state.json`. If the pending request already exists there, refresh with `Cmd+R`.

## Interpretation Guidance

- Do not blame OCAS for topic drift until you confirm the browser is actually still in the intended topic.
- If plain text works in-topic but slash commands leak elsewhere only under `agent-browser`, treat that as likely browser-automation interference until proven otherwise.
