#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// AI-First Semantic Icons
const ICON = {
  DIR: "📂",
  FILE: "📄",
  PKG: "📦",
  CONFIG: "⚙️",
  SECRET: "🔒",
  BACKUP: "🕰️",
  HINT: "💡",
  ERROR: "❌"
};

/**
 * AI-First: Generate context-aware suggestions for troubleshooting and next steps.
 * This helper ensures the LLM receives actionable, backticked commands.
 */
function getAISuggestion(type, context = {}) {
  switch (type) {
    case 'error_enoent':
      return `[AI: Path not found. Suggested fix: Check your CWD with \`ftp_list "."\` or verify the path exists with \`ftp_exists "${context.path}"\`]`;
    case 'error_permission':
      return `[AI: Permission denied. Suggested fix: Verify user rights with \`ftp_stat "${context.path}"\` or check if the server supports \`ftp_chmod\`]`;
    case 'hint_connected':
      return `[HINT: Connection active. Suggested next step: Run \`ftp_analyze_workspace "."\` to understand the project architecture.]`;
    case 'hint_list_config':
      return `[HINT: Found project manifests. Suggested next step: Read \`package.json\` using \`ftp_get_contents "package.json"\` to see dependencies.]`;
    case 'hint_destructive_readonly':
      return `[AI: Server is in READ-ONLY mode. Use \`ftp_sync --dryRun\` to simulate this deployment instead.]`;
    default:
      return null;
  }
}

// Read version from package.json to avoid version drift (CODE-1)
let SERVER_VERSION = "1.5.0";
try {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  SERVER_VERSION = pkg.version || SERVER_VERSION;
} catch (e) { /* fallback to hardcoded */ }

const DEFAULT_CONFIG_NAME = ".ftpconfig";
const CONFIG_FILE = process.env.FTP_CONFIG_PATH || path.join(process.cwd(), DEFAULT_CONFIG_NAME);

// --init: scaffold .ftpconfig.example into the user's current working directory
if (process.argv.includes("--init")) {
  try {
    const { intro, outro, text, password: promptPassword, select, confirm, note, isCancel } = await import("@clack/prompts");

    intro('🚀 Welcome to FTP-MCP Initialization Wizard');

    const setupType = await select({
      message: 'Who is running this setup wizard?',
      options: [
        { value: 'ai', label: '1. AI Agent Install (Provides verbose context on how to use the server)', hint: 'Detailed instructions for LLMs' },
        { value: 'human', label: '2. Human Install (Standard Setup)', hint: 'Concise standard setup for human users' }
      ]
    });
    if (isCancel(setupType)) { outro('Setup cancelled.'); process.exit(0); }

    const isAI = setupType === 'ai';

    const host = await text({
      message: isAI
        ? '[AI INSTRUCTION] Provide the remote FTP/SFTP Host address. (e.g. sftp://ftp.example.com or ftp://1.2.3.4). Note: This tool brokers remote filesystem access as an MCP server.'
        : 'Enter your FTP/SFTP Host (e.g. sftp://ftp.example.com)',
      placeholder: 'sftp://127.0.0.1',
      validate: (val) => (!val || val.length === 0) ? "Host is required!" : undefined,
    });
    if (isCancel(host)) { outro('Setup cancelled.'); process.exit(0); }

    const user = await text({
      message: isAI
        ? '[AI INSTRUCTION] Provide the remote server username. This credential will be used for all subsequent tool calls in this session.'
        : 'Enter your Username',
      validate: (val) => (!val || val.length === 0) ? "User is required!" : undefined,
    });
    if (isCancel(user)) { outro('Setup cancelled.'); process.exit(0); }

    const pass = await promptPassword({
      message: isAI
        ? '[AI INSTRUCTION] Provide the password for the connection. If you are using SSH key authentication for SFTP, you may leave this field empty.'
        : 'Enter your Password (optional if using keys)',
    });
    if (isCancel(pass)) { outro('Setup cancelled.'); process.exit(0); }

    const port = await text({
      message: isAI
        ? '[AI INSTRUCTION] Provide the specific port for the connection. Default is 21 for FTP and 22 for SFTP. If the user has not specified a custom port, you should leave this blank.'
        : 'Enter port (optional, defaults to 21 for FTP, 22 for SFTP)',
      placeholder: '22',
      validate: (val) => {
        if (val && isNaN(parseInt(val, 10))) return "Port must be a number!";
        return undefined;
      }
    });
    if (isCancel(port)) { outro('Setup cancelled.'); process.exit(0); }

    const isSFTP = typeof host === 'string' && host.startsWith('sftp://');
    let privateKey = '';

    if (isSFTP) {
      const usesKey = await confirm({
        message: isAI
          ? '[AI INSTRUCTION] An SFTP protocol was detected. Is the user employing an SSH Private Key instead of a traditional password? (Recommended for production)'
          : 'Are you using an SSH Private Key instead of a password?'
      });
      if (isCancel(usesKey)) { outro('Setup cancelled.'); process.exit(0); }
      if (usesKey) {
        privateKey = await text({
          message: isAI
            ? '[AI INSTRUCTION] Provide the absolute local filesystem path to the SSH private key (e.g. ~/.ssh/id_rsa). This path must be accessible from the environment where the MCP server is running.'
            : 'Path to your private key (e.g. ~/.ssh/id_rsa)',
        });
        if (isCancel(privateKey)) { outro('Setup cancelled.'); process.exit(0); }
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

    if (isAI) {
      note(
        "AI CONTEXT ESTABLISHED: The `.ftpconfig` file has been generated.\n" +
        "You now have access to this MCP server's tools.\n\n" +
        "Important capabilities:\n" +
        "- Content-rich operations: `ftp_list`, `ftp_download`, `ftp_upload`.\n" +
        "- Batched operations: `ftp_batch_upload`, `ftp_batch_download` (Highly recommended for speed).\n" +
        "- Safe regex searches: `ftp_search`.\n" +
        "- Transparent paths: All remote operations are relative to the server root.\n\n" +
        "You may now proceed with the user's tasks.",
        "Configuration Success"
      );
    } else {
      note(`✅ Successfully generated config file at:\n${CONFIG_FILE}`, 'Success');
    }

    outro(isAI
      ? "Deployment complete. You are now configured to manage the remote filesystem."
      : "You're ready to deploy with MCP! Ask your AI to 'list remote files'"
    );
  } catch (err) {
    console.error(`❌ Init failed: ${err.message}`);
  }
  process.exit(0);
}


let currentConfig = null;
let currentProfile = null;
let sessionHintShown = false;

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

/**
 * SEC-1/2/3: Validate that a local path stays within the configured safe root.
 * Prevents path traversal / arbitrary file read-write attacks.
 * If no safeRoot configured, defaults to user home directory as a broad guard.
 */
function validateLocalPath(localPath, safeRoot = null) {
  const resolved = path.resolve(localPath);
  const root = safeRoot ? path.resolve(safeRoot) : null;
  if (root) {
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`Security: Local path '${localPath}' is outside the allowed directory '${root}'.`);
    }
  }
  // Always block traversal separators in the raw input regardless of root config
  const normalized = localPath.replace(/\\/g, '/');
  if (normalized.includes('../')) {
    throw new Error(`Security: Path traversal detected in local path '${localPath}'.`);
  }
  return resolved;
}

