import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export class SyncManifestManager {
    constructor(baseDir = process.cwd()) {
        this.manifestPath = path.join(baseDir, '.ftp-mcp-sync-manifest.json');
        this.manifest = {};
    }

    async load() {
        try {
            const data = await fs.readFile(this.manifestPath, 'utf8');
            this.manifest = JSON.parse(data);
        } catch (e) {
            this.manifest = {};
        }
    }

    async save() {
        try {
            await fs.writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
        } catch (e) {
            console.error('Failed to save sync manifest:', e);
        }
    }

    async getFileHash(filePath) {
        try {
            const content = await fs.readFile(filePath);
            return crypto.createHash('sha256').update(content).digest('hex');
        } catch (e) {
            return null;
        }
    }

    async isFileChanged(localPath, remotePath, localStat) {
        const key = `${localPath}:${remotePath}`;
        const entry = this.manifest[key];

        if (!entry) {
            return true; // Never synced before
        }

        // Fast check: size and mtime
        if (entry.size === localStat.size && entry.mtime === localStat.mtime.getTime()) {
            return false; // Likely unchanged
        }

        // Slower check: hash (if size/mtime changed but content might be same)
        const currentHash = await this.getFileHash(localPath);
        if (currentHash && entry.hash === currentHash) {
            // Update manifest with new mtime/size but don't sync
            this.updateEntry(localPath, remotePath, localStat, currentHash);
            return false;
        }

        return true;
    }

    async updateEntry(localPath, remotePath, localStat, hash = null) {
        const key = `${localPath}:${remotePath}`;
        this.manifest[key] = {
            size: localStat.size,
            mtime: localStat.mtime.getTime(),
            hash: hash || await this.getFileHash(localPath),
            lastSynced: new Date().toISOString()
        };
    }

    removeEntry(localPath, remotePath) {
        const key = `${localPath}:${remotePath}`;
        delete this.manifest[key];
    }
}
