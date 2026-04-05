#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client as FTPClient } from "basic-ftp";
import SFTPClient from "ssh2-sftp-client";
import fs from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ignore from "ignore";
import * as diff from "diff";
import { z } from "zod";
import "dotenv/config";
import { Writable, Readable } from "stream";
import { SnapshotManager } from "./snapshot-manager.js";
import { PolicyEngine } from "./policy-engine.js";
import { SyncManifestManager } from "./sync-manifest.js";
import crypto from "crypto";
const DEFAULT_CONFIG_NAME = ".ftpconfig";
const CONFIG_FILE = process.env.FTP_CONFIG_PATH || path.join(process.cwd(), DEFAULT_CONFIG_NAME);

// --init: scaffold .ftpconfig.example into the user's current working directory
if (process.argv.includes("--init")) {
  try {
    const { intro, outro, text, password: promptPassword, select, confirm, note } = await import("@clack/prompts");

    intro('🚀 Welcome to FTP-MCP Initialization Wizard');

    const host = await text({
      message: 'Enter your FTP/SFTP Host (e.g. sftp://ftp.example.com)',
      placeholder: 'sftp://127.0.0.1',
      validate: (val) => val.length === 0 ? "Host is required!" : undefined,
    });

    const user = await text({
      message: 'Enter your Username',
      validate: (val) => val.length === 0 ? "User is required!" : undefined,
    });

    const pass = await promptPassword({
      message: 'Enter your Password (optional if using keys)',
    });

    const port = await text({
      message: 'Enter port (optional, defaults to 21 for FTP, 22 for SFTP)',
      placeholder: '22'
    });

    const isSFTP = host.startsWith('sftp://');
    let privateKey = '';

    if (isSFTP) {
      const usesKey = await confirm({ message: 'Are you using an SSH Private Key instead of a password?' });
      if (usesKey) {
        privateKey = await text({
          message: 'Path to your private key (e.g. ~/.ssh/id_rsa)',
        });
      }
    }

    const config = {
      default: {
        host: host,
        user: user,
      }
    };

    if (pass) config.default.password = pass;
    if (port) config.default.port = parseInt(port, 10);
    if (privateKey) config.default.privateKey = privateKey;

    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

    note(`✅ Successfully generated config file at:\n${CONFIG_FILE}`, 'Success');

    outro("You're ready to deploy with MCP! Ask your AI to 'list remote files'");
  } catch (err) {
    console.error(`❌ Init failed: ${err.message}`);
  }
  process.exit(0);
}


let currentConfig = null;
let currentProfile = null;

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  '.env',
  '.env.*',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  '.vscode/**',
  '.idea/**',
  '*.swp',
  '*.swo',
  '*~',
  '.ftpconfig',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
  '.npm',
  '.cache/**',
  'coverage/**',
  '.nyc_output/**',
  '*.pid',
  '*.seed',
  '*.pid.lock'
];

async function loadIgnorePatterns(localPath) {
  const patterns = [...DEFAULT_IGNORE_PATTERNS];

  try {
    const ftpignorePath = path.join(localPath, '.ftpignore');
    const ftpignoreContent = await fs.readFile(ftpignorePath, 'utf8');
    const ftpignorePatterns = ftpignoreContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    patterns.push(...ftpignorePatterns);
  } catch (e) {
    // .ftpignore doesn't exist, that's fine
  }

  try {
    const gitignorePath = path.join(localPath, '.gitignore');
    const gitignoreContent = await fs.readFile(gitignorePath, 'utf8');
    const gitignorePatterns = gitignoreContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    patterns.push(...gitignorePatterns);
  } catch (e) {
    // .gitignore doesn't exist, that's fine
  }

  return patterns;
}

function isSecretFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return name === '.env' ||
    name.startsWith('.env.') ||
    name.endsWith('.key') ||
    name.endsWith('.pem') ||
    name.endsWith('.p12') ||
    name.includes('id_rsa') ||
    name.includes('secret') ||
    name.includes('token');
}

function shouldIgnore(filePath, ignorePatterns, basePath) {
  const relativePath = path.relative(basePath, filePath).replace(/\\/g, '/');

  if (!ignorePatterns._ig) {
    Object.defineProperty(ignorePatterns, '_ig', {
      value: ignore().add(ignorePatterns),
      enumerable: false
    });
  }

  return ignorePatterns._ig.ignores(relativePath);
}

const ProfileConfigSchema = z.object({
  host: z.string().min(1, "Hostname is required"),
  user: z.string().min(1, "Username is required"),
  password: z.string().optional(),
  port: z.union([z.string(), z.number()]).optional(),
  secure: z.union([z.boolean(), z.literal("implicit")]).optional(),
  readOnly: z.boolean().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  agent: z.string().optional(),
  policies: z.object({
    allowedPaths: z.array(z.string()).optional(),
    blockedGlobs: z.array(z.string()).optional(),
    maxFileSize: z.number().optional(),
    neverDelete: z.array(z.string()).optional(),
    patchOnly: z.array(z.string()).optional()
  }).optional()
}).passthrough();

async function loadFTPConfig(profileName = null, forceEnv = false) {
  if (forceEnv) {
    return {
      host: process.env.FTPMCP_HOST,
      user: process.env.FTPMCP_USER,
      password: process.env.FTPMCP_PASSWORD,
      port: process.env.FTPMCP_PORT
    };
  }

  try {
    const configPath = CONFIG_FILE;
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);

    if (profileName) {
      if (config[profileName]) {
        currentProfile = profileName;
        return ProfileConfigSchema.parse(config[profileName]);
      }
      throw new Error(`Profile "${profileName}" not found in .ftpconfig`);
    }

    if (config.default) {
      currentProfile = 'default';
      return ProfileConfigSchema.parse(config.default);
    }

    const profiles = Object.keys(config).filter(k => k !== 'deployments');
    if (profiles.length > 0) {
      currentProfile = profiles[0];
      return ProfileConfigSchema.parse(config[profiles[0]]);
    }

    throw new Error('No profiles found in .ftpconfig');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        host: process.env.FTPMCP_HOST,
        user: process.env.FTPMCP_USER,
        password: process.env.FTPMCP_PASSWORD,
        port: process.env.FTPMCP_PORT
      };
    }
    throw error;
  }
}

function getPort(host, configPort) {
  if (configPort) return parseInt(configPort);
  if (host && (host.includes('sftp') || host.startsWith('sftp://'))) return 22;
  return 21;
}

function isSFTP(host) {
  return host && (host.includes('sftp') || host.startsWith('sftp://'));
}

async function connectFTP(config) {
  const client = new FTPClient();
  client.ftp.verbose = false;
  await client.access({
    host: config.host,
    user: config.user,
    password: config.password,
    port: getPort(config.host, config.port),
    secure: config.secure || false
  });
  return client;
}

async function connectSFTP(config) {
  const client = new SFTPClient();
  const connSettings = {
    host: config.host.replace('sftp://', ''),
    port: getPort(config.host, config.port),
    username: config.user,
    password: config.password
  };

  if (config.privateKey) connSettings.privateKey = readFileSync(path.resolve(config.privateKey), 'utf8');
  if (config.passphrase) connSettings.passphrase = config.passphrase;
  if (config.agent) connSettings.agent = config.agent;

  await client.connect(connSettings);
  return client;
}

