// Side-effect module. Imported first by the MCP server so the logger writes to stderr:
// on a stdio transport, stdout carries the protocol and any stray log line would corrupt it.
process.env.LOG_TO_STDERR = '1';
