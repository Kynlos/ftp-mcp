import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ftpSrvModule from 'ftp-srv';
const FtpSrv = ftpSrvModule.FtpSrv || ftpSrvModule.default || ftpSrvModule;
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

describe('FTP Protocol Integrity & State Safety Tests', () => {
  let ftpServer;
  let mcpProcess;
  const FTP_PORT = 2126;
  const configPath = path.join(process.cwd(), '.ftpconfig_integrity');
  const mockRoot = path.join(process.cwd(), 'Test', 'integrity-mock');

  // Increase global timeout for these E2E tests
  const TEST_TIMEOUT = 15000;

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
        } catch (e) { }
      };
      mcpProcess.stdout.on('data', onData);
      mcpProcess.stdin.write(JSON.stringify(req) + '\n');
    });
  };

  beforeAll(async () => {
    ftpServer = new FtpSrv({ url: `ftp://127.0.0.1:${FTP_PORT}`, anonymous: true });
    await fs.mkdir(mockRoot, { recursive: true });
    ftpServer.on('login', (_, resolve) => resolve({ root: mockRoot }));
    await ftpServer.listen();

    const mockConfig = {
      default: { host: `127.0.0.1`, user: "anonymous", password: "", port: FTP_PORT }
    };
    await fs.writeFile(configPath, JSON.stringify(mockConfig), 'utf8');

    mcpProcess = spawn('node', ['index.js'], { 
      cwd: process.cwd(),
      env: { ...process.env, FTP_CONFIG_PATH: configPath }
    });
    await new Promise(r => setTimeout(r, 1500));
    await executeMCP('ftp_connect', { profile: 'default' });
  });

  afterAll(async () => {
    if (mcpProcess) mcpProcess.kill();
    if (ftpServer) ftpServer.close();
    await fs.unlink(configPath).catch(() => {});
    await fs.rm(mockRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('Should remain at root CWD after creating a nested directory', async () => {
    // 1. Create nested dir
    const resMkdir = await executeMCP('ftp_mkdir', { path: 'a/b/c/d' });
    expect(resMkdir.result.isError).toBeUndefined();

    // 2. Verify CWD is still root by listing "." and checking for "a"
    const resList = await executeMCP('ftp_list', { path: '.' });
    expect(resList.result.content[0].text).toContain('a');
    // If it leaked, it would be in D or empty.
  }, TEST_TIMEOUT);

  it('Should remain at root CWD after uploading to a nested path', async () => {
    const localFile = path.join(process.cwd(), 'Test', 'integrity-local.txt');
    await fs.writeFile(localFile, 'integrity test');

    const resUpload = await executeMCP('ftp_upload', { localPath: localFile, remotePath: 'deep/nested/file.txt' });
    expect(resUpload.result.isError).toBeUndefined();

    // Verify CWD
    const resList = await executeMCP('ftp_list', { path: '.' });
    expect(resList.result.content[0].text).toContain('deep');
    expect(resList.result.content[0].text).not.toContain('file.txt'); // file.txt is inside deep/nested

    await fs.unlink(localFile);
  }, TEST_TIMEOUT);

  it('Should remain at root CWD after putting contents to a new nested path', async () => {
    const resPut = await executeMCP('ftp_put_contents', { path: 'new/put/test.txt', content: 'hello' });
    expect(resPut.result.isError).toBeUndefined();

    // Verify CWD
    const resList = await executeMCP('ftp_list', { path: '.' });
    expect(resList.result.content[0].text).toContain('new');
  }, TEST_TIMEOUT);

  it('Should remain at root CWD after a batch upload to varied paths', async () => {
    const f1 = path.join(process.cwd(), 'Test', 'f1.txt');
    const f2 = path.join(process.cwd(), 'Test', 'f2.txt');
    await fs.writeFile(f1, '1');
    await fs.writeFile(f2, '2');

    const resBatch = await executeMCP('ftp_batch_upload', { 
      files: [
        { localPath: f1, remotePath: 'batch/one/f1.txt' },
        { localPath: f2, remotePath: 'batch/two/f2.txt' }
      ]
    });
    expect(resBatch.result.isError).toBeUndefined();

    // Verify CWD
    const resList = await executeMCP('ftp_list', { path: '.' });
    expect(resList.result.content[0].text).toContain('batch');

    await fs.unlink(f1);
    await fs.unlink(f2);
  }, TEST_TIMEOUT);
});
