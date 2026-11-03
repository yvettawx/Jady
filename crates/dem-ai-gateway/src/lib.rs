//! The AI gateway (M6): AI reaches the library only through this. It serves the tools from
//! `dem_core::ai_tools` over MCP on a local socket: no TCP port, a one-time token, same user only.

pub mod mcp;
pub mod prompts;
pub mod shim;

pub use mcp::{AppTools, GatewayServer, SharedAppTools, ToolEvents, all_tools};
pub use prompts::{Mode, system_prompt};
