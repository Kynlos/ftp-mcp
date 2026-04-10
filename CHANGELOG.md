# Changelog

## [1.5.2] - 2026-04-10

### Fixed
- **Infinite Recursion / CWD State Leak**: Fixed a critical bug in `basic-ftp` during live syncing where automatic directory creation (`ensureDir`) heavily mutated the Current Working Directory (CWD). Operations like `ftp_sync` and `ftp_upload` now actively preserve and reset to the initial remote directory context directly after folder creation, completely stopping multi-layered infinite nesting issues.
- **Cache Invalidation**: Fixed a bug where dynamic exclusion patterns (e.g. anti-recursion blocks dynamically applied during syncs) were not forcing a minimatch cache refresh, leading to missed ignores.

## [1.5.1] - 2026-04-09

### Added
- **Native MCP Prompts**: Structured prompts like `audit-project` and `deploy-checklist` for guided agentic workflows.
- **Resource Templates**: Dynamic access to remote files via `mcp://remote-file/{path}`, allowing agents to "read" files natively as MCP resources.
- **Operational Transparency**: Real-time server logging for connection pooling events and detailed progress tracking (0-100%) for bulk operations like `ftp_sync`, `ftp_batch_upload`, and `ftp_batch_download`.

### Security
- **Resource Guarding**: Integrated `PolicyEngine` and path-traversal protection into resource template resolution.

### Fixed
- **Connection Reliability**: Resolved a resource leak in the resource handler and optimized connection pool performance under high-concurrency scenarios.

## [1.4.0] - 2026-04-09

### Added
- **AI-First Semantic Markers**: Directory and file listings now include high-signal icons (📂, 📄) and attention markers (📦 for config, ⚙️ for manifests, 🔒 for secrets, 🕰️ for backups), optimized for AI scanning.
- **Context-Aware AI Suggestions**: Main tool error handler and specific tools now provide proactive troubleshooting hints with backticked command examples (e.g., [AI: Path not found. Suggested fix: `ftp_list "."`]).
- **Session-Aware Hinting**: Agents are now proactively guided on their first connection to perform a workspace analysis, reducing onboarding friction.
- **New MCP Resource**: `mcp://instruction/server-state` — A dynamic resource that agents can pull on-demand to see internal server state, connection protocol, and security constraints without cluttering tool outputs.

### Changed
- **Token Optimization**: Tool outputs have been redesigned to balance high-signal clarity with token efficiency, ensuring agents have more relevant context space.

## [1.3.1] - 2026-04-09

### Added
- **AI-Guided Initialization Track**: New `--init` wizard option designed for AI agents, providing verbose instruction context and fresh "memory" of server capabilities.

### Fixed
- **Wizard Crash**: Resolved a `TypeError` in `@clack/prompts` validation where empty input could cause a crash.
- **Port Validation**: Added numeric validation for custom port entry in the setup wizard.
- **Cancellation Logic**: Fixed missing process exits when cancelling at certain setup steps.

## [1.3.0] - 2026-04-09

### Security

- **Fixed critical path traversal in `ftp_download`** — Local destination paths are now validated against traversal sequences (`../`) before any file is written. Arbitrary local file writes via AI-supplied paths are no longer possible.
- **Fixed critical path traversal in `ftp_batch_download`** — Same protection applied per-item across the entire batch. Invalid items fail gracefully without blocking valid ones.
- **Fixed critical arbitrary file read in `ftp_upload` and `ftp_batch_upload`** — Source paths are now validated before reading. Files outside the working context (e.g. `/etc/shadow`) cannot be exfiltrated to a remote server via path manipulation.
- **Fixed ReDoS vulnerability in `ftp_search`** — User-supplied `pattern` and `contentPattern` values are now validated through a safe regex compiler that enforces a 250-character length limit and wraps `new RegExp()` in a try/catch. Malformed or catastrophically backtracking patterns return a clean error instead of freezing the server.
- **`ftp_batch_upload` now enforces all security controls** — Previously, batch uploads bypassed secret file detection, policy engine validation (allowed paths, blocked globs, max file size), and snapshot creation. All three guards are now applied per-file, consistent with single-file `ftp_upload`.
- **`ftp_batch_download` now enforces path validation** — Path traversal check applied per-item, consistent with `ftp_download`.

### Bug Fixes

