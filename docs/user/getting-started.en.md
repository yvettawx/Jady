# Getting started

## First launch

1. **Create a library**: choose a location and a master password. If you forget the password, only the recovery code can get you back in, so keep it somewhere safe.
2. **Follow the guide**: choose a language, connect an AI, pick what to start with. Every step can be skipped and changed later in Settings.

Already using it on another computer? Choose "Join from another computer"; see Sync below.

## Writing things down

- `⌘K` finds content and runs commands. When in doubt, press it first.
- `⌥⌘N` captures a thought from anywhere. It lands in the inbox.
- The leftmost bar holds the views: Today, Tree, Search, Inbox, To-dos, Learn, Life, AI.
- Everything has one of four privacy levels: normal, sensitive, private, confidential. The level decides what AI can see.

## AI

Choose how to connect in Settings › AI. Every way uses your own account:

- **Run Claude Code**: sign in within Claude Code first. The app only runs it and never touches your login.
- **Run Codex**: run `codex login` in a terminal first. As with Claude Code, the app only runs it.
- **Anthropic API key**: enter your own key. It is stored only in the system keychain.
- **OpenAI-compatible endpoint**: DeepSeek, Ollama, LM Studio and the like. Enter the address and model name, and a key if the service needs one. No web access this way.

What AI can see:

| Level | AI |
| --- | --- |
| Normal | Yes |
| Sensitive | Only in a session you authorise, and it cannot go online during that session |
| Private, confidential, password vault | Never |

When AI wants to change something that exists, the change waits in Proposals for your decision. Everything else works without AI.

## Life

Add Habits, Books and films, Money or Trips in Settings › Templates. They are just content types, and you can change them.

Under Life on the left you also get a calendar, timeline, connections graph, map, balance wheel and whiteboards. The map works offline: give a place a latitude and longitude and it appears.

## Password vault

The vault has its own password, separate from the library's, and no recovery code: forget it and nothing can open the vault. It locks after 5 minutes without use, and a copied password leaves the clipboard after 30 seconds.

## Sync between computers

Files are encrypted before they leave your computer. The storage cannot read them; it sees only how many there are, their sizes and times.

**With a folder**: choose one in Settings › Sync, such as a folder in iCloud Drive or Dropbox. On the other computer, choose "Join from another computer", pick the same folder and enter the master password.

**With your own server**: see [sync-server.md](sync-server.md).

Offline edits merge at the next sync. If both sides changed the same field, the later one wins and the earlier value stays in the history.

## Backup and export

Settings › Library exports everything as plain Markdown and JSON, readable without this app. Each type gets a folder, each file is named by its title, and images and files sit beside them in `attachments`, so the export opens as an Obsidian vault with its `[[links]]` working. The password vault is not included; it has its own export, in plain text, which you should delete after use.
