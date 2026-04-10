# Changelog

## [1.5.3] - 2026-04-10
### Added
- Centralized `ensureRemoteDir` and `safeMkdir` utilities to automate directory creation with CWD-reset safety.
- Automatic parental directory creation for `ftp_put_contents`, `ftp_patch_file`, `ftp_batch_upload`, and `ftp_rename`.

### Fixed
- Fixed critical "CWD Leakage" in underlying `basic-ftp` library that caused infinite recursive nesting in production environments.
- Hardened all mutation tools to maintain consistent state on standard FTP servers like FileZilla.

## [1.5.2] - 2026-04-10
### Fixed
- Fixed critical "CWD Leakage" in `ftp_sync` where `basic-ftp`'s `ensureDir` would silently change the Current Working Directory, causing infinite recursive nesting.
- Implemented `_initialPwd` capture and mandatory `cd` resets after all manual directory creation operations.
- Hardened `ftp_upload` and `ftp_mkdir` to prevent state leakage.
- Fixed ignore pattern cache invalidation when applying dynamic anti-recursion filters.