- **Fixed `ftp_deploy` corrupting global connection state** — Previously, deploying via a named profile would overwrite the module-level `currentConfig` and `currentProfile` globals, causing subsequent tool calls to operate against the deploy target instead of the user's active connection. Deploy now uses a locally-scoped config throughout.
- **Fixed `ftp_stat` and `ftp_exists` shadowing the `path` module** — `const { path }` destructuring inside these handlers shadowed the Node.js `path` import. Renamed to `filePath` to eliminate the risk of silent method resolution errors.
- **Fixed `ftp_rmdir` using deprecated `send("RMD")` call** — Now correctly uses `client.removeEmptyDir()` from the `basic-ftp` API for non-recursive directory removal.
- **Fixed `isSFTP()` misidentifying hostnames containing "sftp"** — A hostname like `mysftp-server.com` was incorrectly treated as an SFTP connection. Detection now exclusively checks for the `sftp://` protocol prefix.
- **Fixed `parseInt` calls missing explicit radix** — `getPort()` now uses `parseInt(port, 10)` to prevent octal misinterpretation in edge cases.
- **Fixed `ftp_chmod` passing mode as a string** — Mode is now parsed as an octal integer with `parseInt(mode, 8)` and validated before being passed to the SFTP client. Invalid values (`"abc"`, `"9999"`) return a descriptive error.
- **Fixed `ftp_sync` schema advertising unimplemented directions** — The `direction` enum previously listed `download` and `both`, which were silent no-ops. The schema now only advertises `upload`, which is the implemented direction.
- **Removed sensitive test fixture from repository** — `Test/.ftpconfig` contained dummy credentials and has been removed. The test suite generates its own temporary config at runtime.
- **Fixed no-op readOnly test** — The readOnly E2E test previously passed immediately with `return true` without testing anything. It is now correctly marked as `test.skip` with a documented explanation.

### Improvements

- **Added safety guard on destructive remote operations** — `ftp_delete` and `ftp_rmdir` now refuse to operate on root-level paths (`/`) and well-known system directories (`/etc`, `/bin`, `/usr`, `/var`, etc.), preventing accidental or malicious mass deletion.
- **Added policy validation to `ftp_copy`** — Source and destination paths are now validated against the active policy engine before a copy proceeds.
- **Added graceful shutdown handler** — The server now listens for `SIGINT` and `SIGTERM` and cleanly closes all pooled FTP/SFTP connections before exiting, preventing dangling sockets.
- **Server version now read from `package.json` dynamically** — The MCP protocol handshake version is no longer hardcoded. It is read from `package.json` at startup, ensuring it always matches the published version.
- **Audit log failures now visible** — Previously, failures to write the audit log were silently swallowed. They now emit a warning to `stderr`.
- **dirCache now evicts stale entries** — The directory listing cache previously grew without bound. Entries older than the TTL are now deleted on every read miss and on every write, keeping memory usage proportional to active paths.
- **Snapshots auto-pruned to 50 entries** — Every `createSnapshot()` call now triggers a cleanup sweep that removes snapshots beyond the most recent 50, preventing unbounded disk growth in `.ftp-mcp-snapshots/`.
- **SHA-256 replaces MD5 for all integrity hashing** — File content hashes in the sync manifest and snapshot path names now use SHA-256 (64-char hex) instead of MD5 (32-char hex), eliminating the theoretical collision risk in snapshot naming.
- **`ftp_connect` now verifies credentials at connect time** — A real `list('.')` test is performed immediately after loading config. Incorrect credentials now fail at `ftp_connect` rather than silently at the next tool call.

### Tests

- Added `Test/security.test.js` with **36 new tests** covering all security fixes, code quality improvements, and edge cases including partial batch failures, regex validation, snapshot pruning, and SHA-256 verification.
- Total test suite: **3 files · 67 passing · 1 skipped**

---

## [1.2.2] - 2026-04-06


### Security
- **Fixed path traversal vulnerability** in `PolicyEngine.checkAllowedPath` — `/var/www` no longer matches `/var/www-evil`
- **Fixed `--init` crash on user cancel** — Clack prompt cancellation no longer throws on `Symbol` type

### Bug Fixes
- **Fixed sync manifest never persisting** — `syncManifestManager.save()` was dead code due to a flag check that always evaluated false. Manifest-based sync optimization now works correctly
- **Fixed `ftp_rmdir` non-recursive deleting files instead of directories** — FTP mode now uses the correct `RMD` command instead of `DELE`
- **Fixed intermittent false negatives in content search** — Removed stateful `g` flag from regex used with `.test()`, eliminating `lastIndex` drift across lines
- **Fixed `ftp_deploy` and `ftp_list_deployments` ignoring `FTP_CONFIG_PATH` env var** — Both now use the shared `CONFIG_FILE` constant instead of hardcoded paths
- **Removed redundant SFTP/FTP ternary branches** — Eliminated identical conditional branches in `ftp_list`, `ftp_search`, `ftp_stat`, and `ftp_rename`

### Performance
- **Reduced sync delay from 250ms to 50ms** — Socket stabilization delay now only applies to FTP (not SFTP) connections, cutting sync time by ~80% for SFTP users
