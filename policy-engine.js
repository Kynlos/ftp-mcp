import { minimatch } from 'minimatch';

export class PolicyEngine {
    constructor(profileConfig) {
        this.config = profileConfig || {};
        this.policies = this.config.policies || {};
    }

    checkAllowedPath(filePath) {
        if (!this.policies.allowedPaths || this.policies.allowedPaths.length === 0) {
            return true; // No restriction
        }
        return this.policies.allowedPaths.some(allowed => {
            // Normalize: ensure trailing slash to prevent /var/www matching /var/www-evil
            const normalizedAllowed = allowed.endsWith('/') ? allowed : allowed + '/';
            const normalizedPath = filePath.endsWith('/') ? filePath : filePath + '/';
            return normalizedPath.startsWith(normalizedAllowed) || filePath === allowed;
        });
    }

    checkBlockedGlob(filePath) {
        if (!this.policies.blockedGlobs || this.policies.blockedGlobs.length === 0) {
            return false; // Not blocked
        }
        return this.policies.blockedGlobs.some(pattern => minimatch(filePath, pattern));
    }

    checkFileSize(size) {
        if (!this.policies.maxFileSize) {
            return true; // No restriction
        }
        return size <= this.policies.maxFileSize;
    }

    checkNeverDelete(filePath) {
        if (!this.policies.neverDelete || this.policies.neverDelete.length === 0) {
            return false; // Deletion allowed
        }
        return this.policies.neverDelete.some(pattern => minimatch(filePath, pattern));
    }

    checkPatchOnly(filePath) {
        if (!this.policies.patchOnly || this.policies.patchOnly.length === 0) {
            return false; // Full overwrite allowed
        }
        return this.policies.patchOnly.some(pattern => minimatch(filePath, pattern));
    }

    validateOperation(operation, params) {
        const { path: filePath, size } = params;

        if (filePath) {
            if (!this.checkAllowedPath(filePath)) {
                throw new Error(`Policy Violation: Path '${filePath}' is not in allowedPaths.`);
            }

            if (this.checkBlockedGlob(filePath)) {
                throw new Error(`Policy Violation: Path '${filePath}' matches a blocked glob pattern.`);
            }
        }

        if (size !== undefined && !this.checkFileSize(size)) {
            throw new Error(`Policy Violation: File size ${size} exceeds maxFileSize of ${this.policies.maxFileSize}.`);
        }

        if (operation === 'delete' && filePath && this.checkNeverDelete(filePath)) {
            throw new Error(`Policy Violation: Deletion of '${filePath}' is blocked by neverDelete policy.`);
        }

        if (operation === 'overwrite' && filePath && this.checkPatchOnly(filePath)) {
            throw new Error(`Policy Violation: Full overwrite of '${filePath}' is blocked. Use patch only.`);
        }

        return true;
    }
}
