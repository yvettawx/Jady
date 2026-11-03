//! The Claude Code launch flags, in one place.
//!
//! This is the flag set recommended by the P0-14 spike
//! (`docs/spikes/05-claude-code-mcp.md`, "推荐给 P3 的启动参数", verified with
//! Claude Code 2.1.302). Overlaps are intentional (defense in depth): if one flag
//! changes behavior in a new Claude Code version, another still holds. P3 moves
//! this into `dem-ai-provider`; until then the regression runner is its only user.

use std::path::Path;

/// MCP server name of the DEM gateway in the generated MCP config.
pub const GATEWAY_SERVER: &str = "dem";

/// Gateway tools the session may call (full MCP names).
pub const GATEWAY_TOOLS: [&str; 3] = [
    "mcp__dem__search",
    "mcp__dem__read_item",
    "mcp__dem__propose_changes",
];

/// Web tools, available only in normal (not sensitive) sessions.
pub const WEB_TOOLS: [&str; 2] = ["WebSearch", "WebFetch"];

/// Built-in tools denied as a second line of defense (unknown names are harmless).
pub const DENY_BUILTINS: [&str; 24] = [
    "Bash",
    "PowerShell",
    "Monitor",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "NotebookRead",
    "Glob",
    "Grep",
    "LS",
    "Agent",
    "Task",
    "TaskCreate",
    "TodoWrite",
    "Skill",
    "SlashCommand",
    "ToolSearch",
    "LSP",
    "Workflow",
    "CronCreate",
    "RemoteTrigger",
    "ExitPlanMode",
];

/// WebFetch must not reach services on this machine.
pub const WEBFETCH_DENY_LOCAL: [&str; 6] = [
    "WebFetch(domain:localhost)",
    "WebFetch(domain:*.localhost)",
    "WebFetch(domain:127.0.0.1)",
    "WebFetch(domain:[::1])",
    "WebFetch(domain:0.0.0.0)",
    "WebFetch(domain:*.local)",
];

/// System prompt for regression runs (the product supplies its own in P3).
pub const SYSTEM_PROMPT: &str = "You are the AI assistant inside DEM, the user's personal, local-first knowledge app. \
You can reach the user's data only through the dem MCP tools (search, read_item, propose_changes). \
You cannot change data directly: every edit is a proposal that the user reviews. \
You have no shell and no file access. Answer concisely.";

/// Environment variables set for every launch.
pub const ENV: [(&str, &str); 1] = [("ENABLE_CLAUDEAI_MCP_SERVERS", "false")];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    /// Ordinary session: gateway tools plus web search and fetch.
    Normal,
    /// Authorized to read sensitive items: gateway tools only, no web at all.
    Sensitive,
}

/// Settings passed with `--settings`. Command-line settings rank above project
/// settings, so a planted project file cannot turn hooks back on.
pub fn settings_json() -> String {
    serde_json::json!({
        "disableAllHooks": true,
        "autoMemoryEnabled": false,
        "disableClaudeAiConnectors": true,
        "enableAllProjectMcpServers": false
    })
    .to_string()
}

/// Tools the session may use at all; anything else in a transcript is a failure.
pub fn allowed_tools(kind: SessionKind) -> Vec<&'static str> {
    let mut v = GATEWAY_TOOLS.to_vec();
    if kind == SessionKind::Normal {
        v.extend(WEB_TOOLS);
    }
    v
}

/// The complete argument list after the `claude` executable.
pub fn claude_args(
    kind: SessionKind,
    mcp_config: &Path,
    model: &str,
    max_turns: u32,
) -> Vec<String> {
    let allow = allowed_tools(kind);
    let mut deny: Vec<&str> = DENY_BUILTINS.to_vec();
    let tools = match kind {
        SessionKind::Normal => {
            deny.extend(WEBFETCH_DENY_LOCAL);
            WEB_TOOLS.join(",")
        }
        SessionKind::Sensitive => {
            deny.extend(WEB_TOOLS);
            String::new()
        }
    };
    let mcp = mcp_config.display().to_string();
    let settings = settings_json();
    let max_turns = max_turns.to_string();
    let allow = allow.join(",");
    let deny = deny.join(",");
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        &mcp,
        "--settings",
        &settings,
        "--disable-slash-commands",
        "--system-prompt",
        SYSTEM_PROMPT,
        "--tools",
        &tools,
        "--allowedTools",
        &allow,
        "--disallowedTools",
        &deny,
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--no-session-persistence",
        "--model",
        model,
        "--max-turns",
        &max_turns,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Value following `flag` in an argument list.
pub fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

/// Shell-quoted command line, for the dry-run plan.
pub fn shell_line(bin: &str, args: &[String]) -> String {
    let quote = |s: &str| {
        if !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./:=,@".contains(c))
        {
            s.to_string()
        } else {
            format!("'{}'", s.replace('\'', r"'\''"))
        }
    };
    std::iter::once(bin)
        .chain(args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_value_finds_empty_values() {
        let a = claude_args(SessionKind::Sensitive, Path::new("/m.json"), "haiku", 3);
        assert_eq!(flag_value(&a, "--tools"), Some(""));
        assert_eq!(flag_value(&a, "--setting-sources"), Some(""));
        assert_eq!(flag_value(&a, "--max-turns"), Some("3"));
    }

    #[test]
    fn shell_line_quotes_spaces_and_empty_strings() {
        let line = shell_line("claude", &["--tools".into(), String::new(), "a b".into()]);
        assert_eq!(line, "claude --tools '' 'a b'");
    }
}
