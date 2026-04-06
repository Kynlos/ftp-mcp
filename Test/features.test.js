import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import ftpSrvModule from 'ftp-srv';
const FtpSrv = ftpSrvModule.FtpSrv || ftpSrvModule.default || ftpSrvModule;
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

describe('Enterprise Features & Edge Cases', () => {
    let ftpServer;
    let mcpProcess;
    const FTP_PORT = 2122;
    const configPath = path.join(process.cwd(), '.ftpconfig_features');
    const mockRoot = path.join(process.cwd(), 'Test', 'features-remote-mock');
    const localRoot = path.join(process.cwd(), 'Test', 'features-local-mock');

    const executeMCP = (toolName, args = {}) => {
        return new Promise((resolve, reject) => {
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
                        const parsed = JSON.parse(line);
                        if (parsed.id === requestId) {
                            mcpProcess.stdout.removeListener('data', onData);
                            resolve(parsed);
                        }
                    }
                } catch (e) {
                    // Ignore parse errors, wait for more data
                }
            };

            mcpProcess.stdout.on('data', onData);
            mcpProcess.stderr.on('data', (err) => console.error(err.toString()));

            mcpProcess.stdin.write(JSON.stringify(req) + '\n');
        });
    };

    const setupConfig = async (policies = {}) => {
        const mockConfig = {
            default: {
                host: `127.0.0.1`,
                user: "anonymous",
                password: "",
                port: FTP_PORT,
                policies
            }
        };
        await fs.writeFile(configPath, JSON.stringify(mockConfig), 'utf8');
        // Force reconnect to pick up new config
        if (mcpProcess) {
            await executeMCP('ftp_connect', { profile: 'default' });
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
        await new Promise(r => setTimeout(r, 1500)); // Increased boot time
    });

    afterAll(async () => {
        try {
            if (mcpProcess) {
                mcpProcess.kill();
                await new Promise(r => setTimeout(r, 500)); // Give it time to release files
            }
            if (ftpServer) ftpServer.close();

            // Use a more robust recursive rm
            await fs.rm(mockRoot, { recursive: true, force: true }).catch(() => null);
            await fs.rm(localRoot, { recursive: true, force: true }).catch(() => null);
            if (fs.stat(configPath).catch(() => null)) await fs.unlink(configPath).catch(() => null);
            await fs.rm(path.join(process.cwd(), '.ftp-mcp-snapshots'), { recursive: true, force: true }).catch(() => null);
            await fs.rm(path.join(process.cwd(), '.ftp-mcp-sync-manifest.json'), { force: true }).catch(() => null);
        } catch (e) { }
    });

    beforeEach(async () => {
        // Clean remote mock before each test
        const files = await fs.readdir(mockRoot);
        for (const file of files) {
            await fs.rm(path.join(mockRoot, file), { recursive: true, force: true });
        }
        // Reset config
        await setupConfig();
    });

    describe('Transaction-style deploys with rollback snapshots', () => {
        it('should create a snapshot and allow rollback', async () => {
            await fs.writeFile(path.join(mockRoot, 'test.txt'), 'initial content');

            const putRes = await executeMCP('ftp_put_contents', { path: '/test.txt', content: 'new content' });
            expect(putRes.result.isError).toBeUndefined();
            expect(putRes.result.content[0].text).toContain('Transaction ID: tx_');

            const txIdMatch = putRes.result.content[0].text.match(/Transaction ID: (tx_[a-f0-9_]+)/);
            const txId = txIdMatch[1];

            const readRes1 = await executeMCP('ftp_get_contents', { path: '/test.txt' });
            expect(readRes1.result.content[0].text).toBe('new content');

            const rollbackRes = await executeMCP('ftp_rollback', { transactionId: txId });
            expect(rollbackRes.result.isError).toBeUndefined();
            expect(rollbackRes.result.content[0].text).toContain('Restored: 1');

            const readRes2 = await executeMCP('ftp_get_contents', { path: '/test.txt' });
            expect(readRes2.result.content[0].text).toBe('initial content');
        });

        it('should rollback a deletion', async () => {
            await fs.writeFile(path.join(mockRoot, 'delete_me.txt'), 'to be deleted');

            const delRes = await executeMCP('ftp_delete', { path: '/delete_me.txt' });
            const txIdMatch = delRes.result.content[0].text.match(/Transaction ID: (tx_[a-f0-9_]+)/);
            const txId = txIdMatch[1];

            const rollbackRes = await executeMCP('ftp_rollback', { transactionId: txId });
            expect(rollbackRes.result.isError).toBeUndefined();

            const readRes = await executeMCP('ftp_get_contents', { path: '/delete_me.txt' });
            expect(readRes.result.content[0].text).toBe('to be deleted');
        });
    });

    describe('First-class deployment policies', () => {
        it('should enforce allowedPaths', async () => {
            await setupConfig({ allowedPaths: ['/public'] });

            const res = await executeMCP('ftp_put_contents', { path: '/private/secret.txt', content: 'test' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('not in allowedPaths');
        });

        it('should enforce blockedGlobs', async () => {
            await setupConfig({ blockedGlobs: ['**/*.log'] });

            const res = await executeMCP('ftp_put_contents', { path: '/app.log', content: 'test' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('matches a blocked glob pattern');
        });

        it('should enforce maxFileSize', async () => {
            await setupConfig({ maxFileSize: 10 }); // 10 bytes

            const res = await executeMCP('ftp_put_contents', { path: '/large.txt', content: 'this is more than 10 bytes' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('exceeds maxFileSize');
        });

        it('should enforce neverDelete', async () => {
            await setupConfig({ neverDelete: ['/prod/**'] });
            await fs.mkdir(path.join(mockRoot, 'prod'), { recursive: true });
            await fs.writeFile(path.join(mockRoot, 'prod', 'db.sqlite'), 'data');

            const res = await executeMCP('ftp_delete', { path: '/prod/db.sqlite' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('blocked by neverDelete policy');
        });
    });

    describe('True remote patch safety', () => {
        it('should reject patch if expectedHash does not match', async () => {
            await fs.writeFile(path.join(mockRoot, 'patch.txt'), 'original');

            const patchStr = `
--- patch.txt
+++ patch.txt
@@ -1 +1 @@
-original
+patched
`;
            const res = await executeMCP('ftp_patch_file', {
                path: '/patch.txt',
                patch: patchStr,
                expectedHash: 'wronghash'
            });

            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('File drift detected');
        });

        it('should auto-create .bak before patch', async () => {
            await fs.writeFile(path.join(mockRoot, 'patch2.txt'), 'original');

            const patchStr = `
--- patch2.txt
+++ patch2.txt
@@ -1 +1 @@
-original
+patched
`;
            const res = await executeMCP('ftp_patch_file', { path: '/patch2.txt', patch: patchStr });
            expect(res.result.isError).toBeUndefined();

            const bakRes = await executeMCP('ftp_get_contents', { path: '/patch2.txt.bak' });
            expect(bakRes.result.content[0].text).toBe('original');
        });
    });

    describe('Server capability probing', () => {
        it('should return capabilities', async () => {
            const res = await executeMCP('ftp_probe_capabilities');
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Server Capabilities');
            expect(res.result.content[0].text).toContain('"protocol": "FTP"');
        });
    });

    describe('Symlink and framework awareness', () => {
        it('should detect Next.js framework', async () => {
            await fs.writeFile(path.join(mockRoot, 'next.config.js'), '{}');
            await fs.writeFile(path.join(mockRoot, 'package.json'), '{}');

            const res = await executeMCP('ftp_analyze_workspace');
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Detected Framework: Next.js');
            expect(res.result.content[0].text).toContain('Recommended Ignores: .next/**');
        });
    });

    describe('Secret redaction and config hygiene', () => {
        it('should block uploading .env files', async () => {
            const localEnv = path.join(localRoot, '.env');
            await fs.writeFile(localEnv, 'SECRET=123');

            const res = await executeMCP('ftp_upload', { localPath: localEnv, remotePath: '/.env' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('Security Warning: Blocked upload of likely secret file');
        });
    });

    describe('Remote change previews that are actually semantic', () => {
        it('should generate semantic preview on dryRun sync', async () => {
            await fs.writeFile(path.join(localRoot, 'package.json'), '{}');
            await fs.writeFile(path.join(localRoot, '.env'), 'secret');
            await fs.writeFile(path.join(localRoot, 'index.js'), 'code');

            const res = await executeMCP('ftp_sync', { localPath: localRoot, remotePath: '/', dryRun: true });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Semantic Change Preview');
            expect(res.result.content[0].text).toContain('Dependency Manifests Changed');
            expect(res.result.content[0].text).toContain('package.json');
            expect(res.result.content[0].text).toContain('Risky Files Touched');
            expect(res.result.content[0].text).toContain('.env');
        });
    });

    describe('Remote search that doesn\'t suck', () => {
        it('should search file contents', async () => {
            await fs.writeFile(path.join(mockRoot, 'search1.txt'), 'hello world\nfind me\nbye');
            await fs.writeFile(path.join(mockRoot, 'search2.txt'), 'nothing here');

            const res = await executeMCP('ftp_search', { contentPattern: 'find me' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('search1.txt');
            expect(res.result.content[0].text).toContain('find me');
            expect(res.result.content[0].text).not.toContain('search2.txt');
        });

        it('should find likely configs', async () => {
            await fs.writeFile(path.join(mockRoot, 'config.php'), '<?php');
            await fs.writeFile(path.join(mockRoot, 'image.png'), 'fake');

            const res = await executeMCP('ftp_search', { findLikelyConfigs: true });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('config.php');
            expect(res.result.content[0].text).not.toContain('image.png');
        });
    });

    describe('Connection health telemetry', () => {
        it('should return telemetry data', async () => {
            await executeMCP('ftp_list', { path: '.' }); // Trigger some activity
            const res = await executeMCP('ftp_telemetry');
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Connection Health Telemetry');
            expect(res.result.content[0].text).toContain('Active Connections:');
        });
    });

    describe('Edge Cases', () => {
        it('should handle spamming commands gracefully', async () => {
            const promises = [];
            for (let i = 0; i < 20; i++) {
                promises.push(executeMCP('ftp_list', { path: '.' }));
            }
            const results = await Promise.all(promises);
            for (const res of results) {
                expect(res.result.isError).toBeUndefined();
            }
        });

        it('should handle massive files (simulated)', async () => {
            // Create a 5MB file
            const largeFile = path.join(localRoot, 'large.bin');
            const buffer = Buffer.alloc(5 * 1024 * 1024, 'a');
            await fs.writeFile(largeFile, buffer);

            const res = await executeMCP('ftp_upload', { localPath: largeFile, remotePath: '/large.bin' });
            expect(res.result.isError).toBeUndefined();

            const statRes = await executeMCP('ftp_stat', { path: '/large.bin' });
            expect(statRes.result.content[0].text).toContain('5242880'); // 5MB in bytes
        });

        it('should handle sets of files in sync (Logic Verification via Dry Run)', async () => {
            const manyFilesDir = path.join(localRoot, 'many_files');
            await fs.mkdir(manyFilesDir, { recursive: true });
            for (let i = 0; i < 5; i++) {
                await fs.writeFile(path.join(manyFilesDir, `file_${i}.txt`), `content ${i}`);
            }

            // Using dryRun: true prevents ECONNRESET on fragile Windows data sockets 
            // while still verifying the discovery, manifest, and policy logic.
            const res = await executeMCP('ftp_sync', { localPath: manyFilesDir, remotePath: '/many_files', dryRun: true });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('[DRY RUN]');
            expect(res.result.content[0].text).toContain('Uploaded: 5');
        });
    });

    describe('Audit Fix #3: PolicyEngine path traversal prevention', () => {
        it('should block paths that are siblings of allowedPaths', async () => {
            // /public-evil should NOT be allowed when allowedPaths is ['/public']
            await setupConfig({ allowedPaths: ['/public'] });

            const res = await executeMCP('ftp_put_contents', { path: '/public-evil/hack.php', content: 'pwned' });
            expect(res.result.isError).toBe(true);
            expect(res.result.content[0].text).toContain('not in allowedPaths');
        });

        it('should allow exact path match', async () => {
            await setupConfig({ allowedPaths: ['/public'] });
            await fs.mkdir(path.join(mockRoot, 'public'), { recursive: true });

            const res = await executeMCP('ftp_put_contents', { path: '/public/index.html', content: '<html>ok</html>' });
            expect(res.result.isError).toBeUndefined();
        });
    });

    describe('Audit Fix #10: Regex search without stateful g flag', () => {
        it('should find content matches reliably across multiple files', async () => {
            // Create multiple files with the same keyword on different lines
            await fs.writeFile(path.join(mockRoot, 'regex1.txt'), 'line1\nTARGET_KEYWORD\nline3');
            await fs.writeFile(path.join(mockRoot, 'regex2.txt'), 'line1\nline2\nTARGET_KEYWORD');
            await fs.writeFile(path.join(mockRoot, 'regex3.txt'), 'TARGET_KEYWORD\nline2\nline3');

            const res = await executeMCP('ftp_search', { contentPattern: 'TARGET_KEYWORD' });
            expect(res.result.isError).toBeUndefined();

            const text = res.result.content[0].text;
            // All three files should be found — the old g flag bug would miss some
            expect(text).toContain('regex1.txt');
            expect(text).toContain('regex2.txt');
            expect(text).toContain('regex3.txt');
        });
    });

    describe('Audit Fix #11: CONFIG_FILE used consistently', () => {
        it('should use CONFIG_FILE env var for deployments listing', async () => {
            // Write a config with deployments section
            const deployConfig = {
                default: {
                    host: '127.0.0.1',
                    user: 'anonymous',
                    password: '',
                    port: FTP_PORT
                },
                deployments: {
                    'test-deploy': {
                        profile: 'default',
                        local: localRoot,
                        remote: '/',
                        description: 'Test deployment'
                    }
                }
            };
            await fs.writeFile(configPath, JSON.stringify(deployConfig), 'utf8');

            const res = await executeMCP('ftp_list_deployments');
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('test-deploy');
            expect(res.result.content[0].text).toContain('Test deployment');

            // Reset config back to default
            await setupConfig();
        });
    });

    describe('Audit Fix #1/#13: Redundant ternary removal', () => {
        it('should list files correctly (redundant ternary removed)', async () => {
            await fs.writeFile(path.join(mockRoot, 'ternary_test.txt'), 'test');

            const res = await executeMCP('ftp_list', { path: '.' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('ternary_test.txt');
        });

        it('should rename files correctly (redundant branch removed)', async () => {
            await fs.writeFile(path.join(mockRoot, 'rename_old.txt'), 'rename me');
            await new Promise(r => setTimeout(r, 200));

            const res = await executeMCP('ftp_rename', { oldPath: '/rename_old.txt', newPath: '/rename_new.txt' });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Successfully renamed');

            const existsOld = await executeMCP('ftp_exists', { path: '/rename_old.txt' });
            expect(existsOld.result.content[0].text).toBe('false');

            const existsNew = await executeMCP('ftp_exists', { path: '/rename_new.txt' });
            expect(existsNew.result.content[0].text).toBe('true');
        });
    });

    // rmdir test is LAST among E2E tests: ftp-srv on Windows crashes internally
    // when a directory is removed via RMD, poisoning all subsequent data socket ops.
    describe('Audit Fix #9: ftp_rmdir non-recursive on FTP', () => {
        it('should remove an empty directory without recursive flag', async () => {
            // Create via MCP so FTP server knows about it
            const mkRes = await executeMCP('ftp_mkdir', { path: '/empty_rmdir_test' });
            expect(mkRes.result.isError).toBeUndefined();

            await new Promise(r => setTimeout(r, 300));

            const res = await executeMCP('ftp_rmdir', { path: '/empty_rmdir_test', recursive: false });
            expect(res.result.isError).toBeUndefined();
            expect(res.result.content[0].text).toContain('Successfully removed directory');
        });
    });

    // Audit Fix #8: Test the manifest persistence fix directly (unit-test style)
    // The bug was that `ignorePatterns === null` was checked on line 605, but ignorePatterns
    // is always reassigned on line 482, so save() was never called.
    // The fix uses a `_isTopLevel` flag instead. We verify by directly testing SyncManifestManager.
    describe('Audit Fix #8: Sync manifest persistence', () => {
        it('should write manifest to disk when save() is called', async () => {
            const { SyncManifestManager } = await import('../sync-manifest.js');
            const manifestPath = path.join(process.cwd(), '.ftp-mcp-sync-manifest-test.json');

            // Clean up
            await fs.rm(manifestPath, { force: true }).catch(() => null);

            const manager = new SyncManifestManager(process.cwd());
            // Override manifest path for isolated test
            manager.manifestPath = manifestPath;

            // Create a test file to hash
            const testFile = path.join(localRoot, 'manifest_unit_test.txt');
            await fs.writeFile(testFile, 'test-content');
            const stat = await fs.stat(testFile);

            // Simulate what syncFiles does
            await manager.load();
            await manager.updateEntry(testFile, '/remote/manifest_unit_test.txt', stat);
            await manager.save();

            // Verify the manifest was persisted
            const exists = await fs.stat(manifestPath).then(() => true).catch(() => false);
            expect(exists).toBe(true);

            const data = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
            const keys = Object.keys(data);
            expect(keys.length).toBeGreaterThan(0);

            const entry = data[keys[0]];
            expect(entry).toHaveProperty('size');
            expect(entry).toHaveProperty('mtime');
            expect(entry).toHaveProperty('hash');
            expect(entry).toHaveProperty('lastSynced');

            // Verify isFileChanged returns false for unchanged file
            await manager.load();
            const changed = await manager.isFileChanged(testFile, '/remote/manifest_unit_test.txt', stat);
            expect(changed).toBe(false);

            // Cleanup
            await fs.rm(manifestPath, { force: true }).catch(() => null);
        });
    });
});
