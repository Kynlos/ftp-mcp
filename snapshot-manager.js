import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Writable } from 'stream';

const MAX_SNAPSHOTS = 50;

export class SnapshotManager {
    constructor(baseDir = process.cwd()) {
        this.snapshotDir = path.join(baseDir, '.ftp-mcp-snapshots');
    }

    async init() {
        try {
            await fs.mkdir(this.snapshotDir, { recursive: true });
        } catch (e) {
            // Ignore if exists
        }
    }

    async pruneOldSnapshots(maxToKeep = MAX_SNAPSHOTS) {
        try {
            const dirs = await fs.readdir(this.snapshotDir, { withFileTypes: true });
            const txDirs = dirs
                .filter(d => d.isDirectory() && d.name.startsWith('tx_'))
                .map(d => ({ name: d.name, ts: parseInt(d.name.split('_')[1]) || 0 }))
                .sort((a, b) => b.ts - a.ts);

            if (txDirs.length > maxToKeep) {
                for (const dir of txDirs.slice(maxToKeep)) {
                    await fs.rm(path.join(this.snapshotDir, dir.name), { recursive: true, force: true });
                }
            }
        } catch (e) {
            // Ignore pruning errors
        }
    }

    generateTransactionId() {
        return `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    async createSnapshot(client, useSFTP, remotePaths, transactionId = null) {
        await this.init();
        const txId = transactionId || this.generateTransactionId();
        const txDir = path.join(this.snapshotDir, txId);
        await fs.mkdir(txDir, { recursive: true });

        const manifest = {
            transactionId: txId,
            timestamp: new Date().toISOString(),
            files: []
        };

        for (const remotePath of remotePaths) {
            try {
                // Check if file exists and is a file
                let isFile = false;
                try {
                    if (useSFTP) {
                        const stat = await client.stat(remotePath);
                        isFile = stat.isFile;
                    } else {
                        const dirPath = remotePath.substring(0, remotePath.lastIndexOf('/')) || '.';
                        const fileName = remotePath.substring(remotePath.lastIndexOf('/') + 1);
                        const files = await client.list(dirPath);
                        const file = files.find(f => f.name === fileName);
                        if (file) isFile = file.isFile;
                    }
                } catch (e) {
                    // File doesn't exist, record as 'deleted' state for rollback
                    manifest.files.push({
                        remotePath,
                        status: 'not_found_before_tx'
                    });
                    continue;
                }

                if (isFile) {
                    const localSnapshotPath = path.join(txDir, crypto.createHash('sha256').update(remotePath).digest('hex'));

                    if (useSFTP) {
                        await client.get(remotePath, localSnapshotPath);
                    } else {
                        await client.downloadTo(localSnapshotPath, remotePath);
                    }

                    manifest.files.push({
                        remotePath,
                        localSnapshotPath: path.relative(this.snapshotDir, localSnapshotPath),
                        status: 'snapshotted'
                    });
                }
            } catch (error) {
                console.error(`Failed to snapshot ${remotePath}:`, error);
                manifest.files.push({
                    remotePath,
                    status: 'error',
                    error: error.message
                });
            }
        }

        await fs.writeFile(
            path.join(txDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
            'utf8'
        );

        // Auto-prune old snapshots to prevent unbounded disk growth
        await this.pruneOldSnapshots();

        return txId;
    }

    async getTransactionManifest(transactionId) {
        const manifestPath = path.join(this.snapshotDir, transactionId, 'manifest.json');
        try {
            const data = await fs.readFile(manifestPath, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            throw new Error(`Transaction ${transactionId} not found or invalid.`);
        }
    }

    async listTransactions() {
        await this.init();
        const dirs = await fs.readdir(this.snapshotDir, { withFileTypes: true });
        const transactions = [];

        for (const dir of dirs) {
            if (dir.isDirectory() && dir.name.startsWith('tx_')) {
                try {
                    const manifest = await this.getTransactionManifest(dir.name);
                    transactions.push(manifest);
                } catch (e) {
                    // Skip invalid
                }
            }
        }

        return transactions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    async rollback(client, useSFTP, transactionId) {
        const manifest = await this.getTransactionManifest(transactionId);
        const results = { restored: [], deleted: [], failed: [] };

        for (const file of manifest.files) {
            try {
                if (file.status === 'snapshotted') {
                    const localPath = path.join(this.snapshotDir, file.localSnapshotPath);
                    if (useSFTP) {
                        await client.put(localPath, file.remotePath);
                    } else {
                        await client.uploadFrom(localPath, file.remotePath);
                    }
                    results.restored.push(file.remotePath);
                } else if (file.status === 'not_found_before_tx') {
                    // File didn't exist before, so we should delete it to rollback
                    try {
                        if (useSFTP) {
                            await client.delete(file.remotePath);
                        } else {
                            await client.remove(file.remotePath);
                        }
                        results.deleted.push(file.remotePath);
                    } catch (e) {
                        // Might already be deleted
                    }
                }
            } catch (error) {
                results.failed.push({ path: file.remotePath, error: error.message });
            }
        }

        return results;
    }
}
