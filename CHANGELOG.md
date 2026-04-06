# Changelog

## [1.2.2] - 2026-04-06

### Security
- **Fixed path traversal vulnerability** in `PolicyEngine.checkAllowedPath` — `/var/www` no longer matches `/var/www-evil` (#3)
- **Fixed `--init` crash on user cancel** — Clack prompt cancellation no longer throws on `Symbol` type (#12)

### Bug Fixes
- **Fixed sync manifest never persisting** — `syncManifestManager.save()` was dead code due to a flag check that always evaluated false. Manifest-based sync optimization now works correctly (#8)
- **Fixed `ftp_rmdir` non-recursive deleting files instead of directories** — FTP mode now uses the correct `RMD` command instead of `DELE` (#9)
- **Fixed intermittent false negatives in content search** — Removed stateful `g` flag from regex used with `.test()`, eliminating `lastIndex` drift across lines (#10)
- **Fixed `ftp_deploy` and `ftp_list_deployments` ignoring `FTP_CONFIG_PATH` env var** — Both now use the shared `CONFIG_FILE` constant instead of hardcoded paths (#11)
- **Removed redundant SFTP/FTP ternary branches** — Eliminated identical conditional branches in `ftp_list`, `ftp_search`, `ftp_stat`, and `ftp_rename` (#1, #13)

### Performance
- **Reduced sync delay from 250ms to 50ms** — Socket stabilization delay now only applies to FTP (not SFTP) connections, cutting sync time by ~80% for SFTP users (#2)
