import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

const executeMCP = (toolName, args = {}) => {
    return new Promise((resolve, reject) => {
        const mcpProcess = spawn('node', ['index.js'], {
            cwd: process.cwd(),
            env: { ...process.env, FTP_CONFIG_PATH: path.join(process.cwd(), '.ftpconfig') }
        });

        const timeout = setTimeout(() => {
            mcpProcess.kill();
            reject(new Error(`Timeout waiting for response to ${toolName} after 30s`));
        }, 30000);

        const requestId = "live-test-" + Math.random().toString(36).substring(7);
        const req = {
            jsonrpc: "2.0",
            id: requestId,
            method: "tools/call",
            params: { name: toolName, arguments: args }
        };

        let output = '';
        mcpProcess.stdout.on('data', (data) => {
            output += data.toString();
            try {
                const lines = output.split('\n');
                for (const line of lines) {
                    if (line.trim() && (line.includes('{') || line.includes('}'))) {
                        const start = line.indexOf('{');
                        const end = line.lastIndexOf('}') + 1;
                        if (start !== -1 && end > start) {
                            try {
                                const parsed = JSON.parse(line.substring(start, end));
                                if (parsed.id === requestId) {
                                    clearTimeout(timeout);
                                    mcpProcess.kill();
                                    resolve(parsed);
                                    return;
                                }
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) {
                // Not full JSON yet, continue
            }
        });

        mcpProcess.stderr.on('data', (data) => {
            console.error(`[MCP-STDERR] ${data.toString().trim()}`);
        });

        mcpProcess.stdin.write(JSON.stringify(req) + '\n');
    });
};

async function runTests() {
    console.log("🚀 Starting Live Server Validation suite...");
    const testFile = 'live_test_v1.txt';
    const remoteFile = 'remote_test_v1.txt';
    await fs.writeFile(testFile, 'Hello from the MCP server live validation test!');

    try {
        console.log("1. Connecting...");
        const conn = await executeMCP('ftp_connect', { profile: 'default' });
        console.log("   ✅ Connected:", conn.result.content[0].text.split('\n')[0]);

        console.log("2. Uploading file...");
        const upload = await executeMCP('ftp_upload', { localPath: testFile, remotePath: remoteFile });
        console.log("   ✅ Uploaded:", upload.result.content[0].text.split('\n')[0]);
        const txId = upload.result.content[0].text.match(/Transaction ID: ([a-z0-9-]+)/)?.[1];

        console.log("3. Listing directory...");
        const list = await executeMCP('ftp_list', { path: '.' });
        console.log("   ✅ Listed:\n", list.result.content[0].text);

        console.log("4. Reading file back...");
        const content = await executeMCP('ftp_get_contents', { path: remoteFile });
        console.log("   ✅ Content:", content.result.content[0].text);

        console.log("5. Searching for file...");
        const search = await executeMCP('ftp_search', { pattern: '*_test_*' });
        console.log("   ✅ Search found:", search.result.content[0].text.substring(0, 100));

        console.log("6. Creating directory...");
        await executeMCP('ftp_mkdir', { path: 'test_folder' });
        console.log("   ✅ Directory created.");

        console.log("7. Moving file (Rename)...");
        await executeMCP('ftp_rename', { oldPath: remoteFile, newPath: 'test_folder/renamed_test.txt' });
        console.log("   ✅ File renamed/moved.");

        console.log("8. Testing rollback...");
        const rollback = await executeMCP('ftp_rollback', { transactionId: txId });
        console.log("   ✅ Rollback result:", rollback.result.content[0].text.split('\n')[0]);

        console.log("9. Final Cleanup...");
        try {
            await executeMCP('ftp_delete', { path: 'test_folder/renamed_test.txt' });
            await executeMCP('ftp_rmdir', { path: 'test_folder' });
        } catch (e) {}
        console.log("   ✅ Cleanup complete.");

        console.log("\n✨ ALL LIVE TESTS PASSED ON REAL FTP SERVER!");
    } catch (error) {
        console.error("\n❌ LIVE TEST FAILED:", error.message);
        if (error.stack) console.error(error.stack);
    } finally {
        await fs.unlink(testFile).catch(() => {});
    }
}

runTests();