/**
 * SEC-4: Safely compile a user-supplied regex pattern.
 * Returns null and an error message if the pattern is invalid or too long.
 */
function safeRegex(pattern, flags = 'i') {
  if (!pattern || typeof pattern !== 'string') return { regex: null, error: null };
  if (pattern.length > 250) {
    return { regex: null, error: 'Regex pattern too long (max 250 chars).' };
  }
  try {
    return { regex: new RegExp(pattern, flags), error: null };
  } catch (e) {
    return { regex: null, error: `Invalid regex: ${e.message}` };
  }
}

/**
 * CODE-5: Reject dangerously shallow remote paths on destructive operations.
 * Prevents accidental or malicious deletion of root-level directories.
 */
function assertSafeRemotePath(remotePath) {
  const clean = (remotePath || '').replace(/\/+$/, '') || '/';
  const depth = clean.split('/').filter(Boolean).length;
  if (depth < 1 || clean === '/') {
    throw new Error(`Safety: Refusing to operate on root path '${clean}'. Provide a more specific path.`);
  }
  // Also block well-known dangerous Unix roots
  const dangerous = ['/etc', '/bin', '/sbin', '/usr', '/var', '/lib', '/home', '/root', '/boot', '/dev', '/proc', '/sys'];
  if (dangerous.includes(clean)) {
    throw new Error(`Safety: Refusing to operate on system path '${clean}'.`);
  }
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
  if (configPort) return parseInt(configPort, 10);
  // LOW-4: Use strict prefix check, not includes() which matches e.g. "mysftp-server.com"
  if (host && host.startsWith('sftp://')) return 22;
  return 21;
}

function isSFTP(host) {
  // LOW-4: Only match the sftp:// protocol prefix
  return !!(host && host.startsWith('sftp://'));
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
  // CODE-3: Evict stale entry while we're here
  if (entry) dirCache.delete(`${poolKey}:${type}:${path}`);
  telemetry.cacheMisses++;
  return null;
}