const connectionPool = new Map();
const connectingPromises = new Map();
const dirCache = new Map();
const CACHE_TTL = 15000;
const snapshotManager = new SnapshotManager();
const syncManifestManager = new SyncManifestManager();

const telemetry = {
  activeConnections: 0,
  cacheHits: 0,
  cacheMisses: 0,
  reconnects: 0,
  bytesTransferred: 0,
  syncDurations: []
};

function getPoolKey(config) {
  return `${config.host}:${getPort(config.host, config.port)}:${config.user}`;
}

function getCached(poolKey, type, path) {
  const entry = dirCache.get(`${poolKey}:${type}:${path}`);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    telemetry.cacheHits++;
    return entry.data;
  }
  telemetry.cacheMisses++;
  return null;
}

function setCached(poolKey, type, path, data) {
  dirCache.set(`${poolKey}:${type}:${path}`, { timestamp: Date.now(), data });
}

function invalidatePoolCache(poolKey) {
  for (const key of dirCache.keys()) {
    if (key.startsWith(`${poolKey}:`)) {
      dirCache.delete(key);
    }
  }
}

async function getClient(config) {
  const poolKey = getPoolKey(config);

  // 1. If we are already connecting to this host, wait for it
  if (connectingPromises.has(poolKey)) {
    return connectingPromises.get(poolKey);
  }

  let existing = connectionPool.get(poolKey);

  if (existing && !existing.closed) {
    if (existing.idleTimeout) clearTimeout(existing.idleTimeout);
    return existing;
  }

  const connectPromise = (async () => {
    try {
      telemetry.reconnects++;
      const useSFTP = isSFTP(config.host);
      const client = useSFTP ? await connectSFTP(config) : await connectFTP(config);
      telemetry.activeConnections++;

      client._isSFTP = useSFTP;
      
      // Silence MaxListenersExceededWarning during high-activity syncs/sessions
      if (typeof client.setMaxListeners === 'function') {
        client.setMaxListeners(100);
      } else if (client.ftp && typeof client.ftp.socket.setMaxListeners === 'function') {
        client.ftp.socket.setMaxListeners(100);
      }

      const entry = {
        client,
        closed: false,
        promiseQueue: Promise.resolve(),
        async execute(task) {
          // Use a simple promise chain to serialize operations on this client
          const result = this.promiseQueue.then(() => task(this.client));
          this.promiseQueue = result.catch(() => {}); // Continue queue even on error
          return result;
        }
      };

      const onClose = () => handleClientClose(poolKey);

      if (useSFTP) {
        client.on('end', onClose);
        client.on('error', onClose);
        client.on('close', onClose);
      } else {
        client.ftp.socket.on('close', onClose);
        client.ftp.socket.on('error', onClose);
      }

      connectionPool.set(poolKey, entry);
      return entry;
    } finally {
      connectingPromises.delete(poolKey);
    }
  })();

  connectingPromises.set(poolKey, connectPromise);
  return connectPromise;
}

function handleClientClose(poolKey) {
  const existing = connectionPool.get(poolKey);
  if (existing) {
    existing.closed = true;
    connectionPool.delete(poolKey);
    telemetry.activeConnections = Math.max(0, telemetry.activeConnections - 1);
  }
}

function redactSecrets(obj) {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return obj.replace(/(password|secret|key|token|passphrase)["':\s=]+[^\s,;}"']+/gi, '$1: [REDACTED]');
  }
  if (typeof obj !== 'object') return obj;

  const redacted = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase().match(/(password|secret|key|token|passphrase)/)) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object') {
      redacted[key] = redactSecrets(value);
    } else if (typeof value === 'string') {
      redacted[key] = redactSecrets(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

async function auditLog(toolName, args, status, user, errorMsg = null) {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      tool: toolName,
      user: user || 'system',
      status,
      arguments: redactSecrets(args),
      error: redactSecrets(errorMsg)
    };
    await fs.appendFile(path.join(process.cwd(), '.ftp-mcp-audit.log'), JSON.stringify(logEntry) + '\n', 'utf8');
  } catch (e) {
    // safely ignore audit log failures for now
  }
}

function releaseClient(config) {
  const poolKey = getPoolKey(config);
  const existing = connectionPool.get(poolKey);
  if (existing && !existing.closed) {
    if (existing.idleTimeout) clearTimeout(existing.idleTimeout);
    existing.idleTimeout = setTimeout(async () => {
      existing.closed = true;
      try {
        if (existing.client._isSFTP) await existing.client.end();
        else existing.client.close();
      } catch (e) { }
      connectionPool.delete(poolKey);
    }, 60000).unref();
  }
}

async function getTreeRecursive(client, useSFTP, remotePath, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return [];

  const files = useSFTP ? await client.list(remotePath) : await client.list(remotePath);
  const results = [];

  for (const file of files) {
    const isDir = useSFTP ? file.type === 'd' : file.isDirectory;
    const fileName = file.name;
    const fullPath = remotePath === '.' ? fileName : `${remotePath}/${fileName}`;

    results.push({
      path: fullPath,
      name: fileName,
      isDirectory: isDir,
      size: file.size,
      modified: file.modifyTime || file.date
    });

    if (isDir && fileName !== '.' && fileName !== '..') {
      const children = await getTreeRecursive(client, useSFTP, fullPath, depth + 1, maxDepth);
      results.push(...children);
    }
  }

  return results;
}

