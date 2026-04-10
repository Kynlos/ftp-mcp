import { spawn } from 'child_process';
import path from 'path';

const executeMCP = (toolName, args = {}) => {
    return new Promise((resolve, reject) => {
        const mcpProcess = spawn('node', ['index.js'], {
            cwd: process.cwd(),
            env: { ...process.env, FTP_CONFIG_PATH: path.join(process.cwd(), '.ftpconfig') }
        });

        const timeout = setTimeout(() => {
            mcpProcess.kill();
            reject(new Error(`Timeout waiting for response`));
        }, 120000);

        const requestId = "test-" + Math.random().toString(36).substring(7);
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

        mcpProcess.stdin.write(JSON.stringify(req) + '\n');
    });
};

async function runDeployAndVerify() {
    console.log("🏙️ Deploying Full Project...");
    const targetFolder = 'FullProjectDeploy';

    try {
        await executeMCP('ftp_rmdir', { path: targetFolder, recursive: true }).catch(() => {});
        console.log("   ✅ Target reset.");

        const start = Date.now();
        const sync = await executeMCP('ftp_sync', { 
            localPath: '.', 
            remotePath: targetFolder,
            direction: 'upload',
            useManifest: false
        });
        const duration = (Date.now() - start) / 1000;
        
        console.log(`   ✅ Sync Complete in ${duration}s.`);
        console.log(sync.result?.content[0]?.text);

        console.log("\n🔍 Listing top level of deployed directory:");
        const listOutput = await executeMCP('ftp_list', { path: targetFolder });
        console.log(listOutput.result?.content[0]?.text);
        
        console.log("\n🔍 Analyzing architectural contents:");
        const analysis = await executeMCP('ftp_analyze_workspace', { path: targetFolder });
        console.log(analysis.result?.content[0]?.text);

    } catch (e) {
        console.error("❌ FAILED:", e.message);
    }
}

runDeployAndVerify();
