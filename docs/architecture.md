# Architecture

## Core

`core` is responsible for:

- reading config
- choosing which channel / runtime / integrations to use
- orchestrating capabilities instead of implementing concrete protocols

## Channel Adapters

`adapters/channel/*`

Responsible for:

- receiving messages
- sending messages
- typing / media / context token handling

Not responsible for:

- Codex / Claude Code thread logic
- reminder / timeline / diary logic

## Runtime Adapters

`adapters/runtime/*`

Responsible for:

- sending messages into the specific agent runtime
- handling thread / session / approval / stop

Not responsible for:

- WeChat protocol details
- timeline UI

## Capability Integrations

`integrations/*`

Examples:

- `timeline`
- `reminder`
- `diary`

These capabilities should depend on external standalone projects whenever possible, instead of being folded back into the main repository.

## Expected External Dependencies

- timeline:
  - `timeline-for-agent`
- weixin bridge:
  - to be split into a standalone adapter
- codex runtime:
  - to be split into a standalone adapter
# Qoder runtime

`CYBERBOSS_RUNTIME=qoder` selects the independent Qoder CLI process adapter. It spawns one bounded headless turn per message, sends the prompt on stdin, and accepts only the successful nonempty `result` event after a zero exit code. The returned Qoder session ID is stored through `SessionStore(runtimeId="qoder")` for the current account, sender, and workspace; subsequent turns use `--resume`. The existing WeChat poller, turn gate, stream delivery, and system JSON dispatcher remain in charge. Qoder's built-in tools and external MCP servers are disabled in this text preview. There is no attachable local TUI for a running WeChat turn.