async function syncFiles(client, useSFTP, localPath, remotePath, direction, ignorePatterns = null, basePath = null, extraExclude = [], dryRun = false, useManifest = true) {
  const stats = { uploaded: 0, downloaded: 0, skipped: 0, errors: [], ignored: 0, filesToChange: [] };

  if (ignorePatterns === null) {
    ignorePatterns = await loadIgnorePatterns(localPath);
    basePath = localPath;
    if (useManifest) await syncManifestManager.load();
  }

  if (extraExclude.length > 0) {
    ignorePatterns = [...ignorePatterns, ...extraExclude];
  }

  if (direction === 'upload' || direction === 'both') {
    const localFiles = await fs.readdir(localPath, { withFileTypes: true });

    for (const file of localFiles) {
      const localFilePath = path.join(localPath, file.name);
      const remoteFilePath = `${remotePath}/${file.name}`;

      // In some environments (like Windows with ftp-srv), rapid transfers cause ECONNRESET.
      // A slightly longer delay helps stabilize the socket state during sequence.
      await new Promise(r => setTimeout(r, 250));

      // Security check first so we can warn even if it's in .gitignore/.ftpignore
      if (isSecretFile(localFilePath)) {
        if (dryRun) stats.filesToChange.push(localFilePath);
        stats.errors.push(`Security Warning: Blocked upload of likely secret file: ${localFilePath}`);
        continue;
      }

      if (shouldIgnore(localFilePath, ignorePatterns, basePath)) {
        stats.ignored++;
        continue;
      }

      try {
        if (file.isDirectory()) {
          if (!dryRun) {
            if (useSFTP) {
              await client.mkdir(remoteFilePath, true);
            } else {
              await client.ensureDir(remoteFilePath);
            }
          }
          const subStats = await syncFiles(client, useSFTP, localFilePath, remoteFilePath, direction, ignorePatterns, basePath, extraExclude, dryRun);
          stats.uploaded += subStats.uploaded;
          stats.downloaded += subStats.downloaded;
          stats.skipped += subStats.skipped;
          stats.ignored += subStats.ignored;
          stats.errors.push(...subStats.errors);
        } else {
          // isSecretFile already checked above in the loop
          const localStat = await fs.stat(localFilePath);
          let shouldUpload = true;

          // 1. Fast check using local manifest
          if (useManifest) {
            const changedLocally = await syncManifestManager.isFileChanged(localFilePath, remoteFilePath, localStat);
            if (!changedLocally) {
              shouldUpload = false;
              stats.skipped++;
            }
          }

          // 2. Slow check using remote stat
          if (shouldUpload) {
            try {
              const remoteStat = useSFTP
                ? await client.stat(remoteFilePath)
                : (await client.list(remotePath)).find(f => f.name === file.name);

              if (remoteStat) {
                const remoteTime = remoteStat.modifyTime || remoteStat.modifiedAt || new Date(remoteStat.rawModifiedAt);
                if (localStat.mtime <= remoteTime) {
                  shouldUpload = false;
                  stats.skipped++;
                  if (useManifest) await syncManifestManager.updateEntry(localFilePath, remoteFilePath, localStat);
                }
              }
            } catch (e) {
              // Remote file missing
            }
          }

          if (shouldUpload) {
            if (!dryRun) {
              let attempts = 0;
              const maxAttempts = 3;
              let success = false;
              let lastError;

              while (attempts < maxAttempts && !success) {
                try {
                  if (useSFTP) {
                    await client.put(localFilePath, remoteFilePath);
                  } else {
                    await client.uploadFrom(localFilePath, remoteFilePath);
                  }
                  success = true;
                } catch (err) {
                  attempts++;
                  lastError = err;
                  if (attempts < maxAttempts) {
                    await new Promise(r => setTimeout(r, 100 * attempts)); // Backoff
                  }
                }
              }

              if (success) {
                if (useManifest) await syncManifestManager.updateEntry(localFilePath, remoteFilePath, localStat);
                stats.uploaded++;
              } else {
                stats.errors.push(`${localFilePath}: Failed after ${maxAttempts} attempts: ${lastError.message}`);
              }
            } else {
              stats.filesToChange.push(localFilePath);
              stats.uploaded++;
            }
          }
        }
      } catch (error) {
        stats.errors.push(`${localFilePath}: ${error.message}`);
      }
    }
  }

  if (ignorePatterns === null && useManifest && !dryRun) {
    await syncManifestManager.save();
  }

  return stats;
}

function generateSemanticPreview(filesToChange) {
  const summary = {
    configFiles: [],
    dependencyManifests: [],
    riskyFiles: [],
    restartRequired: [],
    otherFiles: []
  };

  for (const file of filesToChange) {
    const name = path.basename(file).toLowerCase();

    if (name === 'package.json' || name === 'composer.json' || name === 'requirements.txt' || name === 'pom.xml' || name === 'go.mod') {
      summary.dependencyManifests.push(file);
      summary.restartRequired.push(file);
    } else if (name.endsWith('.config.js') || name.endsWith('.config.ts') || name === 'tsconfig.json' || name === 'vite.config.js' || name === 'next.config.js') {
      summary.configFiles.push(file);
      summary.restartRequired.push(file);
    } else if (isSecretFile(file) || name.includes('auth') || name.includes('deploy')) {
      summary.riskyFiles.push(file);
    } else {
      summary.otherFiles.push(file);
    }
  }

  let output = "Semantic Change Preview:\n========================\n";

  if (summary.dependencyManifests.length > 0) {
    output += `\n📦 Dependency Manifests Changed (High Impact):\n  - ${summary.dependencyManifests.join('\n  - ')}\n`;
  }
  if (summary.configFiles.length > 0) {
    output += `\n⚙️ Config Files Changed:\n  - ${summary.configFiles.join('\n  - ')}\n`;
  }
  if (summary.riskyFiles.length > 0) {
    output += `\n⚠️ Risky Files Touched (Secrets/Auth/Deploy):\n  - ${summary.riskyFiles.join('\n  - ')}\n`;
  }
  if (summary.restartRequired.length > 0) {
    output += `\n🔄 Likely Restart Required due to changes in:\n  - ${summary.restartRequired.join('\n  - ')}\n`;
  }

  output += `\n📄 Other Files: ${summary.otherFiles.length} files\n`;

  return output;
}

