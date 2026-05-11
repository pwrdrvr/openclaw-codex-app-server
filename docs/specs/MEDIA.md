# Media Into Codex and Across the OpenClaw Plugin Boundary

This document captures the current state of media handling relevant to this plugin:

- how Codex app-server accepts image input
- what this plugin currently sends
- what OpenClaw currently exposes to plugins
- the remaining gap for richer inbound media
- the staged-audio transcription bridge this plugin now supports
- a recommended bridge design for future implementation

This is a spec/notes document only. It does not imply that inbound media support has already been implemented here.

## Summary

- Codex app-server already supports multimodal turn input via `UserInput`.
- The supported image-shaped input items are remote/data URL images and local filesystem images.
- This plugin now supports mixed text + image turn input and forwards inbound image media into Codex when OpenClaw provides a staged media path or URL.
- This plugin can also transcribe staged inbound audio/voice attachments into plain text turn input when a local transcription command is configured.
- OpenClaw’s plugin SDK already supports outbound attachments from a plugin via `mediaUrl` and `mediaUrls`.
- OpenClaw’s plugin SDK still does not model inbound attachments as a first-class typed field on command or `inbound_claim` events.
- In practice, current `inbound_claim` hook metadata already carries `mediaPath` / `mediaType`, which is enough for this plugin to forward a staged inbound image.
- The same staged inbound path is also enough to transcribe audio before Codex sees the turn, as long as the plugin can execute an external transcription command against the staged file.
- The cleanest future bridge is: OpenClaw stages inbound files locally, then this plugin maps image paths to Codex `localImage` items.

## Codex App-Server Input Model

The app-server documents turn input as a list of discriminated `UserInput` items:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#L401-L417>

```md
- `{"type":"text","text":"Explain this diff"}`
- `{"type":"image","url":"https://…png"}`
- `{"type":"localImage","path":"/tmp/screenshot.png"}`
```

The v2 protocol schema matches that:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/UserInput.ts#L5-L10>

```ts
export type UserInput =
  | { "type": "text", text: string, text_elements: Array<TextElement>, }
  | { "type": "image", url: string, }
  | { "type": "localImage", path: string, }
  | { "type": "skill", name: string, path: string, }
  | { "type": "mention", name: string, path: string, };
```

The app-server maps those directly into Codex core input items:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2.rs#L3436-L3444>
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server/src/codex_message_processor.rs#L5551-L5556>

```rust
UserInput::Image { url } => CoreUserInput::Image { image_url: url },
UserInput::LocalImage { path } => CoreUserInput::LocalImage { path },
```

```rust
let mapped_items: Vec<CoreInputItem> = params
    .input
    .into_iter()
    .map(V2UserInput::into_core)
    .collect();
```

## What Codex Treats As an Image

There are two useful paths upstream:

- `image`: already-API-ready URL-like input
- `localImage`: a local file path that Codex reads and converts for the model

The protocol/model layer clearly accepts data URLs for `image` items:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs#L2084-L2101>

```rust
let image_url = "data:image/png;base64,abc".to_string();

let item = ResponseInputItem::from(vec![UserInput::Image {
    image_url: image_url.clone(),
}]);
```

For `localImage`, Codex reads the file and emits an `input_image` content item when valid:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs#L941-L958>

```rust
UserInput::LocalImage { path } => {
    image_index += 1;
    local_image_content_items_with_label_number(
        &path,
        Some(image_index),
        PromptImageMode::ResizeToFit,
    )
}
```

Codex also distinguishes replay-safe remote/data URLs from local image paths in history:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs#L1790-L1798>

```rust
/// Image URLs sourced from `UserInput::Image`. These are safe
/// to replay in legacy UI history events and correspond to images sent to
/// the model.
...
/// Local file paths sourced from `UserInput::LocalImage`. These are kept so
/// the UI can reattach images when editing history, and should not be sent
/// to the model or treated as API-ready URLs.
```

Implication:

- If the plugin has a durable absolute path to a staged image, `localImage` is the best fit.
- If the plugin only has a remote URL or data URL, `image` is the correct fit.

## Concrete Codex Request Shape

A future multimodal `turn/start` payload could look like this:

```json
{
  "method": "turn/start",
  "id": 30,
  "params": {
    "threadId": "thr_123",
    "input": [
      { "type": "text", "text": "Describe this screenshot", "text_elements": [] },
      { "type": "localImage", "path": "/absolute/path/to/screenshot.jpg" }
    ]
  }
}
```

