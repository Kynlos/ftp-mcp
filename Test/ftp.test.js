import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ftpSrvModule from 'ftp-srv';
const FtpSrv = ftpSrvModule.FtpSrv || ftpSrvModule.default || ftpSrvModule;
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

describe('FTP MCP Comprehensive E2E Test Suite', () => {
  let ftpServer;
  let mcpProcess;
  const FTP_PORT = 2121;
  const configPath = path.join(process.cwd(), '.ftpconfig_core');

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

      // We set up a single-use listener for this specific request. Since it's sequential tests, this works.
      const onData = (data) => {
        output += data.toString();
        try {
          // MCP sends back JSONL, there could be multiple lines but usually one per response.
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

  beforeAll(async () => {
    // 1. Setup Mock FTP Server
    ftpServer = new FtpSrv({
      url: `ftp://127.0.0.1:${FTP_PORT}`,
      anonymous: true
    });

    // We mock the root of the FTP server to a "remote-mock" folder in the current directory
    const mockRoot = path.join(process.cwd(), 'Test', 'remote-mock');
    await fs.mkdir(mockRoot, { recursive: true });
    // Write test file
    await fs.writeFile(path.join(mockRoot, 'hello.txt'), 'Hello World!\nLine 2\nLine 3\nLine 4\nLine 5\n', 'utf8');

    ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
      resolve({ root: mockRoot });
    });

    await ftpServer.listen();

    // 2. Write a mock .ftpconfig for the MCP to connect to
    const mockConfig = {
      default: {
        host: `127.0.0.1`,
        user: "anonymous",
        password: "",
        port: FTP_PORT
      }
    };
    await fs.writeFile(configPath, JSON.stringify(mockConfig), 'utf8');
    if (mcpProcess) {
      await executeMCP('ftp_connect', { profile: 'default' });
    }

    // 3. Start the MCP server process in stdio mode
    mcpProcess = spawn('node', ['index.js'], { 
      cwd: process.cwd(),
      env: { ...process.env, FTP_CONFIG_PATH: configPath }
    });

    // Give it a bit more time to boot up
    await new Promise(r => setTimeout(r, 1500));
  });

  afterAll(async () => {
    if (mcpProcess) mcpProcess.kill();
    if (ftpServer) ftpServer.close();

    try {
      await fs.unlink(configPath);
      await fs.rm(path.join(process.cwd(), 'Test', 'remote-mock'), { recursive: true, force: true });
    } catch (e) { }
  });

  it('Should successfully execute ftp_list and cache the result', async () => {
    const start = Date.now();
    const res1 = await executeMCP('ftp_list', { path: '.' });
    const time1 = Date.now() - start;

    expect(res1.result.isError).toBeUndefined();
    expect(res1.result.content[0].text).toContain('hello.txt');

    const start2 = Date.now();
    const res2 = await executeMCP('ftp_list', { path: '.' });
    const time2 = Date.now() - start2;

    // The second call must trigger the pool and dirCache instantly
    expect(time2).toBeLessThanOrEqual(50); // It should be near 1-10ms because it's purely memory cache
    expect(res2.result.content[0].text).toEqual(res1.result.content[0].text);
  });

  it('Should utilize startLine and endLine for ftp_get_contents (Auto-Chunking)', async () => {
    const res = await executeMCP('ftp_get_contents', { path: '/hello.txt', startLine: 2, endLine: 3 });
    if (res.result.isError) console.error("Chunking Error:", res.result.content[0].text);
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('Showing lines 2 to 3 of 6');
    expect(res.result.content[0].text).toContain('Line 2');
    expect(res.result.content[0].text).toContain('Line 3');
    expect(res.result.content[0].text).not.toContain('Line 4');
  });

  it('Should wipe the cache upon a destructive command like ftp_put_contents', async () => {
    // Write new file
    const resDestructive = await executeMCP('ftp_put_contents', { path: '/new_cache_destroy.txt', content: 'test' });
    if (resDestructive.result.isError) console.error("Put Content Error:", resDestructive.result.content[0].text);
    expect(resDestructive.result.isError).toBeUndefined();

    // The cache is wiped, so a list request should take longer > 0ms via socket protocol
    const resList = await executeMCP('ftp_list', { path: '.' });
    expect(resList.result.content[0].text).toContain('new_cache_destroy.txt');
  });

  it('Should simulate Dry Run sync without pushing data via ftp_sync', async () => {
    const sourceDir = path.join(process.cwd(), 'Test', 'local-mock');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'sync1.txt'), 'Sync Data');

    const resSync = await executeMCP('ftp_sync', { localPath: sourceDir, remotePath: '/sync-dir', dryRun: true });

    expect(resSync.result.isError).toBeUndefined();
    expect(resSync.result.content[0].text).toContain('[DRY RUN]');
    expect(resSync.result.content[0].text).toContain('Uploaded: 1'); // Detected as needed upload

    // Ensure the folder wasn't actually created on FTP
    const resList = await executeMCP('ftp_list', { path: '.' });
    expect(resList.result.content[0].text).not.toContain('sync-dir');

    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  it.skip('Should block destructive operations if readOnly mode is active (TODO: requires MCP process restart)', async () => {
    // Rewrite config to readOnly
    const mockConfig = {
      default: {
        host: `127.0.0.1`,
        user: "anonymous",
        password: "",
        port: FTP_PORT,
        readOnly: true
      }
    };
    await fs.writeFile(configPath, JSON.stringify(mockConfig), 'utf8');

    // QUAL-7: This test cannot be properly implemented without restarting the MCP
    // subprocess after changing the config, since currentConfig is module-level state.
    // The readOnly guard itself is covered by the policyEngine unit, not this E2E test.
    // Tracked: implement by spawning a second MCP instance with readOnly config.
  });

  it('Should utilize ftp_patch_file correctly via Unified Diff patching', async () => {
    // Original contents: Hello World!\nLine 2\nLine 3\nLine 4\nLine 5\n
    // Patch string:
    const patchStr = `
--- hello.txt
+++ hello.txt
@@ -1,3 +1,3 @@
-Hello World!
+Hello MCP!
 Line 2
 Line 3
`;
    // We send patch
    const resPatch = await executeMCP('ftp_patch_file', { path: '/hello.txt', patch: patchStr });
    if (resPatch.result.isError) console.error("Patch Error:", resPatch.result.content[0].text);
    expect(resPatch.result.isError).toBeUndefined();

    // Verify changes
    const read = await executeMCP('ftp_get_contents', { path: '/hello.txt' });
    expect(read.result.content[0].text).toContain('Hello MCP!');
    expect(read.result.content[0].text).not.toContain('Hello World!');
  });
});