const server = new Server(
  {
    name: "ftp-mcp-server",
    version: "1.2.1",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ftp_connect",
        description: "Connect to a named FTP profile from .ftpconfig",
        inputSchema: {
          type: "object",
          properties: {
            profile: {
              type: "string",
              description: "Profile name from .ftpconfig (e.g., 'production', 'staging')"
            },
            useEnv: {
              type: "boolean",
              description: "Force use of environment variables instead of .ftpconfig",
              default: false
            }
          }
        }
      },
      {
        name: "ftp_deploy",
        description: "Run a named deployment preset from .ftpconfig",
        inputSchema: {
          type: "object",
          properties: {
            deployment: {
              type: "string",
              description: "Deployment name from .ftpconfig deployments (e.g., 'deploy-frontend', 'deploy-api')"
            }
          },
          required: ["deployment"]
        }
      },
      {
        name: "ftp_list_deployments",
        description: "List all available deployment presets from .ftpconfig",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "ftp_list",
        description: "List files and directories in a remote FTP/SFTP path",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote path to list (defaults to current directory)",
              default: "."
            },
            limit: {
              type: "number",
              description: "Maximum number of files to return",
              default: 100
            },
            offset: {
              type: "number",
              description: "Number of files to skip over",
              default: 0
            }
          }
        }
      },
      {
        name: "ftp_get_contents",
        description: "Read file content directly from FTP/SFTP without downloading",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote file path to read"
            },
            startLine: {
              type: "number",
              description: "Optional start line for reading chunk (1-indexed)"
            },
            endLine: {
              type: "number",
              description: "Optional end line for reading chunk (inclusive, 1-indexed)"
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_patch_file",
        description: "Apply a Unified Diff patch to a remote file",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote file path to patch"
            },
            patch: {
              type: "string",
              description: "Unified diff string containing the changes"
            },
            expectedHash: {
              type: "string",
              description: "Optional MD5 hash of the file before patching to prevent drift"
            },
            createBackup: {
              type: "boolean",
              description: "Create a .bak file before patching",
              default: true
            }
          },
          required: ["path", "patch"]
        }
      },
      {
        name: "ftp_analyze_workspace",
        description: "Semantically analyze a remote directory to detect project type and dependencies",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote directory path to analyze (defaults to current)",
              default: "."
            }
          }
        }
      },
      {
        name: "ftp_put_contents",
        description: "Write content directly to FTP/SFTP file without local file",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote file path to write"
            },
            content: {
              type: "string",
              description: "Content to write to the file"
            }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "ftp_stat",
        description: "Get file metadata (size, modified date, permissions)",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote file path"
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_exists",
        description: "Check if file or folder exists on FTP/SFTP server",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote path to check"
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_tree",
        description: "Get recursive directory listing (entire structure at once)",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote path to start tree from",
              default: "."
            },
            maxDepth: {
              type: "number",
              description: "Maximum depth to recurse",
              default: 10
            }
          }
        }
      },
      {
        name: "ftp_search",
        description: "Advanced remote search: find files by name, content, or type",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Filename search pattern (supports wildcards like *.js)"
            },
            contentPattern: {
              type: "string",
              description: "Regex pattern to search inside file contents (grep)"
            },
            extension: {
              type: "string",
              description: "Filter by file extension (e.g., '.js', '.php')"
            },
            findLikelyConfigs: {
              type: "boolean",
              description: "If true, prioritizes finding config, auth, and build files",
              default: false
            },
            path: {
              type: "string",
              description: "Remote path to search in",
              default: "."
            },
            limit: {
              type: "number",
              description: "Maximum results to return",
              default: 50
            },
            offset: {
              type: "number",
              description: "Results to skip over",
              default: 0
            }
          }
        }
      },
      {
        name: "ftp_copy",
        description: "Duplicate files on server (SFTP only)",
        inputSchema: {
          type: "object",
          properties: {
            sourcePath: {
              type: "string",
              description: "Source file path"
            },
            destPath: {
              type: "string",
              description: "Destination file path"
            }
          },
          required: ["sourcePath", "destPath"]
        }
      },
      {
        name: "ftp_batch_upload",
        description: "Upload multiple files at once",
        inputSchema: {
          type: "object",
          properties: {
            files: {
              type: "array",
              description: "Array of {localPath, remotePath} objects",
              items: {
                type: "object",
                properties: {
                  localPath: { type: "string" },
                  remotePath: { type: "string" }
                },
                required: ["localPath", "remotePath"]
              }
            }
          },
          required: ["files"]
        }
      },
      {
        name: "ftp_batch_download",
        description: "Download multiple files at once",
        inputSchema: {
          type: "object",
          properties: {
            files: {
              type: "array",
              description: "Array of {remotePath, localPath} objects",
              items: {
                type: "object",
                properties: {
                  remotePath: { type: "string" },
                  localPath: { type: "string" }
                },
                required: ["remotePath", "localPath"]
              }
            }
          },
          required: ["files"]
        }
      },
      {
        name: "ftp_sync",
        description: "Smart sync local ↔ remote (only changed files)",
        inputSchema: {
          type: "object",
          properties: {
            localPath: {
              type: "string",
              description: "Local directory path"
            },
            remotePath: {
              type: "string",
              description: "Remote directory path"
            },
            direction: {
              type: "string",
              description: "Sync direction: 'upload', 'download', or 'both'",
              enum: ["upload", "download", "both"],
              default: "upload"
            },
            dryRun: {
              type: "boolean",
              description: "If true, simulates the sync without transferring files",
              default: false
            },
            useManifest: {
              type: "boolean",
              description: "Use local manifest cache for faster deploys (drift-aware)",
              default: true
            }
          },
          required: ["localPath", "remotePath"]
        }
      },
      {
        name: "ftp_disk_space",
        description: "Check available space on server (SFTP only)",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote path to check",
              default: "."
            }
          }
        }
      },
      {
        name: "ftp_upload",
        description: "Upload a file to the FTP/SFTP server",
        inputSchema: {
          type: "object",
          properties: {
            localPath: {
              type: "string",
              description: "Local file path to upload"
            },
            remotePath: {
              type: "string",
              description: "Remote destination path"
            }
          },
          required: ["localPath", "remotePath"]
        }
      },
      {
        name: "ftp_download",
        description: "Download a file from the FTP/SFTP server",
        inputSchema: {
          type: "object",
          properties: {
            remotePath: {
              type: "string",
              description: "Remote file path to download"
            },
            localPath: {
              type: "string",
              description: "Local destination path"
            }
          },
          required: ["remotePath", "localPath"]
        }
      },
      {
        name: "ftp_delete",
        description: "Delete a file from the FTP/SFTP server",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote file path to delete"
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_mkdir",
        description: "Create a directory on the FTP/SFTP server",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote directory path to create"
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_rmdir",
        description: "Remove a directory from the FTP/SFTP server",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote directory path to remove"
            },
            recursive: {
              type: "boolean",
              description: "Remove directory recursively",
              default: false
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_chmod",
        description: "Change file permissions on the FTP/SFTP server (SFTP only)",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote file path"
            },
            mode: {
              type: "string",
              description: "Permission mode in octal (e.g., '755', '644')"
            }
          },
          required: ["path", "mode"]
        }
      },
      {
        name: "ftp_rename",
        description: "Rename or move a file on the FTP/SFTP server",
        inputSchema: {
          type: "object",
          properties: {
            oldPath: {
              type: "string",
              description: "Current file path"
            },
            newPath: {
              type: "string",
              description: "New file path"
            }
          },
          required: ["oldPath", "newPath"]
        }
      },
      {
        name: "ftp_rollback",
        description: "Rollback a previous transaction using its snapshot",
        inputSchema: {
          type: "object",
          properties: {
            transactionId: {
              type: "string",
              description: "Transaction ID to rollback (e.g., tx_1234567890_abcd)"
            }
          },
          required: ["transactionId"]
        }
      },
      {
        name: "ftp_list_transactions",
        description: "List available rollback transactions",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "ftp_probe_capabilities",
        description: "Probe the server to detect supported features (chmod, symlinks, disk space, etc.)",
        inputSchema: {
          type: "object",
          properties: {
            testPath: {
              type: "string",
              description: "A safe remote directory to run tests in (defaults to current directory)",
              default: "."
            }
          }
        }
      },
      {
        name: "ftp_telemetry",
        description: "Get connection health and performance telemetry",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "ftp_list_deployments") {
    try {
      const configPath = path.join(process.cwd(), '.ftpconfig');
      const configData = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configData);

      if (!config.deployments || Object.keys(config.deployments).length === 0) {
        return {
          content: [{
            type: "text",
            text: "No deployments configured in .ftpconfig"
          }]
        };
      }

      const deploymentList = Object.entries(config.deployments).map(([name, deploy]) => {
        return `${name}\n  Profile: ${deploy.profile}\n  Local: ${deploy.local}\n  Remote: ${deploy.remote}\n  Description: ${deploy.description || 'N/A'}`;
      }).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Available deployments:\n\n${deploymentList}`
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }

  if (request.params.name === "ftp_deploy") {
    try {
      const { deployment } = request.params.arguments;
      const configPath = path.join(process.cwd(), '.ftpconfig');
      const configData = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configData);

      if (!config.deployments || !config.deployments[deployment]) {
        return {
          content: [{
            type: "text",
            text: `Deployment "${deployment}" not found in .ftpconfig. Use ftp_list_deployments to see available deployments.`
          }],
          isError: true
        };
      }

      const deployConfig = config.deployments[deployment];
      const profileConfig = config[deployConfig.profile];

      if (!profileConfig) {
        return {
          content: [{
            type: "text",
            text: `Profile "${deployConfig.profile}" not found in .ftpconfig`
          }],
          isError: true
        };
      }

      currentConfig = profileConfig;
      currentProfile = deployConfig.profile;

      const useSFTP = isSFTP(currentConfig.host);
      const client = await getClient(currentConfig);

      try {
        const localPath = path.resolve(deployConfig.local);
        const stats = await syncFiles(
          client,
          useSFTP,
          localPath,
          deployConfig.remote,
          'upload',
          null,
          null,
          deployConfig.exclude || []
        );

        return {
          content: [{
            type: "text",
            text: `Deployment "${deployment}" complete:\n${deployConfig.description || ''}\n\nProfile: ${deployConfig.profile}\nLocal: ${deployConfig.local}\nRemote: ${deployConfig.remote}\n\nUploaded: ${stats.uploaded}\nSkipped: ${stats.skipped}\nIgnored: ${stats.ignored}\n${stats.errors.length > 0 ? '\nErrors:\n' + stats.errors.join('\n') : ''}`
          }]
        };
      } finally {
        releaseClient(currentConfig);
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }

  if (request.params.name === "ftp_connect") {
    try {
      const { profile, useEnv } = request.params.arguments || {};
      currentConfig = await loadFTPConfig(profile, useEnv);
      const poolKey = getPoolKey(currentConfig);
      invalidatePoolCache(poolKey);

      if (!currentConfig.host || !currentConfig.user) {
        return {
          content: [
            {
              type: "text",
              text: "Error: FTP credentials not configured. Please set FTPMCP_HOST, FTPMCP_USER environment variables or create a .ftpconfig file."
            }
          ]
        };
      }

      let warning = "";
      const isProd = (profile || currentProfile || '').toLowerCase().includes('prod');
      if (isProd && !isSFTP(currentConfig.host)) {
        warning = "\n⚠️ SECURITY WARNING: You are connecting to a production profile using insecure FTP. SFTP is strongly recommended.";
      }

      return {
        content: [{
          type: "text",
          text: `Connected to profile: ${profile || currentProfile || 'environment variables'}\nHost: ${currentConfig.host}${warning}`
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }

  if (!currentConfig) {
    try {
      currentConfig = await loadFTPConfig();
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: "Error: FTP credentials not configured. Please use ftp_connect first or set environment variables."
          }
        ],
        isError: true
      };
    }
  }

  if (!currentConfig || !currentConfig.host || !currentConfig.user) {
    return {
      content: [
        {
          type: "text",
          text: "Error: FTP credentials not configured. Please set FTPMCP_HOST, FTPMCP_USER, and FTPMCP_PASSWORD environment variables or create a .ftpconfig file."
        }
      ],
      isError: true
    };
  }

  try {
    const entry = await getClient(currentConfig);
  const client = entry.client;
  const useSFTP = client._isSFTP;
  const poolKey = getPoolKey(currentConfig);
  const cmdName = request.params.name;
  const isDestructive = ["ftp_deploy", "ftp_put_contents", "ftp_batch_upload", "ftp_sync", "ftp_upload", "ftp_delete", "ftp_mkdir", "ftp_rmdir", "ftp_chmod", "ftp_rename", "ftp_copy", "ftp_patch_file"].includes(cmdName);

  const policyEngine = new PolicyEngine(currentConfig || {});

  if (isDestructive) {
    if (currentConfig.readOnly) {
      const errorResp = {
        content: [{ type: "text", text: `Error: Profile '${currentProfile}' is configured in readOnly mode. Destructive actions are disabled.` }],
        isError: true
      };
      await auditLog(cmdName, request.params.arguments, 'failed', currentProfile, 'readOnly mode violation');
      return errorResp;
    }
    invalidatePoolCache(poolKey);
  }

  const response = await entry.execute(async (client) => {
    switch (cmdName) {
        case "ftp_list": {
          const path = request.params.arguments?.path || ".";
          const limit = request.params.arguments?.limit || 100;
          const offset = request.params.arguments?.offset || 0;

          let files = getCached(poolKey, 'LIST', path);
          if (!files) {
            files = useSFTP ? await client.list(path) : await client.list(path);
            files.sort((a, b) => a.name.localeCompare(b.name));
            setCached(poolKey, 'LIST', path, files);
          }

          const total = files.length;
          const sliced = files.slice(offset, offset + limit);

          const formatted = sliced.map(f => {
            const type = (useSFTP ? f.type === 'd' : f.isDirectory) ? 'DIR ' : 'FILE';
            const rights = useSFTP && f.rights ? `, ${f.rights.user || ''}${f.rights.group || ''}${f.rights.other || ''}` : '';
            return `${type} ${f.name} (${f.size} bytes${rights})`;
          }).join('\n');

          const paginationInfo = `\n\nShowing ${offset + 1} to ${Math.min(offset + limit, total)} of ${total} items.`;
          return {
            content: [{ type: "text", text: (formatted || "Empty directory") + (total > limit ? paginationInfo : '') }]
          };
        }

        case "ftp_get_contents": {
          const { path, startLine, endLine } = request.params.arguments;
          let content;

          if (useSFTP) {
            const buffer = await client.get(path);
            content = buffer.toString('utf8');
          } else {
            const chunks = [];
            const stream = new Writable({
              write(chunk, encoding, callback) {
                chunks.push(chunk);
                callback();
              }
            });

            await client.downloadTo(stream, path);
            content = Buffer.concat(chunks).toString('utf8');
          }

          if (startLine || endLine) {
            const lines = content.split('\n');
            const start = Math.max((startLine || 1) - 1, 0);
            const end = endLine ? Math.min(endLine, lines.length) : lines.length;
            const totalLength = lines.length;

            content = lines.slice(start, end).join('\n');
            content = `... Showing lines ${start + 1} to ${end} of ${totalLength} ...\n${content}`;
          }

          return {
            content: [{ type: "text", text: content }]
          };
        }

        case "ftp_patch_file": {
          const { path: filePath, patch, expectedHash, createBackup = true } = request.params.arguments;

          try {
            policyEngine.validateOperation('patch', { path: filePath });
          } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

          let content;
          try {
            if (useSFTP) {
              const buffer = await client.get(filePath);
              content = buffer.toString('utf8');
            } else {
              const chunks = [];
              const stream = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } });
              await client.downloadTo(stream, filePath);
              content = Buffer.concat(chunks).toString('utf8');
            }
          } catch (e) {
            return {
              content: [{ type: "text", text: `Error: File not found or unreadable. ${e.message}` }],
              isError: true
            };
          }

          if (expectedHash) {
            const currentHash = crypto.createHash('md5').update(content).digest('hex');
            if (currentHash !== expectedHash) {
              return {
                content: [{ type: "text", text: `Error: File drift detected. Expected hash ${expectedHash}, but got ${currentHash}.` }],
                isError: true
              };
            }
          }

          // Try exact match first
          let patchedContent = diff.applyPatch(content, patch);
          let confidence = 100;

          // If exact match fails, try fuzzy match
          if (patchedContent === false) {
            patchedContent = diff.applyPatch(content, patch, { fuzzFactor: 2 });
            confidence = 50; // Arbitrary lower confidence for fuzzy match
          }

          if (patchedContent === false) {
            return {
              content: [{ type: "text", text: `Error: Failed to apply patch cleanly. Diff may be malformed or out of date with remote file.` }],
              isError: true
            };
          }

          const txId = await snapshotManager.createSnapshot(client, useSFTP, [filePath]);

          if (createBackup) {
            const backupPath = `${filePath}.bak`;
            if (useSFTP) {
              const buffer = Buffer.from(content, 'utf8');
              await client.put(buffer, backupPath);
            } else {
              const readable = Readable.from([content]);
              await client.uploadFrom(readable, backupPath);
            }
          }

          if (useSFTP) {
            const buffer = Buffer.from(patchedContent, 'utf8');
            await client.put(buffer, filePath);
          } else {
            const readable = Readable.from([patchedContent]);
            await client.uploadFrom(readable, filePath);
          }

          return {
            content: [{ type: "text", text: `Successfully patched ${filePath} (Confidence: ${confidence}%)\nTransaction ID: ${txId}${createBackup ? `\nBackup created at: ${filePath}.bak` : ''}` }]
          };
        }

        case "ftp_put_contents": {
          const { path: filePath, content } = request.params.arguments;

          try {
            policyEngine.validateOperation('overwrite', { path: filePath, size: Buffer.byteLength(content, 'utf8') });
          } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

          const txId = await snapshotManager.createSnapshot(client, useSFTP, [filePath]);

          if (useSFTP) {
            const buffer = Buffer.from(content, 'utf8');
            await client.put(buffer, filePath);
          } else {
            const readable = Readable.from([content]);
            await client.uploadFrom(readable, filePath);
          }

          return {
            content: [{ type: "text", text: `Successfully wrote content to ${filePath}\nTransaction ID: ${txId}` }]
          };
        }

        case "ftp_stat": {
          const { path } = request.params.arguments;

          if (useSFTP) {
            const stats = await client.stat(path);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  size: stats.size,
                  modified: stats.modifyTime,
                  accessed: stats.accessTime,
                  permissions: stats.mode,
                  isDirectory: stats.isDirectory,
                  isFile: stats.isFile
                }, null, 2)
              }]
            };
          } else {
            const dirPath = path.substring(0, path.lastIndexOf('/')) || '.';
            const fileName = path.substring(path.lastIndexOf('/') + 1);
            const files = await client.list(dirPath);
            const file = files.find(f => f.name === fileName);

            if (!file) {
              throw new Error(`File not found: ${path}`);
            }

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  size: file.size,
                  modified: file.modifiedAt || file.rawModifiedAt,
                  isDirectory: file.isDirectory,
                  isFile: file.isFile
                }, null, 2)
              }]
            };
          }
        }

        case "ftp_exists": {
          const { path } = request.params.arguments;
          let exists = false;

          try {
            if (useSFTP) {
              await client.stat(path);
              exists = true;
            } else {
              const dirPath = path.substring(0, path.lastIndexOf('/')) || '.';
              const fileName = path.substring(path.lastIndexOf('/') + 1);
              const files = await client.list(dirPath);
              exists = files.some(f => f.name === fileName);
            }
          } catch (e) {
            exists = false;
          }

          return {
            content: [{ type: "text", text: exists ? "true" : "false" }]
          };
        }

        case "ftp_tree": {
          const { path = ".", maxDepth = 10 } = request.params.arguments || {};
          const cacheKey = `${path}:${maxDepth}`;
          let tree = getCached(poolKey, 'TREE', cacheKey);
          if (!tree) {
            tree = await getTreeRecursive(client, useSFTP, path, 0, maxDepth);
            setCached(poolKey, 'TREE', cacheKey, tree);
          }

          const formatted = tree.map(item => {
            const indent = '  '.repeat((item.path.match(/\//g) || []).length);
            return `${indent}${item.isDirectory ? '📁' : '📄'} ${item.name} ${!item.isDirectory ? `(${item.size} bytes)` : ''}`;
          }).join('\n');

          return {
            content: [{ type: "text", text: formatted || "Empty directory" }]
          };
        }

        case "ftp_search": {
          const { pattern, contentPattern, extension, findLikelyConfigs, path: searchPath = ".", limit = 50, offset = 0 } = request.params.arguments;

          if (!pattern && !contentPattern && !findLikelyConfigs) {
            return { content: [{ type: "text", text: "Error: Must provide pattern, contentPattern, or findLikelyConfigs" }], isError: true };
          }

          const cacheKey = `${searchPath}:10`;
          let tree = getCached(poolKey, 'TREE', cacheKey);
          if (!tree) {
            tree = await getTreeRecursive(client, useSFTP, searchPath, 0, 10);
            setCached(poolKey, 'TREE', cacheKey, tree);
          }

          let matches = tree;

          if (findLikelyConfigs) {
            const configRegex = /config|env|auth|deploy|build|package\.json|composer\.json|dockerfile/i;
            matches = matches.filter(item => configRegex.test(item.name));
          }

          if (pattern) {
            const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
            matches = matches.filter(item => regex.test(item.name));
          }

          if (extension) {
            const ext = extension.startsWith('.') ? extension : `.${extension}`;
            matches = matches.filter(item => item.name.endsWith(ext));
          }

          const total = matches.length;
          let sliced = matches.slice(offset, offset + limit);
          let formatted = "";

          if (contentPattern) {
            const contentRegex = new RegExp(contentPattern, 'gi');
            const contentMatches = [];

            for (const item of sliced) {
              if (item.isDirectory || item.size > 1024 * 1024) continue; // Skip dirs and files > 1MB

              try {
                let content;
                if (useSFTP) {
                  content = (await client.get(item.path)).toString('utf8');
                } else {
                  const chunks = [];
                  const stream = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
                  await client.downloadTo(stream, item.path);
                  content = Buffer.concat(chunks).toString('utf8');
                }

                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  if (contentRegex.test(lines[i])) {
                    const start = Math.max(0, i - 1);
                    const end = Math.min(lines.length - 1, i + 1);
                    const context = lines.slice(start, end + 1).map((l, idx) => `${start + idx + 1}: ${l}`).join('\n');
                    contentMatches.push(`File: ${item.path}\n${context}\n---`);
                    break; // Just show first match per file to save space
                  }
                }
              } catch (e) {
                // Ignore read errors during search
              }
            }
            formatted = contentMatches.join('\n');
          } else {
            formatted = sliced.map(item =>
              `${item.path} (${item.isDirectory ? 'DIR' : item.size + ' bytes'})`
            ).join('\n');
          }

          const paginationInfo = `\n\nShowing ${offset + 1} to ${Math.min(offset + limit, total)} of ${total} matches.`;
          return {
            content: [{ type: "text", text: (formatted || "No matches found") + (total > limit ? paginationInfo : '') }]
          };
        }

        case "ftp_analyze_workspace": {
          const path = request.params.arguments?.path || ".";
          let files = getCached(poolKey, 'LIST', path);
          if (!files) {
            files = useSFTP ? await client.list(path) : await client.list(path);
            setCached(poolKey, 'LIST', path, files);
          }

          const fileNames = files.map(f => f.name);
          const importantFiles = ['package.json', 'composer.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'README.md'];
          const found = files.filter(f => importantFiles.includes(f.name));

          let summary = `Workspace Analysis for: ${path}\n============================\n\n`;

          // Framework Detection
          let framework = "Unknown";
          let recommendedIgnores = [];
          let dangerousFolders = [];

          if (fileNames.includes('wp-config.php') || fileNames.includes('wp-content')) {
            framework = "WordPress";
            recommendedIgnores = ['wp-content/cache/**', 'wp-content/uploads/**', 'wp-config.php'];
            dangerousFolders = ['wp-content/uploads', 'wp-content/cache'];
          } else if (fileNames.includes('artisan') && fileNames.includes('composer.json')) {
            framework = "Laravel";
            recommendedIgnores = ['vendor/**', 'storage/framework/cache/**', 'storage/logs/**', '.env'];
            dangerousFolders = ['storage', 'bootstrap/cache'];
          } else if (fileNames.includes('next.config.js') || fileNames.includes('next.config.mjs')) {
            framework = "Next.js";
            recommendedIgnores = ['.next/**', 'node_modules/**', '.env*'];
            dangerousFolders = ['.next'];
          } else if (fileNames.includes('vite.config.js') || fileNames.includes('vite.config.ts')) {
            framework = "Vite/React/Vue";
            recommendedIgnores = ['dist/**', 'node_modules/**', '.env*'];
            dangerousFolders = ['dist'];
          } else if (fileNames.includes('package.json')) {
            framework = "Node.js (Generic)";
            recommendedIgnores = ['node_modules/**', '.env*'];
            dangerousFolders = ['node_modules'];
          } else if (fileNames.includes('composer.json')) {
            framework = "PHP (Composer)";
            recommendedIgnores = ['vendor/**', '.env*'];
            dangerousFolders = ['vendor'];
          }

          summary += `Detected Framework: ${framework}\n`;
          if (recommendedIgnores.length > 0) {
            summary += `Recommended Ignores: ${recommendedIgnores.join(', ')}\n`;
          }
          if (dangerousFolders.length > 0) {
            summary += `Dangerous/Cache Folders (Avoid Overwriting): ${dangerousFolders.join(', ')}\n`;
          }
          summary += `\n----------------------------\n\n`;

          if (found.length === 0) {
            summary += "No recognizable project configuration files found.";
            return { content: [{ type: "text", text: summary }] };
          }

          for (const file of found) {
            const filePath = path === "." ? file.name : `${path}/${file.name}`;
            try {
              let content;
              if (useSFTP) {
                content = (await client.get(filePath)).toString('utf8');
              } else {
                const chunks = [];
                const stream = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
                await client.downloadTo(stream, filePath);
                content = Buffer.concat(chunks).toString('utf8');
              }

              if (file.name === 'package.json' || file.name === 'composer.json') {
                const parsed = JSON.parse(content);
                summary += `[${file.name}]\nName: ${parsed.name || 'Unknown'}\nVersion: ${parsed.version || 'Unknown'}\n`;
                if (parsed.dependencies || parsed.require) summary += `Dependencies: ${Object.keys(parsed.dependencies || parsed.require).slice(0, 10).join(', ')}...\n`;
              } else if (file.name === 'README.md') {
                summary += `[README.md (Preview)]\n${content.split('\n').filter(l => l.trim()).slice(0, 5).join('\n')}\n`;
              } else {
                summary += `[${file.name}]\n${content.split('\n').slice(0, 10).join('\n')}...\n`;
              }
              summary += '\n';
            } catch (e) {
              summary += `[${file.name}]\nCould not read file contents: ${e.message}\n\n`;
            }
          }

          return {
            content: [{ type: "text", text: summary.trim() }]
          };
        }

        case "ftp_copy": {
          const { sourcePath, destPath } = request.params.arguments;

          if (!useSFTP) {
            return {
              content: [{ type: "text", text: "Error: ftp_copy is only supported for SFTP connections. For FTP, download and re-upload." }]
            };
          }

          const buffer = await client.get(sourcePath);
          await client.put(buffer, destPath);

          return {
            content: [{ type: "text", text: `Successfully copied ${sourcePath} to ${destPath}` }]
          };
        }

        case "ftp_batch_upload": {
          const { files } = request.params.arguments;
          const results = { success: [], failed: [] };

          for (const file of files) {
            try {
              if (useSFTP) {
                await client.put(file.localPath, file.remotePath);
              } else {
                await client.uploadFrom(file.localPath, file.remotePath);
              }
              results.success.push(file.remotePath);
            } catch (error) {
              results.failed.push({ path: file.remotePath, error: error.message });
            }
          }

          return {
            content: [{
              type: "text",
              text: `Uploaded: ${results.success.length}\nFailed: ${results.failed.length}\n${results.failed.length > 0 ? '\nErrors:\n' + results.failed.map(f => `${f.path}: ${f.error}`).join('\n') : ''}`
            }]
          };
        }

        case "ftp_batch_download": {
          const { files } = request.params.arguments;
          const results = { success: [], failed: [] };

          for (const file of files) {
            try {
              if (useSFTP) {
                await client.get(file.remotePath, file.localPath);
              } else {
                await client.downloadTo(file.localPath, file.remotePath);
              }
              results.success.push(file.remotePath);
            } catch (error) {
              results.failed.push({ path: file.remotePath, error: error.message });
            }
          }

          return {
            content: [{
              type: "text",
              text: `Downloaded: ${results.success.length}\nFailed: ${results.failed.length}\n${results.failed.length > 0 ? '\nErrors:\n' + results.failed.map(f => `${f.path}: ${f.error}`).join('\n') : ''}`
            }]
          };
        }

        case "ftp_sync": {
          const { localPath, remotePath, direction = "upload", dryRun = false, useManifest = true } = request.params.arguments;
          const startTime = Date.now();
          const stats = await syncFiles(client, useSFTP, localPath, remotePath, direction, null, null, [], dryRun, useManifest);
          const duration = Date.now() - startTime;

          if (!dryRun) {
            telemetry.syncDurations.push(duration);
            if (telemetry.syncDurations.length > 100) telemetry.syncDurations.shift(); // Keep last 100
          }

          let resultText = `${dryRun ? '[DRY RUN] ' : ''}Sync complete in ${duration}ms:\nUploaded: ${stats.uploaded}\nDownloaded: ${stats.downloaded}\nSkipped: ${stats.skipped}\nIgnored: ${stats.ignored}\n${stats.errors.length > 0 ? '\nErrors:\n' + stats.errors.join('\n') : ''}`;

          if (dryRun && stats.filesToChange.length > 0) {
            resultText += `\n\n${generateSemanticPreview(stats.filesToChange)}`;
          }

          return {
            content: [{
              type: "text",
              text: resultText
            }]
          };
        }

        case "ftp_disk_space": {
          const { path = "." } = request.params.arguments || {};

          if (!useSFTP) {
            return {
              content: [{ type: "text", text: "Error: ftp_disk_space is only supported for SFTP connections" }]
            };
          }

          try {
            const sftp = await client.sftp();
            const diskSpace = await new Promise((resolve, reject) => {
              sftp.ext_openssh_statvfs(path, (err, stats) => {
                if (err) reject(err);
                else resolve(stats);
              });
            });

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  total: diskSpace.blocks * diskSpace.bsize,
                  free: diskSpace.bfree * diskSpace.bsize,
                  available: diskSpace.bavail * diskSpace.bsize,
                  used: (diskSpace.blocks - diskSpace.bfree) * diskSpace.bsize
                }, null, 2)
              }]
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Disk space info not available: ${error.message}` }]
            };
          }
        }

        case "ftp_upload": {
          const { localPath, remotePath } = request.params.arguments;

          if (isSecretFile(localPath)) {
            return {
              content: [{ type: "text", text: `Security Warning: Blocked upload of likely secret file: ${localPath}` }],
              isError: true
            };
          }

          try {
            const stat = await fs.stat(localPath);
            policyEngine.validateOperation('overwrite', { path: remotePath, size: stat.size });
          } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

          const txId = await snapshotManager.createSnapshot(client, useSFTP, [remotePath]);

          if (useSFTP) {
            await client.put(localPath, remotePath);
          } else {
            await client.uploadFrom(localPath, remotePath);
          }

          return {
            content: [{ type: "text", text: `Successfully uploaded ${localPath} to ${remotePath}\nTransaction ID: ${txId}` }]
          };
        }

        case "ftp_download": {
          const { remotePath, localPath } = request.params.arguments;

          if (useSFTP) {
            await client.get(remotePath, localPath);
          } else {
            await client.downloadTo(localPath, remotePath);
          }

          return {
            content: [{ type: "text", text: `Successfully downloaded ${remotePath} to ${localPath}` }]
          };
        }

        case "ftp_delete": {
          const { path: filePath } = request.params.arguments;

          try {
            policyEngine.validateOperation('delete', { path: filePath });
          } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

          const txId = await snapshotManager.createSnapshot(client, useSFTP, [filePath]);

          if (useSFTP) {
            await client.delete(filePath);
          } else {
            await client.remove(filePath);
          }

          return {
            content: [{ type: "text", text: `Successfully deleted ${filePath}\nTransaction ID: ${txId}` }]
          };
        }

        case "ftp_mkdir": {
          const { path } = request.params.arguments;

          if (useSFTP) {
            await client.mkdir(path, true);
          } else {
            await client.ensureDir(path);
          }

          return {
            content: [{ type: "text", text: `Successfully created directory ${path}` }]
          };
        }

        case "ftp_rmdir": {
          const { path, recursive } = request.params.arguments;

          if (useSFTP) {
            await client.rmdir(path, recursive);
          } else {
            if (recursive) {
              await client.removeDir(path);
            } else {
              await client.remove(path);
            }
          }

          return {
            content: [{ type: "text", text: `Successfully removed directory ${path}` }]
          };
        }

        case "ftp_chmod": {
          const { path, mode } = request.params.arguments;

          if (!useSFTP) {
            return {
              content: [{ type: "text", text: "Error: chmod is only supported for SFTP connections" }]
            };
          }

          await client.chmod(path, mode);

          return {
            content: [{ type: "text", text: `Successfully changed permissions of ${path} to ${mode}` }]
          };
        }

        case "ftp_rename": {
          const { oldPath, newPath } = request.params.arguments;

          try {
            policyEngine.validateOperation('delete', { path: oldPath }); // Renaming is effectively deleting the old path
            policyEngine.validateOperation('overwrite', { path: newPath });
          } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

          const txId = await snapshotManager.createSnapshot(client, useSFTP, [oldPath, newPath]);

          if (useSFTP) {
            await client.rename(oldPath, newPath);
          } else {
            await client.rename(oldPath, newPath);
          }

          return {
            content: [{ type: "text", text: `Successfully renamed ${oldPath} to ${newPath}\nTransaction ID: ${txId}` }]
          };
        }

        case "ftp_rollback": {
          const { transactionId } = request.params.arguments;
          try {
            const results = await snapshotManager.rollback(client, useSFTP, transactionId);
            return {
              content: [{
                type: "text",
                text: `Rollback complete for ${transactionId}:\nRestored: ${results.restored.length}\nDeleted: ${results.deleted.length}\nFailed: ${results.failed.length}\n${results.failed.length > 0 ? '\nErrors:\n' + results.failed.map(f => `${f.path}: ${f.error}`).join('\n') : ''}`
              }]
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Rollback failed: ${error.message}` }],
              isError: true
            };
          }
        }

        case "ftp_list_transactions": {
          try {
            const transactions = await snapshotManager.listTransactions();
            if (transactions.length === 0) {
              return { content: [{ type: "text", text: "No transactions found." }] };
            }

            const formatted = transactions.map(tx => {
              return `ID: ${tx.transactionId}\nTime: ${tx.timestamp}\nFiles: ${tx.files.map(f => f.remotePath).join(', ')}`;
            }).join('\n\n');

            return { content: [{ type: "text", text: `Available Transactions:\n\n${formatted}` }] };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list transactions: ${error.message}` }],
              isError: true
            };
          }
        }

        case "ftp_telemetry": {
          const avgSyncDuration = telemetry.syncDurations.length > 0
            ? telemetry.syncDurations.reduce((a, b) => a + b, 0) / telemetry.syncDurations.length
            : 0;

          return {
            content: [{
              type: "text",
              text: `Connection Health Telemetry:\n===========================\nActive Connections: ${telemetry.activeConnections}\nTotal Reconnects: ${telemetry.reconnects}\nCache Hits: ${telemetry.cacheHits}\nCache Misses: ${telemetry.cacheMisses}\nCache Hit Rate: ${telemetry.cacheHits + telemetry.cacheMisses > 0 ? Math.round((telemetry.cacheHits / (telemetry.cacheHits + telemetry.cacheMisses)) * 100) : 0}%\nAverage Sync Duration: ${Math.round(avgSyncDuration)}ms (last ${telemetry.syncDurations.length} syncs)`
            }]
          };
        }

        case "ftp_probe_capabilities": {
          const { testPath = "." } = request.params.arguments || {};
          const capabilities = {
            protocol: useSFTP ? 'SFTP' : 'FTP',
            chmod: false,
            symlinks: false,
            diskSpace: false,
            atomicRename: false,
            checksums: false
          };

          const testFile = `${testPath}/.ftp-mcp-probe-${Date.now()}.txt`;
          const testRename = `${testPath}/.ftp-mcp-probe-renamed-${Date.now()}.txt`;

          try {
            // 1. Test basic write
            if (useSFTP) {
              await client.put(Buffer.from('test', 'utf8'), testFile);
            } else {
              await client.uploadFrom(Readable.from(['test']), testFile);
            }

            // 2. Test chmod (SFTP only usually)
            if (useSFTP) {
              try {
                await client.chmod(testFile, '644');
                capabilities.chmod = true;
              } catch (e) { }
            }

            // 3. Test atomic rename
            try {
              await client.rename(testFile, testRename);
              capabilities.atomicRename = true;
            } catch (e) { }

            // 4. Test disk space (SFTP only usually)
            if (useSFTP) {
              try {
                const sftp = await client.sftp();
                await new Promise((resolve, reject) => {
                  sftp.ext_openssh_statvfs(testPath, (err, stats) => {
                    if (err) reject(err);
                    else resolve(stats);
                  });
                });
                capabilities.diskSpace = true;
              } catch (e) { }
            }

            // Cleanup
            try {
              if (capabilities.atomicRename) {
                if (useSFTP) await client.delete(testRename);
                else await client.remove(testRename);
              } else {
                if (useSFTP) await client.delete(testFile);
                else await client.remove(testFile);
              }
            } catch (e) { }

          } catch (error) {
            return {
              content: [{ type: "text", text: `Probing failed during basic operations: ${error.message}` }],
              isError: true
            };
          }

          return {
            content: [{
              type: "text",
              text: `Server Capabilities:\n${JSON.stringify(capabilities, null, 2)}`
            }]
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
            isError: true
          };
      }
    });

    await auditLog(cmdName, request.params.arguments, response.isError ? 'failed' : 'success', currentProfile, response.isError ? response.content[0].text : null);
    return response;
  } catch (error) {
    console.error(`[Fatal Tool Error] ${request.params.name}:`, error);
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  } finally {
    if (currentConfig) {
      releaseClient(currentConfig);
    }
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("FTP MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