Or, if only a URL/data URL is available:

```json
{
  "method": "turn/start",
  "id": 31,
  "params": {
    "threadId": "thr_123",
    "input": [
      { "type": "text", "text": "What is in this image?", "text_elements": [] },
      { "type": "image", "url": "data:image/jpeg;base64,..." }
    ]
  }
}
```

## Current State In This Plugin

This plugin now builds multimodal turn input when image media is available:

Source:
- [`src/client.ts`](../../src/client.ts)

```ts
function buildTurnInput(prompt: string, input?: readonly CodexTurnInputItem[]) {
  if (input?.length) {
    return input.map((item) => ({ ...item }));
  }
  return [{ type: "text", text: prompt }];
}
```

That means:

- text-only turns still work as before
- mixed text + image turns can be forwarded into Codex
- image-only inbound turns can be forwarded into Codex
- audio-only inbound turns can be converted into transcript text before the turn starts when `inboundAudioTranscription` is configured
- mixed caption + audio inbound turns can keep the original text and append a labeled transcript block
- staged text attachments such as `.txt`, `.md`, `.json`, `.yaml`, and `.yml` can be read and forwarded as additional `text` items
- unsupported binary non-image inbound media is still ignored for now unless a future bridge teaches the plugin how to reinterpret it

## Inbound Audio Transcription Bridge

The plugin does not send raw audio into Codex. Instead, it can optionally reinterpret staged audio files as text by invoking a configurable local command.

Configuration shape:

```json
{
  "inboundAudioTranscription": {
    "enabled": true,
    "command": "/path/to/transcribe",
    "args": ["{path}"],
    "timeoutMs": 20000
  }
}
```

Behavior:

- The command receives the staged media path either through an explicit `{path}` placeholder or as an appended trailing argument.
- Optional placeholders `{mimeType}` and `{fileName}` are available for wrappers that need them.
- The command should print the transcript to stdout.
- If stdout is JSON, the plugin uses `.text` first and then `.transcript`.
- On transcription failure or timeout, the plugin logs the failure and falls back to the previous behavior instead of crashing the inbound turn.

This keeps the bridge generic:

- no hard dependency on a specific speech-to-text engine
- no plugin-side audio decoding logic
- no transport-specific behavior baked into the Codex turn layer

## OpenClaw Plugin SDK: Outbound Media

Outbound media from a plugin is already supported by the plugin SDK.

Local SDK surface in this repo:
- [`src/openclaw-plugin-sdk.d.ts`](../../src/openclaw-plugin-sdk.d.ts)

Relevant fields:

```ts
export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  ...
};
```

```ts
sendMessageTelegram(..., opts?: {
  ...
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  ...
})
```

```ts
sendMessageDiscord(..., opts?: {
  ...
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
})
```

This plugin already uses that path for plan attachments and whitelists local roots when the attachment is a local file:

Source:
- [`src/controller.ts`](../../src/controller.ts)

```ts
const mediaLocalRoots = this.resolveReplyMediaLocalRoots(payload.mediaUrl);
...
mediaUrl: payload.mediaUrl,
mediaLocalRoots,
```

The local-root helper is specifically designed for local files:

```ts
const localPath = rawValue.startsWith("file://") ? fileURLToPath(rawValue) : rawValue;
if (!path.isAbsolute(localPath)) {
  return undefined;
}
const roots = new Set<string>([this.api.runtime.state.resolveStateDir(), path.dirname(localPath)]);
```

Implication:

- plugin-to-channel media delivery already exists
- local files are already a first-class concept on the outbound side

## OpenClaw Plugin SDK: Inbound Media Gap

The command and hook surfaces available to plugins do not currently expose inbound attachments.

The command context has no media or attachment fields:

Source:
- `openclaw/openclaw`: <https://github.com/openclaw/openclaw/blob/main/src/plugins/types.ts#L915-L941>
- [`src/openclaw-plugin-sdk.d.ts`](../../src/openclaw-plugin-sdk.d.ts)

```ts
export type PluginCommandContext = {
  senderId?: string;
  channel: string;
  ...
  args?: string;
  commandBody: string;
  ...
  messageThreadId?: number;
}
```

The `inbound_claim` hook event also has no attachment/media fields:

Source:
- `openclaw/openclaw`: <https://github.com/openclaw/openclaw/blob/main/src/plugins/types.ts#L1583-L1599>

