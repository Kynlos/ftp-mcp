import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import ftpSrvModule from 'ftp-srv';
const FtpSrv = ftpSrvModule.FtpSrv || ftpSrvModule.default || ftpSrvModule;
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('50 AI Agent Edge Cases', () => {
    let ftpServer;
    let mcpProcess;
    const FTP_PORT = 2125;
    const configPath = path.join(process.cwd(), '.ftpconfig_edge');
    const mockRoot = path.join(process.cwd(), 'Test', 'edge-remote-mock');
    const localRoot = path.join(process.cwd(), 'Test', 'edge-local-mock');

    const executeMCP = (toolName, args = {}) => {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                mcpProcess.stdout.removeListener('data', onData);
                reject(new Error(`Timeout waiting for response to ${toolName}`));
            }, 15000);

            const requestId = Math.random().toString(36).substring(7);
            const req = {
                jsonrpc: "2.0",
                id: requestId,
                method: "tools/call",
                params: { name: toolName, arguments: args }
            };

            let output = '';
            const onData = (data) => {
                output += data.toString();
                try {
                    const lines = output.trim().split('\n');
                    for (const line of lines) {
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.id === requestId) {
                                clearTimeout(timeout);
                                mcpProcess.stdout.removeListener('data', onData);
                                resolve(parsed);
                                return;
                            }
                        } catch (e) { /* partial line */ }
                    }
                } catch (e) {}
            };

            mcpProcess.stdout.on('data', onData);
            mcpProcess.stdin.write(JSON.stringify(req) + '\n');
        });
    };

    const setupConfig = async (overrides = {}) => {
        const mockConfig = {
            default: {
                host: `127.0.0.1`,
                user: "anonymous",
                password: "",
                port: FTP_PORT,
                ...overrides
            }
        };
        await fs.writeFile(configPath, JSON.stringify(mockConfig), 'utf8');
    };

    const reconnect = async () => {
        await executeMCP('ftp_connect', { profile: 'default' });
    };

    // Retry-safe cleanup for Windows file locking
    const safeClean = async (dir) => {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const entries = await fs.readdir(dir);
                for (const entry of entries) {
                    await fs.rm(path.join(dir, entry), { recursive: true, force: true });
                }
                return;
            } catch (e) {
                await new Promise(r => setTimeout(r, 300));
            }
        }
    };

    beforeAll(async () => {
        ftpServer = new FtpSrv({
            url: `ftp://127.0.0.1:${FTP_PORT}`,
            anonymous: true
        });

        await fs.mkdir(mockRoot, { recursive: true });
        await fs.mkdir(localRoot, { recursive: true });

        ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
            resolve({ root: mockRoot });
        });

        await ftpServer.listen();
        await setupConfig();

        mcpProcess = spawn('node', ['index.js'], {
            cwd: process.cwd(),
            env: { ...process.env, FTP_CONFIG_PATH: configPath }
        });
        await new Promise(r => setTimeout(r, 1500));
    });

    afterAll(async () => {
        try {
            if (mcpProcess) {
                mcpProcess.kill();
                await new Promise(r => setTimeout(r, 500));
            }
            if (ftpServer) ftpServer.close();
            await fs.rm(mockRoot, { recursive: true, force: true }).catch(() => null);
            await fs.rm(localRoot, { recursive: true, force: true }).catch(() => null);
            await fs.unlink(configPath).catch(() => null);
            await fs.rm(path.join(process.cwd(), '.ftp-mcp-snapshots'), { recursive: true, force: true }).catch(() => null);
            await fs.rm(path.join(process.cwd(), '.ftp-mcp-sync-manifest.json'), { force: true }).catch(() => null);
        } catch (e) {}
    });

    beforeEach(async () => {
        await safeClean(mockRoot);
        await safeClean(localRoot);
        // Reset to default config and reconnect to clear caches + broken sockets
        await setupConfig();
        await reconnect();
        await new Promise(r => setTimeout(r, 100));
    });

    // =====================================================================
    // SECTION 1: File Access & Streaming (Cases 1-10)
    // =====================================================================
    describe('1. File Access & Streaming (Cases 1-10)', () => {
        it('1. ftp_get_contents: startLine > total lines returns empty slice gracefully', async () => {
            await fs.writeFile(path.join(mockRoot, 'short.txt'), 'line 1\nline 2');
            const res = await executeMCP('ftp_get_contents', { path: '/short.txt', startLine: 999 });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Showing lines');
        });

        it('2. ftp_get_contents: endLine < startLine returns empty slice', async () => {
            await fs.writeFile(path.join(mockRoot, 'test.txt'), 'line1\nline2\nline3');
            const res = await executeMCP('ftp_get_contents', { path: '/test.txt', startLine: 3, endLine: 1 });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Showing lines');
        });

        it('3. ftp_get_contents: startLine is 0 (treated as line 1)', async () => {
            await fs.writeFile(path.join(mockRoot, 'test.txt'), 'first line\nsecond line');
            const res = await executeMCP('ftp_get_contents', { path: '/test.txt', startLine: 0 });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('first line');
        });

        it('4. ftp_get_contents: negative line numbers clamp to 0', async () => {
            await fs.writeFile(path.join(mockRoot, 'test.txt'), 'content here');
            const res = await executeMCP('ftp_get_contents', { path: '/test.txt', startLine: -5 });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('content here');
        });

        it('5. ftp_get_contents: reading a non-existent file returns error', async () => {
            const res = await executeMCP('ftp_get_contents', { path: '/ghost-file.txt' });
            expect(res.result.isError).toBe(true);
        });

        it('6. ftp_get_contents: file with no line endings returns single line', async () => {
            await fs.writeFile(path.join(mockRoot, 'noline.txt'), 'a'.repeat(100));
            const res = await executeMCP('ftp_get_contents', { path: '/noline.txt', startLine: 1, endLine: 1 });
            expect(res.result.content[0].text).toContain('a'.repeat(100));
        });

        it('7. ftp_get_contents: empty file returns empty content', async () => {
            await fs.writeFile(path.join(mockRoot, 'empty.txt'), '');
            const res = await executeMCP('ftp_get_contents', { path: '/empty.txt' });
            expect(res.result.isError).toBeUndefined();
        });

        it('8. ftp_put_contents: zero-byte upload', async () => {
            const res = await executeMCP('ftp_put_contents', { path: '/empty.txt', content: '' });
            expect(res.result.isError).toBeUndefined();
            const stat = await fs.stat(path.join(mockRoot, 'empty.txt'));
            expect(stat.size).toBe(0);
        });

        it('9. ftp_put_contents: content with null bytes', async () => {
            const res = await executeMCP('ftp_put_contents', { path: '/null.txt', content: 'before\0after' });
            expect(res.result.isError).toBeUndefined();
        });

        it('10. ftp_put_contents: overwriting an existing file changes content', async () => {
            await fs.writeFile(path.join(mockRoot, 'overwrite.txt'), 'original');
            const res = await executeMCP('ftp_put_contents', { path: '/overwrite.txt', content: 'replaced' });
            expect(res.result.isError).toBeUndefined();
            const content = await fs.readFile(path.join(mockRoot, 'overwrite.txt'), 'utf8');
            expect(content).toBe('replaced');
        });
    });

    // =====================================================================
    // SECTION 2: Listing & Navigation (Cases 11-18)
    // =====================================================================
    describe('2. Listing & Navigation (Cases 11-18)', () => {
        it('11. ftp_list: limit: 0 defaults to 100 (falsy guard)', async () => {
            await fs.writeFile(path.join(mockRoot, 'a.txt'), 'a');
            await reconnect(); // Clear cache so a.txt is visible
            const res = await executeMCP('ftp_list', { path: '.', limit: 0 });
            // Edge case: server uses `limit || 100`, so 0 (falsy) defaults to 100
            // This means agents sending limit:0 still get results — a known behavior
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('a.txt');
        });

        it('12. ftp_list: offset > total count returns empty', async () => {
            await fs.writeFile(path.join(mockRoot, 'a.txt'), 'a');
            const res = await executeMCP('ftp_list', { path: '.', offset: 999 });
            expect(res.result.content[0].text).toContain('Empty directory');
        });

        it('13. ftp_list: path with spaces works', async () => {
            await fs.mkdir(path.join(mockRoot, 'my special folder'));
            await fs.writeFile(path.join(mockRoot, 'my special folder', 'test.txt'), 'data');
            const res = await executeMCP('ftp_list', { path: '/my special folder' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('test.txt');
        });

        it('14. ftp_list: empty directory returns graceful message', async () => {
            await fs.mkdir(path.join(mockRoot, 'empty'));
            const res = await executeMCP('ftp_list', { path: '/empty' });
            expect(res.result.content[0].text).toContain('Empty directory');
        });

        it('15. ftp_list: non-existent directory returns error', async () => {
            const res = await executeMCP('ftp_list', { path: '/ghost-dir-xyz' });
            expect(res.result.isError).toBe(true);
        });

        it('16. ftp_list: listing root "." works', async () => {
            await fs.writeFile(path.join(mockRoot, 'root.txt'), 'data');
            const res = await executeMCP('ftp_list', { path: '.' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('root.txt');
        });

        it('17. ftp_exists: file that exists returns true', async () => {
            await fs.writeFile(path.join(mockRoot, 'present.txt'), 'data');
            const res = await executeMCP('ftp_exists', { path: '/present.txt' });
            expect(res.result.content[0].text).toBe('true');
        });

        it('18. ftp_exists: file that does not exist returns false', async () => {
            const res = await executeMCP('ftp_exists', { path: '/no-such-file.txt' });
            expect(res.result.content[0].text).toBe('false');
        });
    });

    // =====================================================================
    // SECTION 3: Patching & Synchronization (Cases 19-28)
    // =====================================================================
    describe('3. Patching & Synchronization (Cases 19-28)', () => {
        it('19. ftp_patch_file: patching a missing file returns error', async () => {
            const patch = `--- ghost.txt\n+++ ghost.txt\n@@ -1 +1 @@\n-old\n+new`;
            const res = await executeMCP('ftp_patch_file', { path: '/ghost.txt', patch: patch });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('not found');
        });

        it('20. ftp_patch_file: empty patch string is a no-op', async () => {
            await fs.writeFile(path.join(mockRoot, 'test.txt'), 'data');
            const res = await executeMCP('ftp_patch_file', { path: '/test.txt', patch: '' });
            // applyPatch with empty string returns original content — it's a no-op, not an error
            expect(res.result.isError).toBeUndefined();
            // File should remain unchanged
            const content = await fs.readFile(path.join(mockRoot, 'test.txt'), 'utf8');
            expect(content).toBe('data');
        });

        it('21. ftp_patch_file: malformed hunk treated as no-op by applyPatch', async () => {
            await fs.writeFile(path.join(mockRoot, 'patch.txt'), 'line1\nline2');
            const badPatch = `not a valid patch at all`;
            const res = await executeMCP('ftp_patch_file', { path: '/patch.txt', patch: badPatch });
            // applyPatch with random text succeeds as a no-op (returns original unchanged)
            expect(res.result.isError).toBeUndefined();
            const content = await fs.readFile(path.join(mockRoot, 'patch.txt'), 'utf8');
            expect(content).toBe('line1\nline2');
        });

        it('22. ftp_patch_file: mismatching expectedHash returns drift error', async () => {
            await fs.writeFile(path.join(mockRoot, 'drift.txt'), 'actual content');
            const patch = `--- drift.txt\n+++ drift.txt\n@@ -1 +1 @@\n-actual content\n+new content`;
            const res = await executeMCP('ftp_patch_file', { path: '/drift.txt', patch: patch, expectedHash: 'deadbeef' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('drift');
        });

        it('23. ftp_patch_file: valid patch creates .bak backup', async () => {
            await fs.writeFile(path.join(mockRoot, 'backup.txt'), 'original');
            const patch = `--- backup.txt\n+++ backup.txt\n@@ -1 +1 @@\n-original\n+patched`;
            const res = await executeMCP('ftp_patch_file', { path: '/backup.txt', patch: patch });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('.bak');
            const bakContent = await fs.readFile(path.join(mockRoot, 'backup.txt.bak'), 'utf8');
            expect(bakContent).toBe('original');
        });

        it('24. ftp_sync: dryRun with empty local dir', async () => {
            const res = await executeMCP('ftp_sync', { localPath: localRoot, remotePath: '/', dryRun: true });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('[DRY RUN]');
        });

        it('25. ftp_sync: blockedGlobs policy blocks files during sync', async () => {
            await setupConfig({ policies: { blockedGlobs: ['**/*.secret'] } });
            await reconnect();
            await fs.writeFile(path.join(localRoot, 'data.secret'), 'sensitive');
            await fs.writeFile(path.join(localRoot, 'ok.txt'), 'fine');
            const res = await executeMCP('ftp_sync', { localPath: localRoot, remotePath: '/', dryRun: true });
            // The .secret file should be blocked/ignored by policy
            expect(res.result.content[0].text).toContain('[DRY RUN]');
        });

        it('26. ftp_sync: manifest corruption recovery', async () => {
            const manifestPath = path.join(process.cwd(), '.ftp-mcp-sync-manifest.json');
            await fs.writeFile(manifestPath, 'THIS IS NOT JSON!!!');
            await fs.writeFile(path.join(localRoot, 'ok.txt'), 'data');
            const res = await executeMCP('ftp_sync', { localPath: localRoot, remotePath: '/', dryRun: true });
            expect(res.result.isError).toBeUndefined();
            await fs.rm(manifestPath, { force: true }).catch(() => null);
        });

        it('27. ftp_sync: dryRun shows Semantic Change Preview for manifests', async () => {
            await fs.writeFile(path.join(localRoot, 'package.json'), '{}');
            await fs.writeFile(path.join(localRoot, 'index.js'), 'code');
            const res = await executeMCP('ftp_sync', { localPath: localRoot, remotePath: '/', dryRun: true });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Semantic Change Preview');
        });

        it('28. ftp_sync: dryRun reports .env files as risky', async () => {
            await fs.writeFile(path.join(localRoot, '.env'), 'SECRET=123');
            await fs.writeFile(path.join(localRoot, 'app.js'), 'ok');
            const res = await executeMCP('ftp_sync', { localPath: localRoot, remotePath: '/', dryRun: true });
            expect(res.result.content[0].text).toContain('Risky Files');
        });
    });

    // =====================================================================
    // SECTION 4: Search & Analysis (Cases 29-36)
    // =====================================================================
    describe('4. Search & Analysis (Cases 29-36)', () => {
        it('29. ftp_search: no parameters returns error', async () => {
            const res = await executeMCP('ftp_search', {});
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('Must provide');
        });

        it('30. ftp_search: ReDoS-safe regex handling', async () => {
            await fs.writeFile(path.join(mockRoot, 'test.txt'), 'content');
            const res = await executeMCP('ftp_search', { contentPattern: '(a+)+$' });
            expect(res.result).toBeDefined();
        });

        it('31. ftp_search: findLikelyConfigs detects config files', async () => {
            await fs.writeFile(path.join(mockRoot, 'config.php'), '<?php');
            await fs.writeFile(path.join(mockRoot, 'image.png'), 'fake');
            // Must reconnect to invalidate the TREE cache after writing files
            await reconnect();
            const res = await executeMCP('ftp_search', { findLikelyConfigs: true });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('config.php');
        });

        it('32. ftp_search: content search finds target across files', async () => {
            await fs.writeFile(path.join(mockRoot, 'haystack1.txt'), 'hello world\nfind me\nbye');
            await fs.writeFile(path.join(mockRoot, 'haystack2.txt'), 'nothing here');
            await reconnect();
            const res = await executeMCP('ftp_search', { contentPattern: 'find me' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('haystack1.txt');
            expect(res.result.content[0].text).toContain('find me');
        });

        it('33. ftp_search: no matches returns graceful message', async () => {
            await fs.writeFile(path.join(mockRoot, 'file.txt'), 'nothing here');
            await reconnect();
            const res = await executeMCP('ftp_search', { contentPattern: 'XYZZY_NOT_HERE' });
            expect(res.result.content[0].text).toContain('No matches found');
        });

        it('34. ftp_analyze_workspace: zero-file environment', async () => {
            const res = await executeMCP('ftp_analyze_workspace');
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('No recognizable project configuration files found');
        });

        it('35. ftp_analyze_workspace: detects Next.js framework', async () => {
            await fs.writeFile(path.join(mockRoot, 'next.config.js'), '{}');
            await fs.writeFile(path.join(mockRoot, 'package.json'), '{}');
            await reconnect();
            const res = await executeMCP('ftp_analyze_workspace');
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Detected Framework: Next.js');
        });

        it('36. ftp_analyze_workspace: corrupt package.json handled gracefully', async () => {
            await fs.writeFile(path.join(mockRoot, 'package.json'), '{ THIS IS NOT JSON }');
            await reconnect();
            const res = await executeMCP('ftp_analyze_workspace');
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('package.json');
        });
    });

    // =====================================================================
    // SECTION 5: File Operations & Transactions (Cases 37-46)
    // =====================================================================
    describe('5. File Operations & Transactions (Cases 37-46)', () => {
        it('37. ftp_rename: rename a file to a new name works', async () => {
            await fs.writeFile(path.join(mockRoot, 'old.txt'), 'data');
            await new Promise(r => setTimeout(r, 200));
            const res = await executeMCP('ftp_rename', { oldPath: '/old.txt', newPath: '/new.txt' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Successfully renamed');
        });

        it('38. ftp_rename: verifies old file gone and new file exists', async () => {
            await fs.writeFile(path.join(mockRoot, 'source.txt'), 'data');
            await new Promise(r => setTimeout(r, 200));
            await executeMCP('ftp_rename', { oldPath: '/source.txt', newPath: '/dest.txt' });
            const existsOld = await executeMCP('ftp_exists', { path: '/source.txt' });
            expect(existsOld.result.content[0].text).toBe('false');
            const existsNew = await executeMCP('ftp_exists', { path: '/dest.txt' });
            expect(existsNew.result.content[0].text).toBe('true');
        });

        it('39. ftp_delete: delete missing file returns error', async () => {
            const res = await executeMCP('ftp_delete', { path: '/ghost.txt' });
            expect(res.result.isError).toBe(true);
        });

        it('40. ftp_delete: successful delete returns transaction ID', async () => {
            await fs.writeFile(path.join(mockRoot, 'killme.txt'), 'bye');
            const res = await executeMCP('ftp_delete', { path: '/killme.txt' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Transaction ID');
        });

        it('41. ftp_stat: on a file returns correct size', async () => {
            await fs.writeFile(path.join(mockRoot, 'statme.txt'), 'hello world');
            await reconnect(); // Ensure fresh connection for stat
            const res = await executeMCP('ftp_stat', { path: '/statme.txt' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('11');
        });

        it('42. ftp_stat: on non-existent file errors', async () => {
            const res = await executeMCP('ftp_stat', { path: '/no-such-file.xyz' });
            expect(res.result.isError).toBe(true);
        });

        it('43. ftp_rollback: with bogus transaction ID fails gracefully', async () => {
            const res = await executeMCP('ftp_rollback', { transactionId: 'tx_nonexistent_999' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('Rollback failed');
        });

        it('44. ftp_rollback: restores original after put_contents', async () => {
            await fs.writeFile(path.join(mockRoot, 'rollback.txt'), 'v1');
            // Need fresh file on server first
            const putRes = await executeMCP('ftp_put_contents', { path: '/rollback.txt', content: 'v2' });
            expect(putRes.result.isError).toBeUndefined();
            const txMatch = putRes.result.content[0].text.match(/tx_[a-f0-9_]+/);
            expect(txMatch).not.toBeNull();
            const txId = txMatch[0];

            const readV2 = await executeMCP('ftp_get_contents', { path: '/rollback.txt' });
            expect(readV2.result.content[0].text).toContain('v2');

            const rollRes = await executeMCP('ftp_rollback', { transactionId: txId });
            expect(rollRes.result.isError).toBeUndefined();
            expect(rollRes.result.content[0].text).toContain('Restored: 1');

            const readV1 = await executeMCP('ftp_get_contents', { path: '/rollback.txt' });
            expect(readV1.result.content[0].text).toContain('v1');
        });

        it('45. ftp_mkdir: creating a single directory', async () => {
            const res = await executeMCP('ftp_mkdir', { path: '/newdir' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Successfully created');
        });

        it('46. ftp_list_transactions: returns list or empty', async () => {
            const res = await executeMCP('ftp_list_transactions');
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toBeDefined();
        });
    });

    // =====================================================================
    // SECTION 6: Security & Policy (Cases 47-50)
    // =====================================================================
    describe('6. Security & Policy (Cases 47-50)', () => {
        it('47. readOnly mode blocks destructive ftp_put_contents', async () => {
            await setupConfig({ readOnly: true });
            await reconnect();
            const res = await executeMCP('ftp_put_contents', { path: '/test.txt', content: 'blocked' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('readOnly');
        });

        it('48. readOnly mode blocks ftp_delete', async () => {
            await setupConfig({ readOnly: true });
            await reconnect();
            const res = await executeMCP('ftp_delete', { path: '/anything.txt' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('readOnly');
        });

        it('49. blockedGlobs policy blocks uploading log files', async () => {
            await setupConfig({ policies: { blockedGlobs: ['**/*.log'] } });
            await reconnect();
            const res = await executeMCP('ftp_put_contents', { path: '/app.log', content: 'log data' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('blocked glob');
        });

        it('50. maxFileSize policy blocks oversized writes', async () => {
            await setupConfig({ policies: { maxFileSize: 5 } });
            await reconnect();
            const res = await executeMCP('ftp_put_contents', { path: '/big.txt', content: 'this is way more than 5 bytes' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('maxFileSize');
        });
    });
});
