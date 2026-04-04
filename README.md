# ftp-mcp

An enterprise-grade Model Context Protocol (MCP) server providing sophisticated FTP and SFTP operations optimized specifically for AI coding assistants. Features smart synchronization, connection pooling, directory caching, unified diff patching, and comprehensive security controls.

## Features

- **Connection Pooling & Caching**: Sustains underlying connections across tool calls and leverages strict memory caching with smart aggressive invalidation for extreme sub-15ms performance.
- **AI-Optimized Tooling**: Implements chunking (`startLine`/`endLine`) for huge files, cursor-paginated `limit` bounds for vast directories, and `diff`-based local file morphing native to FTP without pulling heavy files.
- **Security & Authorization**: Native support for SSH Key exchanges (both direct and Agent-forwarding), Pass-phrase authentication, and explicit `readOnly: true` config profiling to sandbox dangerous modifications.
- **Smart Directory Syncing**: Deep hash-and-size sync algorithms for minimal network payload deployments, complete with `--dryRun` toggling that logs differences back to the LLM without modifying live directories.
- **Git & Node Aware**: Automatically unpacks `.gitignore` and `.ftpignore` environments. Semantically evaluates `package.json` for smart context summarization.
- **Interactive Initializer**: Simple scaffolding of configurations natively via the CLI.
- **Audit Logging**: Robust instrumentation generating structured `.ftp-mcp-audit.log` traces on all filesystem mutations.
- **Comprehensive E2E Testing**: Guaranteed operational functionality validated continuously by Node-based MCP IO test orchestration.

## Quick Start

### 1. Install & Initialize

Run this in your target project directory to scaffold the configuration securely:

```bash
npx ftp-mcp --init
```

This will run an interactive initialization wizard dropping a `.ftpconfig` instance natively into your working directory. Then install the package globally so your MCP client can access it universally:

```bash
npm install -g ftp-mcp
```

### 2. Configure Credentials

**Option A: Project Config File (Recommended)**

Your `.ftpconfig` can hold dozens of isolated environments.

```json
{
  "production": {
    "host": "ftp.example.com",
    "user": "prod-user",
    "password": "your-password",
    "port": 21,
    "secure": false,
    "readOnly": true
  },
  "staging": {
    "host": "sftp://staging.example.com",
    "user": "staging-user",
    "privateKey": "./keys/id_rsa",
    "passphrase": "my-secure-key",
    "port": 22
  },
  "default": {
    "host": "ftp.mysite.com",
    "user": "default-user",
    "password": "your-password"
  }
}
```

The server automatically identifies `.ftpconfig` relative to your execution layer and falls back to environment properties.

**Option B: Environment Variables**

**Required:**
```bash
# Windows
setx FTPMCP_HOST "ftp.example.com"
setx FTPMCP_USER "username"
setx FTPMCP_PASSWORD "password"

# Linux/Mac
export FTPMCP_HOST="ftp.example.com"
export FTPMCP_USER="username"
export FTPMCP_PASSWORD="password"
```

**Advanced SFTP Keys:**
```bash
export FTPMCP_PRIVATE_KEY="/path/to/id_rsa"
export FTPMCP_PASSPHRASE="optional-phrase"
export FTPMCP_AGENT="pageant"
```

### 3. Client Integration

Register the MCP server directly to your AI Code Editor (Cursor, VSCode with Roo, Windsurf, or Amplitude).

Example integration:
- **Command:** `npx`
- **Arguments:** `-y ftp-mcp`

## Advanced AI Operations

### Memory Auto-Chunking
When navigating large remote codebases, AI assistants conventionally hit token-overflow limits. `ftp_get_contents` supports `startLine` and `endLine` parameters. `ftp-mcp` intercepts the inbound download stream at the bytecode layer and cleanly drops data outside your strict index bounds, returning only the exact lines requested without destroying context.

### Unified Diff Patching
Instead of requesting a 5,000-line remote file, making a 2-line edit locally, and pushing the huge file back, `ftp-mcp` exposes an `ftp_patch_file` command. Simply provide a standard Unified Diff `patch` string, and `ftp-mcp` will read the live destination, map diff logic, and commit the modification directly over SCP.

### Semantic Workspace Analysis
Calling `ftp_analyze_workspace` will traverse the remote filesystem natively investigating configurations (`package.json`, `composer.json`). It will evaluate structure patterns and package dependencies, instantly reporting exact context of the remote language mapping (e.g. "Node.js Environment operating React mapping to Express").

### Strict Safe-Mode Execution
Set `"readOnly": true` in any `.ftpconfig` profile. AI interactions over `ftp_delete`, `ftp_patch_file`, `ftp_put_contents`, or `ftp_sync(direction: "upload")` will immediately halt with a standardized sandbox violation, keeping production environments entirely safe from hallucinated tool executions.

### Smart Sync Generation
Deploy environments utilizing deep comparison trees via `ftp_sync`. 

- Use `dryRun: true` to have the system safely evaluate the entire sync matrix, printing standard output natively to the context console reporting exactly what logic *would* have executed.
- `ftp_sync` deeply integrates with standard `.gitignore` indexing and custom `.ftpignore` pattern files perfectly out-of-the-box.

## Complete Tool Reference

### Connection Management
- `ftp_connect`: Switch between named FTP profiles.

### File Content Operations
- `ftp_get_contents`: Read file content directly from the server utilizing paginated line extraction.
- `ftp_put_contents`: Write content directly to a remote file.
- `ftp_patch_file`: Apply unified diff modifications cleanly over the network.
- `ftp_summarize_file`: Generates token-light structural signatures representing the files contents natively.

### Metadata & File Information
- `ftp_stat`: Get detailed metadata regarding permissions, bytes, and modification arrays.
- `ftp_exists`: Conditional logic pipeline for execution paths without traversing subdirectories.
- `ftp_disk_space`: System OS level free-byte parsing (SFTP ONLY).
- `ftp_analyze_workspace`: Pull complex semantic environments based on workspace root configuration definitions.

### Directory Operations
- `ftp_list`: List all files/directories subject to `limit` and `offset` token bounding rules.
- `ftp_tree`: Build full recursive maps.
- `ftp_search`: Target files by wildcard properties instantly down the document tree.
- `ftp_mkdir` / `ftp_rmdir`: Folder creation and complex recursive destruction commands.

### File Transfer
- `ftp_upload` / `ftp_download`: Strict file 1-to-1 transports.
- `ftp_batch_upload` / `ftp_batch_download`: Multi-mapped array uploads avoiding multi-tool overhead.
- `ftp_sync`: Advanced deep-logic size-tree mappings dropping into deployment synchronization pools.

### File Management
- `ftp_delete`: Drop target properties.
- `ftp_copy`: OS level SSH file duplications ignoring massive TCP IO transport arrays.
- `ftp_rename`: Target displacement mappings.
- `ftp_chmod`: OS level Permission flags executing bit-mask rules natively on SFTP sockets.

## Architecture Guidelines

- Audit Logging is continuously enabled. Ensure the terminal running the MCP protocol maintains structural write-permissions to the local project deployment folder.
- Ensure any `currentConfig` caching resets are tied exclusively to `ftp_connect` profile pivoting.

## License

[MIT](LICENSE)

**Author:** [Kynlo Akari](https://github.com/Kynlos/)