function setCached(poolKey, type, path, data) {
  dirCache.set(`${poolKey}:${type}:${path}`, { timestamp: Date.now(), data });
  // CODE-3: Evict any entries older than TTL to prevent unbounded growth
  const now = Date.now();
  for (const [key, entry] of dirCache.entries()) {
    if (now - entry.timestamp >= CACHE_TTL) dirCache.delete(key);
  }
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
    server.sendLoggingMessage({
      level: "debug",
      data: { message: `Reusing cached connection for ${poolKey}` }
    });
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
      server.sendLoggingMessage({
        level: "info",
        data: { message: `Successfully connected to ${poolKey} (${useSFTP ? 'SFTP' : 'FTP'})` }
      });
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
    // QUAL-5: Emit to stderr so audit failures are not silently swallowed
    console.error('[ftp-mcp] Warning: Failed to write audit log:', e.message);
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

  const files = await client.list(remotePath);
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

async function syncFiles(client, useSFTP, localPath, remotePath, direction, ignorePatterns = null, basePath = null, extraExclude = [], dryRun = false, useManifest = true, _isTopLevel = false, progressState = null) {
  const stats = { uploaded: 0, downloaded: 0, skipped: 0, errors: [], ignored: 0, filesToChange: [] };

  if (ignorePatterns === null) {
    ignorePatterns = await loadIgnorePatterns(localPath);
    basePath = localPath;
    _isTopLevel = true;
    if (useManifest) await syncManifestManager.load();
    
    // Initialize progress tracking if a token is provided
    if (progressState && progressState.token) {
      server.notification({
        method: "notifications/progress",
        params: {
          progressToken: progressState.token,
          progress: 0,
          total: progressState.total || 100,
          message: "Starting synchronization..."
        }
      });
    }
  }

  if (extraExclude.length > 0) {
    ignorePatterns = [...ignorePatterns, ...extraExclude];
  }

  if (direction === 'upload' || direction === 'both') {
    const localFiles = await fs.readdir(localPath, { withFileTypes: true });

    for (const file of localFiles) {
      const localFilePath = path.join(localPath, file.name);
      const remoteFilePath = `${remotePath}/${file.name}`;

      if (!useSFTP) await new Promise(r => setTimeout(r, 50));

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
          const subStats = await syncFiles(client, useSFTP, localFilePath, remoteFilePath, direction, ignorePatterns, basePath, extraExclude, dryRun, useManifest, false, progressState);
          stats.uploaded += subStats.uploaded;
          stats.downloaded += subStats.downloaded;
          stats.skipped += subStats.skipped;
          stats.ignored += subStats.ignored;
          stats.errors.push(...subStats.errors);
        } else {
          const localStat = await fs.stat(localFilePath);
          let shouldUpload = true;

          if (useManifest) {
            const changedLocally = await syncManifestManager.isFileChanged(localFilePath, remoteFilePath, localStat);
            if (!changedLocally) {
              shouldUpload = false;
              stats.skipped++;
            }
          }

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
              // Update progress before transfer
              if (progressState && progressState.token) {
                progressState.current++;
                server.notification({
                  method: "notifications/progress",
                  params: {
                    progressToken: progressState.token,
                    progress: progressState.current,
                    total: progressState.total,
                    message: `Transferring ${file.name}...`
                  }
                });
              }

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
                    await new Promise(r => setTimeout(r, 100 * attempts));
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

  if (_isTopLevel && useManifest && !dryRun) {
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
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
      resources: { subscribe: true, templates: true },
      prompts: {},
      logging: {}
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ftp_connect",
        description: "Establish or switch the active connection to a specific remote server profile defined in your .ftpconfig (e.g., 'production', 'staging'). This is the first step before performing any remote operations.",
        inputSchema: {
          type: "object",
          properties: {
            profile: {
              type: "string",
              description: "The named profile key from your .ftpconfig file."
            },
            useEnv: {
              type: "boolean",
              description: "If true, bypasses .ftpconfig and connects using global environment variables (FTPMCP_HOST, etc.)",
              default: false
            }
          }
        }
      },
      {
        name: "ftp_deploy",
        description: "Execute a pre-defined deployment preset from .ftpconfig. This typically maps a specific local folder to a remote target with pre-configured exclusion rules.",
        inputSchema: {
          type: "object",
          properties: {
            deployment: {
              type: "string",
              description: "The name of the deployment preset (e.g., 'web-app', 'api-server')."
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
        description: "List files and directories in a remote path. Use 'limit' and 'offset' for pagination when dealing with directories containing hundreds of files to avoid context overflow.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote directory path (defaults to current working directory).",
              default: "."
            },
            limit: {
              type: "number",
              description: "Maximum results to return in this chunk.",
              default: 100
            },
            offset: {
              type: "number",
              description: "Starting position in the file list for pagination.",
              default: 0
            }
          }
        }
      },
      {
        name: "ftp_get_contents",
        description: "Read the source text of a remote file. CRITICAL: For large files, use 'startLine' and 'endLine' to extract specific chunks and prevent hitting the LLM context limit.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute or relative remote path to the file."
            },
            startLine: {
              type: "number",
              description: "Optional: The first line to include in the output (1-indexed)."
            },
            endLine: {
              type: "number",
              description: "Optional: The last line to include (inclusive, 1-indexed)."
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_patch_file",
        description: "Apply a Unified Diff patch to a remote file. RECOMMENDED: Use this instead of ftp_put_contents for updating existing files to minimize bandwidth and ensure atomic-like updates. For new files, use ftp_put_contents.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote path to the existing file to be patched."
            },
            patch: {
              type: "string",
              description: "The Unified Diff formatted string containing your local changes."
            },
            expectedHash: {
              type: "string",
              description: "Optional (but recommended): The SHA-256 hash of the remote file before patching to prevent race conditions (drift protection)."
            },
            createBackup: {
              type: "boolean",
              description: "Generate a .bak copy of the remote file before applying the changes.",
              default: true
            }
          },
          required: ["path", "patch"]
        }
      },
      {
        name: "ftp_analyze_workspace",
        description: "Introspect the remote directory to identify technical environments (e.g., Node.js, PHP, Python) and read dependency manifests. Use this to gain architectural context of a new codebase.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote directory to analyze (defaults to current server root).",
              default: "."
            }
          }
        }
      },
      {
        name: "ftp_put_contents",
        description: "Write raw text directly to a remote destination. Best for creating NEW files. For modifying existing files, prefer ftp_patch_file.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote destination path."
            },
            content: {
              type: "string",
              description: "The full string content to write."
            }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "ftp_stat",
        description: "Retrieve comprehensive metadata for a remote property, including size, modification timestamps, and UNIX permissions.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote file or directory path."
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_exists",
        description: "Check for the existence of a file or folder without performing heavy file operations. Use this for conditional logic workflows.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote target path."
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_tree",
        description: "Generate a complete recursive directory map. Use this to visualize project structure, but be cautious with 'maxDepth' in very large remote repositories to avoid excessive network payload.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote directory path to start mapping from (defaults to root).",
              default: "."
            },
            maxDepth: {
              type: "number",
              description: "Maximum recursion depth to prevent infinite loops or huge payloads.",
              default: 10
            }
          }
        }
      },
      {
        name: "ftp_search",
        description: "Advanced remote file search. Supports finding files by name (wildcards), extension, or content regex (grep-like). Use this to find specific code patterns across the remote workspace.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "File name pattern (e.g. `*.js`, `db_*`)."
            },
            contentPattern: {
              type: "string",
              description: "Regex pattern to search inside file contents. Highly efficient for finding variable usage or specific logic."
            },
            extension: {
              type: "string",
              description: "Restrict search to specific file extensions (e.g. `.css`)."
            },
            findLikelyConfigs: {
              type: "boolean",
              description: "Prioritize searching for project manifests and config files (package.json, .env, etc.)",
              default: false
            },
            path: {
              type: "string",
              description: "Remote directory to start the recursive search in.",
              default: "."
            },
            limit: {
              type: "number",
              description: "Maximum matches to return.",
              default: 50
            },
            offset: {
              type: "number",
              description: "Skip initial matches for pagination.",
              default: 0
            }
          }
        }
      },
      {
        name: "ftp_copy",
        description: "Directly duplicate a file on the remote server without downloading and re-uploading. CRITICAL: Only supported on SFTP connections.",
        inputSchema: {
          type: "object",
          properties: {
            sourcePath: {
              type: "string",
              description: "Qualified remote source path."
            },
            destPath: {
              type: "string",
              description: "Target remote destination path."
            }
          },
          required: ["sourcePath", "destPath"]
        }
      },
      {
        name: "ftp_batch_upload",
        description: "Upload a collection of local files to remote destinations in a single operation. HIGHLY RECOMMENDED for multiple files to minimize connection handshaking overhead and drastically improve performance.",
        inputSchema: {
          type: "object",
          properties: {
            files: {
              type: "array",
              description: "A list of objects, each defining a local source and a remote destination.",
              items: {
                type: "object",
                properties: {
                  localPath: { type: "string", description: "Source path on your local machine." },
                  remotePath: { type: "string", description: "Target path on the remote server." }
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
        description: "Download a selection of remote files to local destinations. HIGHLY RECOMMENDED for bulk downloads to leverage stable socket persistence.",
        inputSchema: {
          type: "object",
          properties: {
            files: {
              type: "array",
              description: "A list of objects mapping remote sources to local destinations.",
              items: {
                type: "object",
                properties: {
                  remotePath: { type: "string", description: "Source path on the remote server." },
                  localPath: { type: "string", description: "Destination path on your local machine." }
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
        description: "Deploy entire project folders using smart synchronization. Analyzes local and remote directory trees and only transfers files that have changed in size or modification date. Automatically respects .gitignore and .ftpignore.",
        inputSchema: {
          type: "object",
          properties: {
            localPath: {
              type: "string",
              description: "The source directory on your local machine."
            },
            remotePath: {
              type: "string",
              description: "The target destination directory on the remote server."
            },
            direction: {
              type: "string",
              description: "Sync direction. Currently only 'upload' is implemented for safety.",
              enum: ["upload"],
              default: "upload"
            },
            dryRun: {
              type: "boolean",
              description: "If true, logs exactly which files would be changed without performing any actual transfers.",
              default: false
            },
            useManifest: {
              type: "boolean",
              description: "Enables the local manifest cache for extremely fast delta detection on subsequent syncs.",
              default: true
            }
          },
          required: ["localPath", "remotePath"]
        }
      },
      {
        name: "ftp_disk_space",
        description: "Query the remote server for available disk space. CRITICAL: Only available on SFTP connections.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote filesystem path to check (defaults to server root).",
              default: "."
            }
          }
        }
      },
      {
        name: "ftp_upload",
        description: "Standard single-file transport to the remote server. For bulk transfers, favor ftp_batch_upload.",
        inputSchema: {
          type: "object",
          properties: {
            localPath: {
              type: "string",
              description: "Source path on your local machine."
            },
            remotePath: {
              type: "string",
              description: "Target location on the remote server."
            }
          },
          required: ["localPath", "remotePath"]
        }
      },
      {
        name: "ftp_download",
        description: "Standard single-file transport from the remote server. For bulk downloads, favor ftp_batch_download.",
        inputSchema: {
          type: "object",
          properties: {
            remotePath: {
              type: "string",
              description: "Source file location on the remote server."
            },
            localPath: {
              type: "string",
              description: "Destination location on your local machine."
            }
          },
          required: ["remotePath", "localPath"]
        }
      },
      {
        name: "ftp_delete",
        description: "Permanently remove a file from the remote server. Use with caution.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The remote file path to be destroyed."
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_mkdir",
        description: "Create a new directory structure on the remote server. Supports nested creation (mkdir -p).",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The remote directory path to create."
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_rmdir",
        description: "Delete a directory from the remote server.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The remote directory path to remove."
            },
            recursive: {
              type: "boolean",
              description: "If true, deletes all files and subdirectories within the target directory.",
              default: false
            }
          },
          required: ["path"]
        }
      },
      {
        name: "ftp_chmod",
        description: "Change remote file permissions. CRITICAL: Only supported on SFTP connections.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Remote file path to modify."
            },
            mode: {
              type: "string",
              description: "Standard octal permission string (e.g., '755' for executable, '644' for read-write)."
            }
          },
          required: ["path", "mode"]
        }
      },
      {
        name: "ftp_rename",
        description: "Move or rename files and directories on the remote server.",
        inputSchema: {
          type: "object",
          properties: {
            oldPath: {
              type: "string",
              description: "Current remote location."
            },
            newPath: {
              type: "string",
              description: "New desired remote location."
            }
          },
          required: ["oldPath", "newPath"]
        }
      },
      {
        name: "ftp_rollback",
        description: "Undo a previous file mutation by restoring it from a system-generated snapshot. This provides safety during complex refactoring tasks.",
        inputSchema: {
          type: "object",
          properties: {
            transactionId: {
              type: "string",
              description: "Specific ID associated with the snapshot (e.g., 'tx_12345'). Get this from ftp_list_transactions."
            }
          },
          required: ["transactionId"]
        }
      },
      {
        name: "ftp_list_transactions",
        description: "Expose all recent mutations currently stored in the system's SnapshotManager. Essential for planning rollbacks.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "ftp_probe_capabilities",
        description: "Scan the remote server to determine supported filesystem features (e.g., chmod availability, symlink support, disk space querying). Helpful for troubleshooting capabilities.",
        inputSchema: {
          type: "object",
          properties: {
            testPath: {
              type: "string",
              description: "A safe, ephemeral directory to run capability benchmarks in.",
              default: "."
            }
          }
        }
      },
      {
        name: "ftp_telemetry",
        description: "Retrieve internal performance metrics, including average latency, connection pool health, and total processed bytes.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "mcp://instruction/server-state",
        name: "Active Server Instruction & Context",
        description: "Provides a real-time summary of the active connection profile, security constraints, and operational hints to optimize agent behavior.",
        mimeType: "text/markdown"
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "mcp://instruction/server-state") {
    const isReadOnly = currentConfig?.readOnly || false;
    const protocol = currentConfig?.host?.startsWith('sftp://') ? 'SFTP' : 'FTP';
    
    const content = `# ftp-mcp Server Context (Agent Guide)
**Current Version:** ${SERVER_VERSION}
**Active Profile:** ${currentProfile || 'Environment Variables'}
**Connection Mode:** ${protocol}
**Security Status:** ${isReadOnly ? 'READ-ONLY (Destructive operations disabled)' : 'READ-WRITE'}

## 💡 Operational Recommendations:
1. **Prefer Patches**: Use \`ftp_patch_file\` instead of \`ftp_put_contents\` for existing files to minimize token usage and bandwidth.
2. **Batch for Speed**: Use \`ftp_batch_upload\` and \`ftp_batch_download\` for multi-file operations.
3. **Workspace Context**: If this is a new codebase, run \`ftp_analyze_workspace "."\` to identify framework patterns.
4. **Safety**: Server uses automatic SHA-256 drift protection in snapshots. Use \`ftp_rollback\` if a refactor goes wrong.

[END OF SYSTEM INSTRUCTION]`;

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/markdown",
          text: content
        }
      ]
    };
  }

  // Handle mcp://remote-file/{path} template
  if (request.params.uri.startsWith("mcp://remote-file/")) {
    const filePath = request.params.uri.replace("mcp://remote-file/", "");
    if (!currentConfig) throw new Error("No active connection. Use ftp_connect first.");

    // SECURITY: Block path traversal in URI template
    if (filePath.includes('..')) {
      throw new Error(`Invalid path: Path traversal attempted in resource URI: ${filePath}`);
    }

    // SECURITY: Validate against policy engine
    try {
      const policyEngine = new PolicyEngine(currentConfig || {});
      policyEngine.validateOperation('read', { path: filePath });
    } catch (e) {
      throw new Error(`Policy Violation: ${e.message}`);
    }
    
    try {
      const entry = await getClient(currentConfig);
      const content = await entry.execute(async (client) => {
        if (client._isSFTP) {
          const buffer = await client.get(filePath);
          return buffer.toString('utf8');
        } else {
          const chunks = [];
          const stream = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
          await client.downloadTo(stream, filePath);
          return Buffer.concat(chunks).toString('utf8');
        }
      });

      return {
        contents: [{
          uri: request.params.uri,
          mimeType: "text/plain",
          text: content
        }]
      };
    } finally {
      if (currentConfig) releaseClient(currentConfig);
    }
  }

  throw new Error(`Resource not found: ${request.params.uri}`);
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        uriTemplate: "mcp://remote-file/{path}",
        name: "Remote File Content",
        description: "Read the full UTF-8 content of any remote file as an MCP resource."
      }
    ]
  };
});

