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
import path from "path";
import { fileURLToPath } from "url";
import { Readable, Writable } from "stream";
import { minimatch } from "minimatch";

// --init: scaffold .ftpconfig.example into the user's current working directory
if (process.argv.includes("--init")) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const exampleSrc = path.join(__dirname, ".ftpconfig.example");
  const destExample = path.join(process.cwd(), ".ftpconfig.example");
  const destConfig  = path.join(process.cwd(), ".ftpconfig");

  try {
    await fs.copyFile(exampleSrc, destExample);
    console.log(`✅ Created .ftpconfig.example in ${process.cwd()}`);

    // Only create .ftpconfig if one doesn't already exist
    try {
      await fs.access(destConfig);
      console.log(`ℹ️  .ftpconfig already exists — leaving it untouched.`);
    } catch {
      await fs.copyFile(exampleSrc, destConfig);
      console.log(`✅ Created .ftpconfig — fill in your credentials and you're ready to go!`);
    }

    console.log(`\nNext steps:`);
    console.log(`  1. Edit .ftpconfig with your FTP/SFTP credentials`);
    console.log(`  2. Add ftp-mcp to your MCP client config (see README)`);
    console.log(`  3. Done! Ask your AI to "list files on my FTP server"\n`);
  } catch (err) {
    console.error(`❌ Init failed: ${err.message}`);
    process.exit(1);
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

function shouldIgnore(filePath, ignorePatterns, basePath) {
  const relativePath = path.relative(basePath, filePath).replace(/\\/g, '/');
  
  for (const pattern of ignorePatterns) {
    if (minimatch(relativePath, pattern, { dot: true, matchBase: true })) {
      return true;
    }
    if (minimatch(path.basename(filePath), pattern, { dot: true })) {
      return true;
    }
  }
  
  return false;
}

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
    const configPath = path.join(process.cwd(), '.ftpconfig');
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);

    if (profileName) {
      if (config[profileName]) {
        currentProfile = profileName;
        return config[profileName];
      }
      throw new Error(`Profile "${profileName}" not found in .ftpconfig`);
    }

    if (config.default) {
      currentProfile = 'default';
      return config.default;
    }

    const profiles = Object.keys(config);
    if (profiles.length > 0) {
      currentProfile = profiles[0];
      return config[profiles[0]];
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
  await client.connect({
    host: config.host.replace('sftp://', ''),
    port: getPort(config.host, config.port),
    username: config.user,
    password: config.password
  });
  return client;
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

async function syncFiles(client, useSFTP, localPath, remotePath, direction, ignorePatterns = null, basePath = null, extraExclude = []) {
  const stats = { uploaded: 0, downloaded: 0, skipped: 0, errors: [], ignored: 0 };
  
  if (ignorePatterns === null) {
    ignorePatterns = await loadIgnorePatterns(localPath);
    basePath = localPath;
  }
  
  if (extraExclude.length > 0) {
    ignorePatterns = [...ignorePatterns, ...extraExclude];
  }
  
  if (direction === 'upload' || direction === 'both') {
    const localFiles = await fs.readdir(localPath, { withFileTypes: true });
    
    for (const file of localFiles) {
      const localFilePath = path.join(localPath, file.name);
      const remoteFilePath = `${remotePath}/${file.name}`;
      
      if (shouldIgnore(localFilePath, ignorePatterns, basePath)) {
        stats.ignored++;
        continue;
      }
      
      try {
        if (file.isDirectory()) {
          if (useSFTP) {
            await client.mkdir(remoteFilePath, true);
          } else {
            await client.ensureDir(remoteFilePath);
          }
          const subStats = await syncFiles(client, useSFTP, localFilePath, remoteFilePath, direction, ignorePatterns, basePath, extraExclude);
          stats.uploaded += subStats.uploaded;
          stats.downloaded += subStats.downloaded;
          stats.skipped += subStats.skipped;
          stats.ignored += subStats.ignored;
          stats.errors.push(...subStats.errors);
        } else {
          const localStat = await fs.stat(localFilePath);
          let shouldUpload = true;
          
          try {
            const remoteStat = useSFTP 
              ? await client.stat(remoteFilePath)
              : (await client.list(remotePath)).find(f => f.name === file.name);
            
            if (remoteStat) {
              const remoteTime = remoteStat.modifyTime || remoteStat.modifiedAt || new Date(remoteStat.rawModifiedAt);
              if (localStat.mtime <= remoteTime) {
                shouldUpload = false;
                stats.skipped++;
              }
            }
          } catch (e) {
            // File doesn't exist remotely, upload it
          }
          
          if (shouldUpload) {
            if (useSFTP) {
              await client.put(localFilePath, remoteFilePath);
            } else {
              await client.uploadFrom(localFilePath, remoteFilePath);
            }
            stats.uploaded++;
          }
        }
      } catch (error) {
        stats.errors.push(`${localFilePath}: ${error.message}`);
      }
    }
  }
  
  return stats;
}

const server = new Server(
  {
    name: "ftp-mcp-server",
    version: "2.0.0",
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
            }
          },
          required: ["path"]
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
        description: "Find files by name pattern on FTP/SFTP server",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Search pattern (supports wildcards like *.js)"
            },
            path: {
              type: "string",
              description: "Remote path to search in",
              default: "."
            }
          },
          required: ["pattern"]
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
      const client = useSFTP ? await connectSFTP(currentConfig) : await connectFTP(currentConfig);
      
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
        if (useSFTP) {
          await client.end();
        } else {
          client.close();
        }
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
      
      if (!currentConfig.host || !currentConfig.user || !currentConfig.password) {
        return {
          content: [
            {
              type: "text",
              text: "Error: FTP credentials not configured. Please set FTPMCP_HOST, FTPMCP_USER, and FTPMCP_PASSWORD environment variables or create a .ftpconfig file."
            }
          ]
        };
      }
      
      return {
        content: [{
          type: "text",
          text: `Connected to profile: ${profile || currentProfile || 'environment variables'}\nHost: ${currentConfig.host}`
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
        ]
      };
    }
  }

  if (!currentConfig.host || !currentConfig.user || !currentConfig.password) {
    return {
      content: [
        {
          type: "text",
          text: "Error: FTP credentials not configured. Please set FTPMCP_HOST, FTPMCP_USER, and FTPMCP_PASSWORD environment variables or create a .ftpconfig file."
        }
      ]
    };
  }

  const useSFTP = isSFTP(currentConfig.host);
  let client;

  try {
    client = useSFTP ? await connectSFTP(currentConfig) : await connectFTP(currentConfig);

    switch (request.params.name) {
      case "ftp_list": {
        const path = request.params.arguments?.path || ".";
        let files;
        
        if (useSFTP) {
          files = await client.list(path);
          const formatted = files.map(f => 
            `${f.type === 'd' ? 'DIR' : 'FILE'} ${f.name} (${f.size} bytes, ${f.rights?.user}${f.rights?.group}${f.rights?.other})`
          ).join('\n');
          return {
            content: [{ type: "text", text: formatted || "Empty directory" }]
          };
        } else {
          files = await client.list(path);
          const formatted = files.map(f => 
            `${f.isDirectory ? 'DIR' : 'FILE'} ${f.name} (${f.size} bytes)`
          ).join('\n');
          return {
            content: [{ type: "text", text: formatted || "Empty directory" }]
          };
        }
      }

      case "ftp_get_contents": {
        const { path } = request.params.arguments;
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
        
        return {
          content: [{ type: "text", text: content }]
        };
      }

      case "ftp_put_contents": {
        const { path, content } = request.params.arguments;
        
        if (useSFTP) {
          const buffer = Buffer.from(content, 'utf8');
          await client.put(buffer, path);
        } else {
          const readable = Readable.from([content]);
          await client.uploadFrom(readable, path);
        }
        
        return {
          content: [{ type: "text", text: `Successfully wrote content to ${path}` }]
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
        const tree = await getTreeRecursive(client, useSFTP, path, 0, maxDepth);
        
        const formatted = tree.map(item => {
          const indent = '  '.repeat((item.path.match(/\//g) || []).length);
          return `${indent}${item.isDirectory ? '📁' : '📄'} ${item.name} ${!item.isDirectory ? `(${item.size} bytes)` : ''}`;
        }).join('\n');
        
        return {
          content: [{ type: "text", text: formatted || "Empty directory" }]
        };
      }

      case "ftp_search": {
        const { pattern, path = "." } = request.params.arguments;
        const tree = await getTreeRecursive(client, useSFTP, path, 0, 10);
        
        const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
        const matches = tree.filter(item => regex.test(item.name));
        
        const formatted = matches.map(item => 
          `${item.path} (${item.isDirectory ? 'DIR' : item.size + ' bytes'})`
        ).join('\n');
        
        return {
          content: [{ type: "text", text: formatted || "No matches found" }]
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
        const { localPath, remotePath, direction = "upload" } = request.params.arguments;
        const stats = await syncFiles(client, useSFTP, localPath, remotePath, direction);
        
        return {
          content: [{
            type: "text",
            text: `Sync complete:\nUploaded: ${stats.uploaded}\nDownloaded: ${stats.downloaded}\nSkipped: ${stats.skipped}\nIgnored: ${stats.ignored}\n${stats.errors.length > 0 ? '\nErrors:\n' + stats.errors.join('\n') : ''}`
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
        
        if (useSFTP) {
          await client.put(localPath, remotePath);
        } else {
          await client.uploadFrom(localPath, remotePath);
        }
        
        return {
          content: [{ type: "text", text: `Successfully uploaded ${localPath} to ${remotePath}` }]
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
        const { path } = request.params.arguments;
        
        if (useSFTP) {
          await client.delete(path);
        } else {
          await client.remove(path);
        }
        
        return {
          content: [{ type: "text", text: `Successfully deleted ${path}` }]
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
        
        if (useSFTP) {
          await client.rename(oldPath, newPath);
        } else {
          await client.rename(oldPath, newPath);
        }
        
        return {
          content: [{ type: "text", text: `Successfully renamed ${oldPath} to ${newPath}` }]
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  } finally {
    if (client) {
      if (useSFTP) {
        await client.end();
      } else {
        client.close();
      }
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
