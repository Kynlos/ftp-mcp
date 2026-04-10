# FTP-MCP Tooling Audit Report (Post-v1.5.2)

## Context
Following the discovery that `basic-ftp`'s `ensureDir()` silently mutates the Current Working Directory (CWD), we successfully hardened `ftp_sync`, `ftp_mkdir`, and `ftp_upload`. This audit investigates if other tools share this vulnerability or lack necessary "quality-of-life" features (like auto-parent directory creation) that were omitted because of the hidden risk.

## [CRITICAL] Tools Lacking Auto-Directory Creation
While `ftp_upload` now auto-creates folders safely, several other write-focused tools **completely lack** parental directory creation. If an agent tries to use these tools on a path where the parent folder doesn't exist, they will fail with a `550` error.

### 1. `ftp_put_contents`
- **Issue**: Lacks `ensureDir`.
- **Impact**: Agents often try to "Write this new config to /config/production.json". If `/config` doesn't exist, this tool fails.
- **Remediation Needed**: Needs the `ensureDir` + `cd(initialPwd)` pattern.

### 2. `ftp_patch_file`
- **Issue**: Lacks directory safety for backups.
- **Impact**: If `createBackup: true` is set, and the backup path is non-standard or in a nested folder, it may fail.
- **Remediation Needed**: Needs directory protection.

### 3. `ftp_batch_upload`
- **Issue**: **Dangerous Omission**.
- **Impact**: This tool iterates through a list of files. It performs NO directory checks. If a user tries to batch-deploy a new structure, every individual file upload will fail because their parents aren't being prepared.

---

## [SAFE] Stateless Tools
The following tools were audited and found to be safe from CWD-state mutation because they either leverage `sftp` (which is stateless) or use `basic-ftp` methods that do not implicitly `CWD`.

| Tool | Status | Logic Check |
| :--- | :--- | :--- |
| `ftp_tree` | ✅ Safe | Uses `getTreeRecursive` -> `client.list(path)`. No `CWD` calls. |
| `ftp_search` | ✅ Safe | Uses cached Tree or triggers `getTreeRecursive`. No state mutation. |
| `ftp_analyze_workspace` | ✅ Safe | Uses `client.list(path)` for discovery. |
| `ftp_download` | ✅ Safe | Downloads usually provide full paths; `basic-ftp`'s `downloadTo` is stateless. |
| `ftp_delete` / `ftp_rmdir` | ✅ Safe | Uses `remove` / `removeDir` which are absolute/relative path safe. |

---

## 🔧 Architectural Recommendation (Internal)

To prevent this from ever happening again, we should move the "Safely Ensure Directory" logic into a shared utility function.

```javascript
/**
 * Proposed Shared Utility
 * Safely creates a path and returns to origin PWD
 */
async function safeEnsureDir(client, path) {
  if (client._isSFTP) {
     return await client.mkdir(path, true);
  }
  await client.ensureDir(path);
  if (client._initialPwd) {
     await client.cd(client._initialPwd);
  }
}
```

### Why did tests pass?
1. **Mock Fidelity**: Our test suite likely uses `ftp-srv` or a mock client that doesn't simulate the implicit `CWD` shift of `basic-ftp`'s `ensureDir` implementation.
2. **Pathing Assumptions**: Most tests use flat structures (e.g., `test.txt` in root), avoiding the recursive parent-creation paths where the bug lives.
3. **SFTP Preference**: If tests ran primarily over SFTP (as it's faster for local testing), they would never see this, as SFTP is fundamentally stateless.

---

> [!IMPORTANT]
> **No changes have been made to the code.** This document is for evaluation only.
