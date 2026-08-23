# OpenClaw Plugin For Codex App Server

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/openclaw-codex-app-server)](https://www.npmjs.com/package/openclaw-codex-app-server)

> ### This project is defunct
>
> No longer developed or maintained. The last release targets OpenClaw builds
> from early 2026 and drifts further out of compatibility with every release.
> **Do not start new work against it.** Nothing is deleted — the code, the
> history, and the [original README](./docs/legacy-readme.md) with its full
> command reference all stay here.
>
> Two things to do instead. Both are good; the first is the author's own.

---

<p align="center">
  <a href="https://pwragent.ai">
    <img src="./assets/pwragent-logo.png" width="104" alt="PwrAgent logo" />
  </a>
</p>

<h2 align="center">Try PwrAgent</h2>

<p align="center">
  <strong>Your coding agent runs on your laptop. You drive it from your phone.</strong>
</p>

<p align="center">
  This plugin proved the idea worked. PwrAgent is the whole thing — a desktop app
  instead of a plugin, six messengers instead of two, four agent harnesses, and
  automations this never had. Free, MIT-licensed, running entirely on your own
  machine.
</p>

<p align="center">
  <a href="https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent.dmg">
    <img src="./assets/buttons/download-macos.png" alt="Download for macOS" width="330">
  </a>
  &nbsp;
  <a href="https://docs.pwragent.ai">
    <img src="./assets/buttons/read-the-docs.png" alt="Read the docs" width="330">
  </a>
</p>

<p align="center">
  <sub>
    Universal macOS binary — Apple Silicon and Intel, Developer ID-signed and notarized.<br>
    Windows: <a href="https://github.com/pwrdrvr/PwrAgent/releases/latest">latest release</a> →
    <code>-windows-x64-setup.exe</code>, signed through Azure Trusted Signing &nbsp;·&nbsp;
    Linux: <a href="https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-x64.deb">.deb x64</a> ·
    <a href="https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-arm64.deb">.deb arm64</a>
  </sub>
</p>

### What you get over this plugin

- **Six messaging platforms** — Telegram, Discord, Slack, Mattermost, LINE, and
  Feishu / Lark. This plugin did two. Pair a bot once with a one-time code; no
  IDs to look up, no JSON to paste.
- **Four agent harnesses** — Codex, Grok Build, Kimi, and Qwen. It uses the
  install and the subscription you already have; PwrAgent holds no model key of
  its own.
- **Automations** — messaging triggers with filters, so a matching message starts
  an agent run on its own. Ephemeral agent history from those runs is carried
  into the next invocation, so a sequence of triggered runs accumulates context
  instead of starting cold each time. There was nothing like this here.
- **Manager Agents** — an agent that can query the status and output of the
  agents your triggers started. Point the triggers at a production alert feed,
  let them analyse each alert as it lands, then ask a manager agent *"are we
  having a problem?"* and get an answer grounded in what those runs found.
- **No compatibility treadmill.** Half the [original
  README](./docs/legacy-readme.md) is a matrix of which plugin version works with
  which OpenClaw build. A desktop app has no such matrix.

Setup is the installer plus **Settings → Messaging → your platform**.

[pwragent.ai](https://pwragent.ai) ·
[docs](https://docs.pwragent.ai) ·
[source](https://github.com/pwrdrvr/PwrAgent) ·
[releases](https://github.com/pwrdrvr/PwrAgent/releases) ·
[who builds it](https://pwrdrvr.com/about)

> PwrAgent is by the same author as this plugin, so treat the above as the
> interested recommendation it is.

---

## Or stay in OpenClaw

A genuinely reasonable choice, and the better one if OpenClaw is already where
you work. OpenClaw has features for coding workflows of its own these days — see
the current [OpenClaw documentation](https://github.com/openclaw/openclaw) for
what ships today.

---

## What this was

An exploration, built when the question was still open: *could you actually drive
a coding agent from a chat app?* Not a bot that writes code snippets — real
threads, resumed from Telegram or Discord, sharing state with Codex Desktop and
the Codex TUI on your own machine, with plan mode, reviews, model switching, and
approvals all working from your phone.

<p align="center">
  <a href="https://youtu.be/GKkipfNEJJQ">
    <img src="https://img.youtube.com/vi/GKkipfNEJJQ/maxresdefault.jpg" alt="Watch the OpenClaw Codex App Server demo on YouTube" width="100%" />
  </a>
</p>

It answered the question: yes, and it is genuinely good. That answer is why the
work continued.

### Thanks to the OpenClaw team

This plugin only existed because OpenClaw was a pleasure to build on and the
OpenClaw team were great to work with — responsive on issues, willing to move
plugin interfaces to make this possible, and generous with review. Several of the
changes this plugin needed landed upstream in OpenClaw itself. That is exactly
how it should go, and it is why this repository can be retired without any of the
work being lost.

## Attribution

`Codex` is mentioned here only to describe the protocol and toolchain this plugin
connected to. This repository is independent and is not official, provided,
sponsored, endorsed, or affiliated with OpenAI or Codex. Likewise, PwrAgent is
built by [PwrDrvr LLC](https://pwrdrvr.com/about) and is not affiliated with or
endorsed by OpenAI or by the OpenClaw project.

---

<sub>Built by <a href="https://pwrdrvr.com/about">PwrDrvr LLC</a>. MIT licensed —
fork it, learn from it, take what is useful.</sub>
