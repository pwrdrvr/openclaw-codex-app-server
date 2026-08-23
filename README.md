# OpenClaw Plugin For Codex App Server

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/openclaw-codex-app-server)](https://www.npmjs.com/package/openclaw-codex-app-server)

> ## This project is defunct
>
> It is no longer developed or maintained. The last release, `0.6.1`, targets
> OpenClaw versions from early 2026 and will drift further out of compatibility
> with every OpenClaw release. **Do not start new work against it.**
>
> The repository stays public and MIT-licensed. Nothing is being deleted — the
> code, the history, and the [original README](./docs/legacy-readme.md) with its
> full command reference all remain here for anyone still running it or reading
> it for reference.

## What this was

An exploration, built when the question was still open: *could you actually drive
a coding agent from a chat app?* Not a demo of a chat bot that writes code
snippets — real threads, resumed from Telegram or Discord, sharing state with
Codex Desktop and the Codex TUI on your own machine, with plan mode, reviews,
model switching, and approvals all working from your phone.

<p align="center">
  <a href="https://youtu.be/GKkipfNEJJQ">
    <img src="https://img.youtube.com/vi/GKkipfNEJJQ/maxresdefault.jpg" alt="Watch the OpenClaw Codex App Server demo on YouTube" width="100%" />
  </a>
</p>

It answered the question: yes, and it is genuinely good. That answer is why the
work continued elsewhere.

## Thanks to the OpenClaw team

This plugin only existed because OpenClaw was a pleasure to build on and the
OpenClaw team were great to work with — responsive on issues, willing to move
plugin interfaces to make this possible, and generous with review. Several of
the changes this plugin needed landed upstream in OpenClaw itself. That is
exactly how it should go, and it is why this repository can be retired without
any of the work being lost.

## Where to go from here

Two options, and they are not competing for the same person.

### Stay in OpenClaw

OpenClaw has features for coding workflows of its own these days. If OpenClaw is
already where you work, start there — see the current
[OpenClaw documentation](https://github.com/openclaw/openclaw) for what ships
today.

### Or try PwrAgent

<p align="center">
  <a href="https://pwragent.ai">
    <img src="./assets/pwragent-logo.png" width="96" alt="PwrAgent logo" />
  </a>
</p>

**[PwrAgent](https://pwragent.ai)** is this author's own vision of what
development via messaging should be — so treat it as the interested
recommendation it is. A desktop app rather than a plugin, free and MIT-licensed,
running entirely on your own machine.

- **Messaging platforms** — Telegram, Discord, Slack, Mattermost, LINE, and
  Feishu / Lark. Pair a bot once with a one-time code; no IDs to look up, no
  JSON to paste.
- **Agent harnesses** — Codex, Grok Build, Kimi, and Qwen. It uses the install
  and the subscription you already have; PwrAgent holds no model key of its own.
- **Automations** — messaging triggers with filters, so a matching message
  starts an agent run on its own. Ephemeral agent history from those runs is
  carried into the next invocation, so a sequence of triggered runs accumulates
  context instead of starting cold each time.
- **Manager Agents** — an agent that can query the status and output of the
  agents your triggers started. Point the triggers at a production alert feed,
  let them analyse each alert as it lands, then ask a manager agent *"are we
  having a problem?"* — and get an answer grounded in what those runs actually
  found.

#### Install

| Platform | Download | Notes |
| --- | --- | --- |
| **macOS** | [PwrAgent.dmg](https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent.dmg) | Universal — Apple Silicon and Intel. Developer ID-signed and notarized, so first launch is one Gatekeeper prompt |
| **Windows** | [latest release](https://github.com/pwrdrvr/PwrAgent/releases/latest) → `-windows-x64-setup.exe` | Signed through Azure Trusted Signing, installer and the executables inside it |
| **Linux** | [.deb x64](https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-x64.deb) · [.deb arm64](https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-arm64.deb) | Debian / Ubuntu |

Setup is the installer plus **Settings → Messaging → your platform**, where you
pair a bot with a one-time code. No IDs to look up, no JSON to paste.

#### Links

[pwragent.ai](https://pwragent.ai) — home ·
[docs.pwragent.ai](https://docs.pwragent.ai) — docs ·
[github.com/pwrdrvr/PwrAgent](https://github.com/pwrdrvr/PwrAgent) — source ·
[releases](https://github.com/pwrdrvr/PwrAgent/releases) ·
[pwrdrvr.com/about](https://pwrdrvr.com/about) — who builds it

## Attribution

`Codex` is mentioned here only to describe the protocol and toolchain this
plugin connected to. This repository is independent and is not official,
provided, sponsored, endorsed, or affiliated with OpenAI or Codex. Likewise,
PwrAgent is built by [PwrDrvr LLC](https://pwrdrvr.com/about) and is not
affiliated with or endorsed by OpenAI or by the OpenClaw project.

---

<sub>Built by <a href="https://pwrdrvr.com/about">PwrDrvr LLC</a>. MIT licensed —
fork it, learn from it, take what is useful.</sub>
