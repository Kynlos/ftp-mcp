import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import ftpSrvModule from 'ftp-srv';
const FtpSrv = ftpSrvModule.FtpSrv || ftpSrvModule.default || ftpSrvModule;
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

describe('Protocol Gold Standard — Feature & Edge Case Tests', () => {
    let ftpServer;
    let mcpProcess;
    const FTP_PORT = 2124;
    const configPath = path.join(process.cwd(), '.ftpconfig_protocol');
    const mockRoot  = path.join(process.cwd(), 'Test', 'protocol-remote-mock');

    const executeRequest = (method, params = {}) => {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(7);
            const req = {
                jsonrpc: '2.0',
                id: requestId,
                method: method,
                params: params
            };

            let output = '';
            const timeout = setTimeout(() => {
                mcpProcess.stdout.removeListener('data', onData);
                reject(new Error(`Timeout waiting for ${method}`));
            }, 10000);

            const onData = (data) => {
                const raw = data.toString();
                output += raw;
                try {
                    const lines = output.trim().split('\n');
                    for (const line of lines) {
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.id === requestId) {
                                clearTimeout(timeout);
                                mcpProcess.stdout.removeListener('data', onData);
                                resolve(parsed);
                            }
                        } catch (e) { /* partial line */ }
                    }
                } catch (e) { /* wait for more data */ }
            };

            mcpProcess.stdout.on('data', onData);
            mcpProcess.stdin.write(JSON.stringify(req) + '\n');
        });
    };

    const setupConfig = async () => {
        const mockConfig = {
            default: {
                host: '127.0.0.1',
                user: 'anonymous',
                password: '',
                port: FTP_PORT
            }
        };
        await fs.writeFile(configPath, JSON.stringify(mockConfig), 'utf8');
    };

    beforeAll(async () => {
        ftpServer = new FtpSrv({ url: `ftp://127.0.0.1:${FTP_PORT}`, anonymous: true });
        await fs.mkdir(mockRoot,  { recursive: true });
        ftpServer.on('login', (_, resolve) => resolve({ root: mockRoot }));
        await ftpServer.listen();
        await setupConfig();
        mcpProcess = spawn('node', ['index.js'], {
            cwd: process.cwd(),
            env: { ...process.env, FTP_CONFIG_PATH: configPath }
        });
        mcpProcess.stderr.on('data', (d) => console.error(`[MCP-STDERR] ${d}`));
        await new Promise(r => setTimeout(r, 1500));
        // Connect initial session
        await executeRequest('tools/call', { name: 'ftp_connect', arguments: { profile: 'default' } });
    });

    afterAll(async () => {
        if (mcpProcess) mcpProcess.kill();
        if (ftpServer)  ftpServer.close();
        await fs.unlink(configPath).catch(() => null);
        await fs.rm(mockRoot, { recursive: true, force: true }).catch(() => null);
        await new Promise(r => setTimeout(r, 300));
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Prompts Testing
    // ─────────────────────────────────────────────────────────────────────────

    describe('Prompts — List & Get', () => {
        it('should list all available protocol prompts', async () => {
            const res = await executeRequest('prompts/list');
            const names = res.result.prompts.map(p => p.name);
            expect(names).toContain('audit-project');
            expect(names).toContain('deploy-checklist');
        });

        it('should retrieve the audit-project prompt structure', async () => {
            const res = await executeRequest('prompts/get', { name: 'audit-project' });
            expect(res.result.description).toContain('Security');
            expect(res.result.messages[0].content.text).toContain('ftp_analyze_workspace');
        });

        it('should handle custom path in audit-project prompt', async () => {
            const res = await executeRequest('prompts/get', { 
                name: 'audit-project', 
                arguments: { path: '/src/app' } 
            });
            expect(res.result.messages[0].content.text).toContain('/src/app');
        });

        it('should return error for non-existent prompt', async () => {
            const res = await executeRequest('prompts/get', { name: 'non-existent' });
            expect(res.error).toBeDefined();
            expect(res.error.message).toContain('not found');
        });

        it('should handle crazy LLM arguments in prompts gracefully', async () => {
            const crazyLongString = 'A'.repeat(5000);
            const res = await executeRequest('prompts/get', { 
                name: 'audit-project', 
                arguments: { path: crazyLongString } 
            });
            expect(res.result).toBeDefined();
            expect(res.result.messages[0].content.text).toContain(crazyLongString);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Resource Templates Testing
    // ─────────────────────────────────────────────────────────────────────────

    describe('Resource Templates — Dynamic File Access', () => {
        it('should list the remote-file resource template', async () => {
            const res = await executeRequest('resources/templates/list');
            const template = res.result.resourceTemplates.find(t => t.uriTemplate.includes('remote-file'));
            expect(template).toBeDefined();
            expect(template.uriTemplate).toBe('mcp://remote-file/{path}');
        });

        it('should read a remote file via the template URI', async () => {
            await fs.writeFile(path.join(mockRoot, 'template-test.txt'), 'Hello Protocol');
            const res = await executeRequest('resources/read', { uri: 'mcp://remote-file/template-test.txt' });
            if (res.error) {
                console.error('Resource Read Error:', JSON.stringify(res.error, null, 2));
            }
            expect(res.result).toBeDefined();
            expect(res.result.contents[0].text).toBe('Hello Protocol');
            expect(res.result.contents[0].mimeType).toBe('text/plain');
        });

        it('should block path traversal in the resource template URI', async () => {
            // This is a "Clever Agent/LLM" edge case: trying to escape the root via the URI
            const res = await executeRequest('resources/read', { uri: 'mcp://remote-file/../../etc/passwd' });
            expect(res.error).toBeDefined();
            expect(res.error.message).toContain('traversal');
        });

        it('should enforce policies on resource template access', async () => {
            // Block .env files
            await fs.writeFile(configPath, JSON.stringify({
                default: {
                    host: '127.0.0.1',
                    user: 'anonymous',
                    password: '',
                    port: FTP_PORT,
                    policies: { blockedGlobs: ['**/*.env'] }
                }
            }), 'utf8');
            // Reconnect
            await executeRequest('tools/call', { name: 'ftp_connect', arguments: { profile: 'default' } });

            const res = await executeRequest('resources/read', { uri: 'mcp://remote-file/secret.env' });
            expect(res.error).toBeDefined();
            expect(res.error.message).toContain('Policy Violation');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Progress & Logging Notifications
    // ─────────────────────────────────────────────────────────────────────────

    describe('Notifications — Progress & Logging', () => {
        it('should emit progress notifications during a batch upload', async () => {
            const localFile = path.join(process.cwd(), 'Test', 'progress-local.txt');
            await fs.mkdir(path.dirname(localFile), { recursive: true });
            await fs.writeFile(localFile, 'content');

            const notifications = [];
            const onData = (data) => {
                const lines = data.toString().trim().split('\n');
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.method === 'notifications/progress' && parsed.params.progressToken === 'token-123') {
                            notifications.push(parsed);
                        }
                    } catch (e) {}
                }
            };

            mcpProcess.stdout.on('data', onData);

            // Use _meta.progressToken to trigger progress reporting
            const reqId = 'prog-test';
            const req = {
                jsonrpc: '2.0',
                id: reqId,
                method: 'tools/call',
                params: {
                    name: 'ftp_batch_upload',
                    arguments: { 
                        files: [{ localPath: localFile, remotePath: '/remote-prog.txt' }] 
                    },
                    _meta: { progressToken: 'token-123' }
                }
            };

            mcpProcess.stdin.write(JSON.stringify(req) + '\n');

            // Wait for completion
            await new Promise((resolve) => {
                const check = (data) => {
                    if (data.toString().includes(reqId)) {
                        mcpProcess.stdout.removeListener('data', check);
                        resolve();
                    }
                };
                mcpProcess.stdout.on('data', check);
            });

            mcpProcess.stdout.removeListener('data', onData);

            expect(notifications.length).toBeGreaterThan(0);
            expect(notifications[0].params.progressToken).toBe('token-123');
        });

        it('should emit logging notifications during connection pooling', async () => {
            const logs = [];
            const onData = (data) => {
                const raw = data.toString();
                const lines = raw.trim().split('\n');
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.method === 'notifications/message') {
                            logs.push(parsed);
                        }
                    } catch (e) {}
                }
            };

            mcpProcess.stdout.on('data', onData);

            // Trigger a connection reuse. ftp_list uses getClient which logs.
            await executeRequest('tools/call', { name: 'ftp_list', arguments: { path: '.' } });
            
            // Give a tiny bit of time for logs to flush
            await new Promise(r => setTimeout(r, 200));

            mcpProcess.stdout.removeListener('data', onData);

            // Check if any log mentions pooling or connection
            const found = logs.some(l => {
                const str = JSON.stringify(l).toLowerCase();
                return str.includes('connection') || str.includes('pool');
            });
            expect(found).toBe(true);
        }, 10000); // 10s timeout

        it('should handle batch uploads to deeply nested non-existent paths', async () => {
            const f1Path = path.join(process.cwd(), 'Test', 'protocol-deep-1.txt');
            await fs.writeFile(f1Path, 'deep batch content');

            const res = await executeRequest('tools/call', {
                name: 'ftp_batch_upload',
                arguments: {
                    files: [{
                        localPath: f1Path,
                        remotePath: 'p1/p2/p3/deep-batch.txt'
                    }]
                }
            });

            expect(res.result.isError).toBeUndefined();
            
            // Verify file exists at deep path
            const listRes = await executeRequest('tools/call', {
                name: 'ftp_list',
                arguments: { path: 'p1/p2/p3' }
            });
            expect(listRes.result.content[0].text).toContain('deep-batch.txt');

            await fs.unlink(f1Path);
        });
    });
});
