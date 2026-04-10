import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

const executeMCP = (toolName, args = {}) => {
    return new Promise((resolve, reject) => {
        const mcpProcess = spawn('node', ['index.js'], {
            cwd: process.cwd(),
            env: { ...process.env, FTP_CONFIG_PATH: path.join(process.cwd(), '.ftpconfig') }
        });

        // Extended timeout for sync
        const timeoutDuration = toolName === 'ftp_sync' ? 300000 : 60000;
        const timeout = setTimeout(() => {
            mcpProcess.kill();
            reject(new Error(`Timeout waiting for response to ${toolName} after ${timeoutDuration/1000}s`));
        }, timeoutDuration);

        const requestId = "stress-test-" + Math.random().toString(36).substring(7);
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
                    if (!line.trim()) continue;
                    
                    // Look for logging notifications
                    if (line.includes('notifications/message') || line.includes('logging/message') || line.includes('[FTP-RAW]')) {
                        console.log(`   [DEBUG] ${line.trim()}`);
                    }

                    if (line.includes(requestId)) {
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
            } catch (e) {}
        });

        mcpProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg.includes('FTP-RAW')) {
                console.log(`   [DEBUG] ${msg}`);
            } else if (msg) {
                // console.error(`[ERR] ${msg}`);
            }
        });

        mcpProcess.stdin.write(JSON.stringify(req) + '\n');
    });
};

async function runStressTest() {
    console.log("🏙️ Starting FULL PROJECT STRESS TEST...");
    const targetFolder = 'FlowdexMCP_LiveTest';

    try {
        console.log("\n1. Connecting and creating target folder...");
        await executeMCP('ftp_connect', { profile: 'default' });
        await executeMCP('ftp_mkdir', { path: targetFolder });
        console.log("   ✅ Target folder ready.");

        console.log("\n2. SYNCING ENTIRE PROJECT (This may take a minute)...");
        const start = Date.now();
        const sync = await executeMCP('ftp_sync', { 
            localPath: '.', 
            remotePath: targetFolder,
            direction: 'upload',
            useManifest: false // Force full comparison
        });
        const duration = (Date.now() - start) / 1000;
        
        if (sync.result.isError) {
            console.error("   ❌ Sync Failed:", sync.result.content[0].text);
            return;
        }
        console.log(`   ✅ Sync Complete in ${duration}s.`);
        console.log(sync.result.content[0].text);

        console.log("\n3. Analyzing uploaded workspace...");
        const analysis = await executeMCP('ftp_analyze_workspace', { path: targetFolder });
        console.log("   ✅ Analysis Result:\n", analysis.result.content[0].text.substring(0, 500), "...");

        console.log("\n4. Searching for sensitive files in remote...");
        const search = await executeMCP('ftp_search', { 
            path: targetFolder, 
            findLikelyConfigs: true 
        });
        console.log("   ✅ Search results (checking for leaks like .ftpconfig):");
        const searchResult = search.result.content[0].text;
        console.log(searchResult.substring(0, 500));
        
        if (searchResult.includes('.ftpconfig')) {
            console.error("   ⚠️ WARNING: .ftpconfig was found on the remote server! Sync ignore patterns might be failing.");
        } else {
            console.log("   ✅ Security Check Passed: .ftpconfig was NOT found.");
        }

        console.log("\n5. Cleaning up...");
        await executeMCP('ftp_rmdir', { path: targetFolder, recursive: true });
        console.log("   ✅ Cleanup complete.");

        console.log("\n✨ STRESS TEST COMPLETED SUCCESSFULLY!");
    } catch (error) {
        console.error("\n❌ STRESS TEST FAILED:", error.message);
        // Attempt cleanup anyway
        await executeMCP('ftp_rmdir', { path: targetFolder, recursive: true }).catch(() => {});
    }
}

runStressTest();