```ts
export type PluginHookInboundClaimEvent = {
  content: string;
  body?: string;
  bodyForAgent?: string;
  transcript?: string;
  ...
  metadata?: Record<string, unknown>;
};
```

So, from the plugin’s point of view today:

- outbound attachments are supported
- inbound attachments are still not modeled as first-class typed plugin input
- `inbound_claim` metadata does already carry `mediaPath` / `mediaType`, so the plugin can use that best-effort bridge for inbound image forwarding
- command handlers still cannot rely on a first-class structured image field from OpenClaw

## OpenClaw Gateway Already Has Attachment Logic

Outside the plugin SDK, OpenClaw already knows how to normalize inbound `attachments[]` and turn image attachments into structured image content.

Gateway RPC methods accept attachment objects with `type`, `mimeType`, `fileName`, and `content`:

Source:
- `openclaw/openclaw`: <https://github.com/openclaw/openclaw/blob/main/src/gateway/server-methods/agent.ts#L173-L180>

```ts
attachments?: Array<{
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
}>;
```

Those attachments are normalized into base64-bearing records:

Source:
- `openclaw/openclaw`: <https://github.com/openclaw/openclaw/blob/main/src/gateway/server-methods/attachment-normalize.ts#L6-L22>

```ts
export type RpcAttachmentInput = {
  type?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
  content?: unknown;
};
```

```ts
content:
  typeof a?.content === "string"
    ? a.content
    : ArrayBuffer.isView(a?.content)
      ? Buffer.from(...).toString("base64")
      : a?.content instanceof ArrayBuffer
        ? Buffer.from(a.content).toString("base64")
        : undefined,
```

Then image attachments are parsed and kept only if they are valid images:

Source:
- `openclaw/openclaw`: <https://github.com/openclaw/openclaw/blob/main/src/gateway/chat-attachments.ts#L93-L133>

```ts
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  ...
): Promise<ParsedMessageWithImages> {
  ...
  images.push({
    type: "image",
    data: b64,
    mimeType: sniffedMime ?? providedMime ?? mime,
  });
}
```

Implication:

- OpenClaw already has the raw material needed to support plugin inbound media
- the missing piece is the plugin boundary, not basic attachment parsing

## Recommended Bridge Design

Preferred design:

1. OpenClaw stages inbound attachments to local files before invoking a plugin command or `inbound_claim`.
2. The plugin SDK exposes those staged files as structured media entries.
3. This plugin maps image entries with absolute local paths to Codex `localImage`.
4. The user’s text stays as the normal `text` input item.

Recommended plugin-facing shape:

```ts
type PluginInboundMedia = {
  kind: "image" | "audio" | "video" | "document";
  path?: string;
  url?: string;
  mimeType?: string;
  fileName?: string;
  source?: "attachment" | "staged" | "remote";
};
```

Where to expose it:

- `PluginCommandContext.media?: PluginInboundMedia[]`
- `PluginHookInboundClaimEvent.media?: PluginInboundMedia[]`

Mapping rules for this plugin:

- If `kind === "image"` and `path` is an absolute local file path, emit `{ type: "localImage", path }`.
- Else if `kind === "image"` and `url` is present, emit `{ type: "image", url }`.
- Else ignore for Codex turn input and keep only the text path/reference in chat.

Why prefer `localImage` over base64/data URLs:

- avoids large JSON-RPC payloads
- avoids needless base64 inflation
- matches Codex’s intended local-file path
- preserves better provenance for debug and history

## Acceptable Fallbacks

If a staged local path is not available, these fallback strategies are still technically compatible with Codex:

- remote HTTPS URL via `UserInput::Image`
- data URL via `UserInput::Image`

But those are worse defaults than `localImage` for channel-originated attachments.

## What Needs To Change Here

Within this repository, future media support would require at least:

- extending turn-input construction in [`src/client.ts`](../../src/client.ts) to accept non-text `UserInput` items
- extending the controller/request path to receive structured inbound media from OpenClaw
- tests covering:
  - local image path -> `localImage`
  - remote/data URL image -> `image`
  - mixed text + image turn input
  - text attachments read and forwarded as `text`
  - unsupported binary attachments ignored or downgraded to text references

The remaining practical boundary is:

- Codex app-server already supports images plus ordinary text items
- OpenClaw already supports outbound attachments from plugins
- this plugin can now turn staged inbound images into Codex image input and staged inbound text files into Codex text input
- richer binary formats such as PDF, audio, and video still need preprocessing before they can be meaningfully sent to Codex