async function countFilesRecursive(localPath, ignorePatterns = null, basePath = null) {
  if (ignorePatterns === null) {
    ignorePatterns = await loadIgnorePatterns(localPath);
    basePath = localPath;
  }

  let count = 0;
  const files = await fs.readdir(localPath, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(localPath, file.name);
    if (shouldIgnore(fullPath, ignorePatterns, basePath) || isSecretFile(fullPath)) continue;

    if (file.isDirectory()) {
      count += await countFilesRecursive(fullPath, ignorePatterns, basePath);
    } else {
      count++;
    }
  }
  return count;
}

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "audit-project",
        description: "Perform a security and architectural review of the remote workspace.",
        arguments: [
          {
            name: "path",
            description: "Path to audit (defaults to root)",
            required: false
          }
        ]
      },
      {
        name: "deploy-checklist",
        description: "Guide the agent through a pre-deployment safety check.",
        arguments: [
          {
            name: "deployment",
            description: "Target deployment name from .ftpconfig",
            required: true
          }
        ]
      }
    ]
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name === "audit-project") {
    const path = request.params.arguments?.path || ".";
    return {
      description: "Project Security & Architecture Audit",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please audit the remote workspace at \`${path}\`. 
Follow these steps:
1. Run \`ftp_analyze_workspace "${path}"\` to detect framework patterns.
2. List sensitive directories to ensure no secrets are exposed.
3. Search for configuration files (e.g., \`.env\`, \`config.js\`) using \`ftp_search\`.
4. Review the primary dependency manifest (e.g., \`package.json\`) for security risks.
Summarize your findings with a focus on potential vulnerabilities and architectural improvements.`
          }
        }
      ]
    };
  }

  if (request.params.name === "deploy-checklist") {
    const deployment = request.params.arguments?.deployment;
    return {
      description: "Pre-Deployment Safety Check",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Perform a safety check before deploying to \`${deployment}\`.
1. Verify the deployment exists with \`ftp_list_deployments\`.
2. Check remote disk space with \`ftp_disk_space\` (if SFTP).
3. List the target remote directory to ensure no critical files are being overwritten without a backup.
4. Run \`ftp_sync\` with \`dryRun: true\` to preview the changes.
Report if it is safe to proceed with the actual deployment.`
          }
        }
      ]
    };
  }
  throw new Error(`Prompt not found: ${request.params.name}`);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "ftp_list_deployments") {
    try {
      const configData = await fs.readFile(CONFIG_FILE, 'utf8');
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
      const configData = await fs.readFile(CONFIG_FILE, 'utf8');
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

      // CODE-2: Use a local-scoped config to avoid mutating the module-level
      // currentConfig/currentProfile globals, which would corrupt subsequent tool calls.
      const deployProfileConfig = profileConfig;
      const deployProfileName = deployConfig.profile;
      const useSFTP = isSFTP(deployProfileConfig.host);
      const deployEntry = await getClient(deployProfileConfig);

      try {
        const localPath = path.resolve(deployConfig.local);
        const stats = await syncFiles(
          deployEntry.client,
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
            text: `Deployment "${deployment}" complete:\n${deployConfig.description || ''}\n\nProfile: ${deployProfileName}\nLocal: ${deployConfig.local}\nRemote: ${deployConfig.remote}\n\nUploaded: ${stats.uploaded}\nSkipped: ${stats.skipped}\nIgnored: ${stats.ignored}\n${stats.errors.length > 0 ? '\nErrors:\n' + stats.errors.join('\n') : ''}`
          }]
        };
      } finally {
        releaseClient(deployProfileConfig);
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

      // LOW-5: Perform a real connection test so credential errors surface early
      try {
        const testEntry = await getClient(currentConfig);
        await testEntry.execute(c => c.list('.'));
      } catch (connErr) {
        currentConfig = null;
        return {
          content: [{ type: "text", text: `Error: Could not connect — ${connErr.message}` }],
          isError: true
        };
      }

      let warning = "";
      const isProd = (profile || currentProfile || '').toLowerCase().includes('prod');
      if (isProd && !isSFTP(currentConfig.host)) {
        warning = "\n⚠️ SECURITY WARNING: You are connecting to a production profile using insecure FTP. SFTP is strongly recommended.";
      }

      let hint = "";
      if (!sessionHintShown) {
        hint = `\n\n${getAISuggestion('hint_connected')}`;
        sessionHintShown = true;
      }

      return {
        content: [{
          type: "text",
          text: `Connected to profile: ${profile || currentProfile || 'environment variables'}\nHost: ${currentConfig.host}${warning}${hint}`
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
            files = await client.list(path);
            files.sort((a, b) => a.name.localeCompare(b.name));
            setCached(poolKey, 'LIST', path, files);
          }

          const total = files.length;
          const sliced = files.slice(offset, offset + limit);

          const formatted = sliced.map(f => {
            const isDir = (useSFTP ? f.type === 'd' : f.isDirectory);
            const icon = isDir ? ICON.DIR : ICON.FILE;
            const label = isDir ? '[DIR] ' : '[FILE]';
            
            let marker = "";
            const nameLower = f.name.toLowerCase();
            if (['package.json', 'composer.json', 'requirements.txt', 'pyproject.toml', 'go.mod'].includes(nameLower)) marker = ` ${ICON.PKG}`;
            else if (nameLower.includes('config') || nameLower.endsWith('.conf') || nameLower.endsWith('.yaml') || nameLower.endsWith('.yml')) marker = ` ${ICON.CONFIG}`;
            else if (isSecretFile(f.name)) marker = ` ${ICON.SECRET}`;
            else if (nameLower.endsWith('.bak') || nameLower.endsWith('.tmp') || nameLower.startsWith('~')) marker = ` ${ICON.BACKUP}`;

            const rights = useSFTP && f.rights ? `, ${f.rights.user || ''}${f.rights.group || ''}${f.rights.other || ''}` : '';
            return `${icon}${marker} ${label} ${f.name} (${f.size} bytes${rights})`;
          }).join('\n');

          const paginationInfo = `\n\nShowing ${offset + 1} to ${Math.min(offset + limit, total)} of ${total} items.`;
          const hint = total > 0 && sliced.some(f => f.name === 'package.json') ? `\n\n${getAISuggestion('hint_list_config')}` : "";

          return {
            content: [{ type: "text", text: (formatted || "Empty directory") + (total > limit ? paginationInfo : '') + hint }]
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
          const { path: filePath } = request.params.arguments;

          if (useSFTP) {
            const stats = await client.stat(filePath);
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
            // CODE-4: use filePath (not path module) for string operations
            const dirPart = filePath.substring(0, filePath.lastIndexOf('/')) || '.';
            const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
            const files = await client.list(dirPart);
            const file = files.find(f => f.name === fileName);

            if (!file) {
              throw new Error(`File not found: ${filePath}`);
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
          const { path: filePath } = request.params.arguments;
          let exists = false;

          try {
            if (useSFTP) {
              await client.stat(filePath);
              exists = true;
            } else {
              // CODE-4: use filePath string, not the path module
              const dirPart = filePath.substring(0, filePath.lastIndexOf('/')) || '.';
              const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
              const files = await client.list(dirPart);
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

          // SEC-4: Validate user-supplied regex patterns to prevent ReDoS
          let compiledPattern = null;
          if (pattern) {
            const safeGlob = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
            const result = safeRegex(safeGlob);
            if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
            compiledPattern = result.regex;
          }

          let compiledContentPattern = null;
          if (contentPattern) {
            const result = safeRegex(contentPattern);
            if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
            compiledContentPattern = result.regex;
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

          if (compiledPattern) {
            matches = matches.filter(item => compiledPattern.test(item.name));
          }

          if (extension) {
            const ext = extension.startsWith('.') ? extension : `.${extension}`;
            matches = matches.filter(item => item.name.endsWith(ext));
          }

          const total = matches.length;
          let sliced = matches.slice(offset, offset + limit);
          let formatted = "";

          if (compiledContentPattern) {
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
                  if (compiledContentPattern.test(lines[i])) {
                    const start = Math.max(0, i - 1);
                    const end = Math.min(lines.length - 1, i + 1);
                    const context = lines.slice(start, end + 1).map((l, idx) => `${start + idx + 1}: ${l}`).join('\n');
                    contentMatches.push(`File: ${item.path}\n${context}\n---`);
                    break;
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
          const hint = total === 0 ? `\n\n[AI: No matches found. Suggested fix: Try a broader wildcard pattern like \`*\` or verify your current \`path\` is correct.]` : "";
          return {
            content: [{ type: "text", text: (formatted || "No matches found") + (total > limit ? paginationInfo : '') + hint }]
          };
        }

        case "ftp_analyze_workspace": {
          const path = request.params.arguments?.path || ".";
          let files = getCached(poolKey, 'LIST', path);
          if (!files) {
            files = await client.list(path);
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

          // LOW-3: Validate both paths against policy engine
          try {
            policyEngine.validateOperation('overwrite', { path: destPath });
            policyEngine.validateOperation('patch', { path: sourcePath });
          } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
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
          const snapshotPaths = files.map(f => f.remotePath);
          const batchTxId = await snapshotManager.createSnapshot(client, useSFTP, snapshotPaths);

          const progressToken = request.params._meta?.progressToken;
          if (progressToken) {
            server.notification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: 0,
                total: files.length,
                message: "Starting batch upload..."
              }
            });
          }

          let current = 0;

          for (const file of files) {
            // CODE-6/SEC-3: Apply same security guards as ftp_upload
            try { validateLocalPath(file.localPath); } catch (e) {
              results.failed.push({ path: file.remotePath, error: e.message });
              continue;
            }
            if (isSecretFile(file.localPath)) {
              results.failed.push({ path: file.remotePath, error: `Blocked: likely secret file` });
              continue;
            }
            try {
              const stat = await fs.stat(file.localPath);
              policyEngine.validateOperation('overwrite', { path: file.remotePath, size: stat.size });
            } catch (e) {
              results.failed.push({ path: file.remotePath, error: e.message });
              continue;
            }
            try {
              if (useSFTP) {
                await client.put(file.localPath, file.remotePath);
              } else {
                await client.uploadFrom(file.localPath, file.remotePath);
              }
              results.success.push(file.remotePath);

              if (progressToken) {
                current++;
                server.notification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: current,
                    total: files.length,
                    message: `Uploaded ${path.basename(file.remotePath)}`
                  }
                });
              }
            } catch (error) {
              results.failed.push({ path: file.remotePath, error: error.message });
            }
          }

          return {
            content: [{
              type: "text",
              text: `Uploaded: ${results.success.length}\nFailed: ${results.failed.length}\nTransaction ID: ${batchTxId}\n${results.failed.length > 0 ? '\nErrors:\n' + results.failed.map(f => `${f.path}: ${f.error}`).join('\n') : ''}`
            }]
          };
        }

        case "ftp_batch_download": {
          const { files } = request.params.arguments;
          const results = { success: [], failed: [] };

          const progressToken = request.params._meta?.progressToken;
          if (progressToken) {
            server.notification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: 0,
                total: files.length,
                message: "Starting batch download..."
              }
            });
          }

          let current = 0;

          for (const file of files) {
            // CODE-7/SEC-2: Validate local paths to prevent path traversal
            try { validateLocalPath(file.localPath); } catch (e) {
              results.failed.push({ path: file.remotePath, error: e.message });
              continue;
            }
            try {
              if (useSFTP) {
                await client.get(file.remotePath, file.localPath);
              } else {
                await client.downloadTo(file.localPath, file.remotePath);
              }
              results.success.push(file.remotePath);

              if (progressToken) {
                current++;
                server.notification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: current,
                    total: files.length,
                    message: `Downloaded ${path.basename(file.remotePath)}`
                  }
                });
              }
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

          const progressToken = request.params._meta?.progressToken;
          let progressState = null;

          if (progressToken && !dryRun) {
            const total = await countFilesRecursive(localPath);
            progressState = { token: progressToken, current: 0, total };
          }

          const stats = await syncFiles(client, useSFTP, localPath, remotePath, direction, null, null, [], dryRun, useManifest, true, progressState);
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

          // SEC-3: Block path traversal and enforce local path safety
          try { validateLocalPath(localPath); } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

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

          const txIdUpload = await snapshotManager.createSnapshot(client, useSFTP, [remotePath]);

          if (useSFTP) {
            await client.put(localPath, remotePath);
          } else {
            await client.uploadFrom(localPath, remotePath);
          }

          return {
            content: [{ type: "text", text: `Successfully uploaded ${localPath} to ${remotePath}\nTransaction ID: ${txIdUpload}` }]
          };
        }

        case "ftp_download": {
          const { remotePath, localPath } = request.params.arguments;

          // SEC-1: Block path traversal and enforce local path safety
          try { validateLocalPath(localPath); } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

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

          // CODE-5: Block dangerous root-level paths
          try { assertSafeRemotePath(filePath); } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

          try {
            policyEngine.validateOperation('delete', { path: filePath });
          } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

          const txIdDelete = await snapshotManager.createSnapshot(client, useSFTP, [filePath]);

          if (useSFTP) {
            await client.delete(filePath);
          } else {
            await client.remove(filePath);
          }

          return {
            content: [{ type: "text", text: `Successfully deleted ${filePath}\nTransaction ID: ${txIdDelete}` }]
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
          const { path: rmPath, recursive } = request.params.arguments;

          // CODE-5: Block dangerous root-level paths
          try { assertSafeRemotePath(rmPath); } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }

          if (useSFTP) {
            await client.rmdir(rmPath, recursive);
          } else {
            if (recursive) {
              await client.removeDir(rmPath);
            } else {
              await client.removeEmptyDir(rmPath);
            }
          }

          return {
            content: [{ type: "text", text: `Successfully removed directory ${rmPath}` }]
          };
        }

        case "ftp_chmod": {
          const { path: chmodPath, mode } = request.params.arguments;

          if (!useSFTP) {
            return {
              content: [{ type: "text", text: "Error: chmod is only supported for SFTP connections" }]
            };
          }

          // LOW-2: Parse octal string to number; reject invalid modes
          const modeInt = parseInt(mode, 8);
          if (isNaN(modeInt) || modeInt < 0 || modeInt > 0o7777) {
            return {
              content: [{ type: "text", text: `Error: Invalid chmod mode '${mode}'. Use octal notation e.g. '755'.` }],
              isError: true
            };
          }

          await client.chmod(chmodPath, modeInt);

          return {
            content: [{ type: "text", text: `Successfully changed permissions of ${chmodPath} to ${mode}` }]
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

          await client.rename(oldPath, newPath);

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
    let suggestion = "";
    const nameLower = error.message.toLowerCase();
    if (nameLower.includes('enoent') || nameLower.includes('not found')) {
      suggestion = `\n\n${getAISuggestion('error_enoent', { path: request.params.arguments?.path || request.params.arguments?.remotePath || 'target' })}`;
    } else if (nameLower.includes('permission') || nameLower.includes('eacces')) {
      suggestion = `\n\n${getAISuggestion('error_permission', { path: request.params.arguments?.path || request.params.arguments?.remotePath || 'target' })}`;
    }

    return {
      content: [{ type: "text", text: `Error: ${error.message}${suggestion}` }],
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

// LOW-1: Graceful shutdown — close all pooled connections before exiting
async function shutdown(signal) {
  console.error(`[ftp-mcp] Received ${signal}, closing connections...`);
  for (const [poolKey, entry] of connectionPool.entries()) {
    try {
      if (!entry.closed) {
        entry.closed = true;
        if (entry.client._isSFTP) await entry.client.end();
        else entry.client.close();
      }
    } catch (e) { /* ignore */ }
  }
  connectionPool.clear();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

