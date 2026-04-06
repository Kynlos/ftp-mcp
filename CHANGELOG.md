# Changelog

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
