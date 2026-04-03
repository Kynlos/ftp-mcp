# ftp-mcp

MCP server providing enhanced FTP/SFTP operations with smart sync, search, and direct file access.

## Features

- 🚀 **Deployment Presets** - Save complete deployment workflows, run with one command
- 🔄 **Smart Sync** - Only transfer changed files between local and remote
- 🛡️ **Git-Aware** - Automatically respects `.gitignore` and `.ftpignore` patterns
- 🔍 **Search & Tree** - Find files by pattern, view entire directory structures
- 📝 **Direct Access** - Read/write file contents without downloading
- 📦 **Batch Operations** - Upload/download multiple files at once
- 🔐 **Multi-Profile** - Support for multiple FTP servers via `.ftpconfig`
- ⚡ **FTP & SFTP** - Automatic protocol detection
- 🎯 **Metadata Operations** - Check existence, get stats, manage permissions

## Quick Start

### 1. Install & Initialise

Run this **in your project directory** to scaffold the config files:

```bash
npx ftp-mcp --init
```

This creates `.ftpconfig` and `.ftpconfig.example` in your current directory. Then install globally so your MCP client can always find the server:

```bash
npm install -g ftp-mcp
```

### 2. Configure Credentials

**Option A: Environment Variables**

**Required:**
```bash
# Windows
setx FTPMCP_HOST "ftp.example.com"
setx FTPMCP_USER "username"
setx FTPMCP_PASSWORD "password"

# Linux/Mac
export FTPMCP_HOST="ftp.example.com"
export FTPMCP_USER="username"
export FTPMCP_PASSWORD="password"
```

**Optional:**
```bash
# Windows
setx FTPMCP_PORT "21"              # Custom port (defaults: 21 for FTP, 22 for SFTP)

# Linux/Mac
export FTPMCP_PORT="21"            # Custom port (defaults: 21 for FTP, 22 for SFTP)
```

**Variable Reference:**
- `FTPMCP_HOST` *(required)* - FTP server hostname (e.g., `ftp.example.com` or `sftp://sftp.example.com`)
- `FTPMCP_USER` *(required)* - Username for authentication
- `FTPMCP_PASSWORD` *(required)* - Password for authentication
- `FTPMCP_PORT` *(optional)* - Custom port number (defaults: 21 for FTP, 22 for SFTP)

**Option B: Project Config File (Recommended)**

Create `.ftpconfig` in your project directory:

```json
{
  "production": {
    "host": "ftp.example.com",
    "user": "prod-user",
    "password": "your-password",
    "port": 21,
    "secure": false
  },
  "staging": {
    "host": "sftp://staging.example.com",
    "user": "staging-user",
    "password": "your-password",
    "port": 22
  },
  "default": {
    "host": "ftp.mysite.com",
    "user": "default-user",
    "password": "your-password"
  }
}
```

The server will check for `.ftpconfig` first, then fall back to environment variables.

**Add Deployment Presets (Optional but Recommended):**

In the same `.ftpconfig` file, add a `deployments` section to save complete deployment workflows:

```json
{
  "production": {
    "host": "ftp.example.com",
    "user": "prod-user",
    "password": "your-password"
  },
  "deployments": {
    "deploy-frontend": {
      "profile": "production",
      "local": "./dist",
      "remote": "/public_html",
      "description": "Deploy frontend build to production",
      "exclude": [
        "*.map",
        "*.test.js",
        "test/**"
      ]
    },
    "deploy-api": {
      "profile": "production",
      "local": "./api/build",
      "remote": "/api",
      "description": "Deploy API to production"
    }
  }
}
```

Then simply say: **"Deploy frontend"** or **"Run deploy-api"** in Amp!

### 3. Add to Amp Code

Open **Settings → MCP Servers**, click **Add Server**:

- **Server Name:** `FTP` (or any name you prefer)
- **Command or URL:** `ftp-mcp-server`
- **Arguments:** (leave empty)
- **Environment Variables:** (leave empty if using system env vars)

Click **Update Server** and restart Amp.

## Deployment Presets

Deployment presets allow you to save complete deployment workflows and run them with a single command. Perfect for frequent deployments to production, staging, or development environments.

### Setting Up Deployment Presets

Add a `deployments` section to your `.ftpconfig`:

```json
{
  "production": { "host": "...", "user": "...", "password": "..." },
  "staging": { "host": "...", "user": "...", "password": "..." },
  "deployments": {
    "deploy-frontend": {
      "profile": "production",
      "local": "./dist",
      "remote": "/public_html",
      "description": "Deploy frontend build to production",
      "exclude": ["*.map", "test/**"]
    },
    "deploy-staging": {
      "profile": "staging",
      "local": "./dist",
      "remote": "/www/staging",
      "description": "Deploy to staging environment"
    }
  }
}
```

### Deployment Configuration Options

Each deployment preset can include:

- **`profile`** *(required)* - Which FTP profile to use (must exist in the same .ftpconfig)
- **`local`** *(required)* - Local directory to deploy (relative or absolute path)
- **`remote`** *(required)* - Remote destination path on the server
- **`description`** *(optional)* - Human-readable description of what this deployment does
- **`exclude`** *(optional)* - Array of additional patterns to exclude (on top of default ignores)

### Using Deployment Presets

Once configured, deployments are incredibly simple:

**In Amp, just say:**
```
"Deploy frontend"
"Run deploy-staging"
"Execute deploy-api"
```

**Or use the tools directly:**
- `ftp_list_deployments` - See all available deployment presets
- `ftp_deploy` - Run a specific deployment by name

### Example Output

```
Deployment "deploy-frontend" complete:
Deploy frontend build to production

Profile: production
Local: ./dist
Remote: /public_html

Uploaded: 23
Skipped: 5
Ignored: 47
```

### Benefits of Deployment Presets

✅ **One-Command Deployment** - No need to specify paths, profiles, or exclusions every time
✅ **Consistent Deployments** - Same configuration used every time, no human error
✅ **Multiple Environments** - Easily switch between prod, staging, dev
✅ **Team Sharing** - Commit `.ftpconfig.example` to share deployment workflows
✅ **Additional Exclusions** - Exclude deployment-specific files (like source maps)

### Real-World Examples

**Frontend Build Deployment:**
```json
"deploy-production": {
  "profile": "production",
  "local": "./build",
  "remote": "/public_html",
  "description": "Deploy React production build",
  "exclude": ["*.map", "*.md"]
}
```

**WordPress Theme:**
```json
"deploy-theme": {
  "profile": "production",
  "local": "./wp-content/themes/mytheme",
  "remote": "/wp-content/themes/mytheme",
  "description": "Deploy WordPress theme to production"
}
```

**API Backend:**
```json
"deploy-api": {
  "profile": "production",
  "local": "./api/dist",
  "remote": "/api/v1",
  "description": "Deploy Node.js API to production",
  "exclude": ["*.test.js", "docs/**"]
}
```

**Multi-Environment Setup:**
```json
{
  "production": { "host": "ftp.mysite.com", "user": "prod", "password": "..." },
  "staging": { "host": "ftp.staging.mysite.com", "user": "staging", "password": "..." },
  "deployments": {
    "deploy-prod": {
      "profile": "production",
      "local": "./dist",
      "remote": "/public_html"
    },
    "deploy-staging": {
      "profile": "staging",
      "local": "./dist",
      "remote": "/www"
    }
  }
}
```

---

## Complete Tool Reference

### Connection Management

#### `ftp_connect`
Switch between named FTP profiles from your `.ftpconfig` file or force environment variables.

**Parameters:**
- `profile` (optional): Name of profile from `.ftpconfig` (e.g., "production", "staging")
- `useEnv` (optional): Set to `true` to force use of environment variables

**Example use cases:**
- "Connect to my production FTP"
- "Switch to staging FTP server"
- "Use environment variables for FTP connection"

---

### File Content Operations

#### `ftp_get_contents`
Read file content directly from the server without downloading to disk. Perfect for viewing config files, reading logs, or checking file contents quickly.

**Parameters:**
- `path`: Remote file path to read

**Example use cases:**
- "Read the contents of config.php"
- "Show me what's in .htaccess"
- "Check the error log on the server"
- Viewing configuration files before editing
- Reading small text files for quick inspection

#### `ftp_put_contents`
Write content directly to a remote file without needing a local file. Great for creating new files or updating existing ones with generated content.

**Parameters:**
- `path`: Remote file path to write
- `content`: Content to write to the file

**Example use cases:**
- "Update config.php with new database credentials"
- "Create a new .htaccess file with these rules"
- "Write this JSON data to settings.json on the server"
- Updating configuration files programmatically
- Creating files from generated content
- Quick fixes to remote files

---

### Metadata & File Information

#### `ftp_stat`
Get detailed metadata about a file including size, modification date, and permissions. Useful for checking file info before downloading or comparing versions.

**Parameters:**
- `path`: Remote file path

**Returns:**
- File size in bytes
- Last modified timestamp
- Whether it's a directory or file
- Permissions (SFTP only)

**Example use cases:**
- "Get file stats for index.html"
- "When was config.php last modified?"
- "How large is backup.sql?"
- Checking file modification dates
- Verifying file sizes before downloading
- Auditing file changes

#### `ftp_exists`
Check if a file or folder exists on the remote server before attempting operations. Prevents errors and allows conditional logic.

**Parameters:**
- `path`: Remote path to check

**Returns:** `true` or `false`

**Example use cases:**
- "Check if backup.sql exists before downloading"
- "Does the uploads directory exist?"
- "Verify config.php is on the server"
- Conditional file operations
- Validating paths before upload/download
- Checking if backups exist

#### `ftp_disk_space` *(SFTP only)*
Check available disk space on the remote server. Useful before uploading large files or monitoring server capacity.

**Parameters:**
- `path` (optional): Remote path to check (defaults to current directory)

**Returns:**
- Total disk space
- Free space
- Available space
- Used space

**Example use cases:**
- "Check available disk space on the server"
- "How much free space is left?"
- Before uploading large files or backups
- Server capacity monitoring
- Ensuring sufficient space for operations

---

### Directory Operations

#### `ftp_list`
List all files and directories in a specific path. Shows file sizes and types (file vs directory).

**Parameters:**
- `path` (optional): Remote directory path (defaults to current directory ".")

**Example use cases:**
- "List all files in /public_html"
- "Show me what's in the uploads folder"
- "What files are in the root directory?"
- Browsing directory contents
- Finding specific files
- Auditing uploaded files

#### `ftp_tree`
Get a complete recursive directory tree showing the entire folder structure at once. Visualizes nested directories and files with emoji icons.

**Parameters:**
- `path` (optional): Remote path to start from (defaults to ".")
- `maxDepth` (optional): Maximum recursion depth (defaults to 10)

**Example use cases:**
- "Show me the complete file tree of /public_html"
- "What's the directory structure of my website?"
- "Display all files and folders recursively"
- Understanding project structure
- Finding deeply nested files
- Complete site audits

#### `ftp_search`
Find files by name pattern using wildcards. Search recursively through directories to locate specific files.

**Parameters:**
- `pattern`: Search pattern (supports wildcards like `*.js`, `config.*`, `*backup*`)
- `path` (optional): Remote directory to search in (defaults to ".")

**Example use cases:**
- "Find all .js files on the server"
- "Search for files named config.* in uploads"
- "Locate all PHP files containing 'admin' in the name"
- Finding configuration files
- Locating log files
- Searching for specific file types

#### `ftp_mkdir`
Create a new directory on the remote server. Creates parent directories automatically if they don't exist.

**Parameters:**
- `path`: Remote directory path to create

**Example use cases:**
- "Create a new directory called backups"
- "Make a folder /uploads/2025"
- Creating organized folder structures
- Setting up new project directories
- Organizing uploads by date/category

#### `ftp_rmdir`
Remove a directory from the remote server. Can delete recursively including all contents.

**Parameters:**
- `path`: Remote directory path to remove
- `recursive` (optional): Remove directory and all contents recursively

**Example use cases:**
- "Delete the old-files directory"
- "Remove /temp recursively"
- Cleaning up old directories
- Removing test folders
- Deleting empty directories

---

### File Transfer

#### `ftp_upload`
Upload a single local file to the remote server.

**Parameters:**
- `localPath`: Local file path to upload
- `remotePath`: Remote destination path

**Example use cases:**
- "Upload index.html to /public_html/"
- "Send config.php to the server"
- Deploying updated files
- Uploading new assets
- Pushing configuration changes

#### `ftp_download`
Download a single file from the remote server to your local machine.

**Parameters:**
- `remotePath`: Remote file path to download
- `localPath`: Local destination path

**Example use cases:**
- "Download backup.sql from the server"
- "Get a copy of the config file"
- Retrieving backups
- Downloading logs for analysis
- Getting current configuration files

#### `ftp_batch_upload`
Upload multiple files at once in a single operation. Much faster than uploading files one by one.

**Parameters:**
- `files`: Array of objects with `localPath` and `remotePath`

**Example:**
```json
{
  "files": [
    {"localPath": "./dist/index.html", "remotePath": "/public_html/index.html"},
    {"localPath": "./dist/styles.css", "remotePath": "/public_html/styles.css"},
    {"localPath": "./dist/app.js", "remotePath": "/public_html/app.js"}
  ]
}
```

**Example use cases:**
- "Upload all files from my dist folder"
- "Batch upload these 10 images"
- Deploying multiple files at once
- Uploading build artifacts
- Mass file migrations

#### `ftp_batch_download`
Download multiple files at once in a single operation.

**Parameters:**
- `files`: Array of objects with `remotePath` and `localPath`

**Example use cases:**
- "Download all config files from the server"
- "Get all log files from /logs"
- Backing up multiple files
- Downloading project files
- Retrieving related files together

#### `ftp_sync`
Smart synchronization between local and remote directories. Only transfers files that have changed based on modification time. Incredibly efficient for deploying updates.

**Parameters:**
- `localPath`: Local directory path
- `remotePath`: Remote directory path
- `direction` (optional): "upload", "download", or "both" (defaults to "upload")

**Example use cases:**
- "Sync my local dist folder to /public_html"
- "Upload only changed files to the server"
- "Download updates from the server"
- Efficient deployments
- Incremental backups
- Two-way synchronization

---

### File Management

#### `ftp_delete`
Delete a file from the remote server.

**Parameters:**
- `path`: Remote file path to delete

**Example use cases:**
- "Delete old-backup.sql from the server"
- "Remove temp-file.txt"
- Cleaning up old files
- Removing temporary files
- Deleting outdated backups

#### `ftp_copy` *(SFTP only)*
Duplicate a file on the server without downloading/re-uploading. Creates backups or copies efficiently.

**Parameters:**
- `sourcePath`: Source file path
- `destPath`: Destination file path

**Example use cases:**
- "Copy config.php to config.backup.php"
- "Duplicate index.html to index.old.html"
- Creating backups before editing
- Duplicating templates
- Versioning files on server

#### `ftp_rename`
Rename or move a file on the remote server.

**Parameters:**
- `oldPath`: Current file path
- `newPath`: New file path

**Example use cases:**
- "Rename old.txt to new.txt"
- "Move file.php from /temp to /public_html"
- Organizing files
- Renaming for clarity
- Moving files between directories

#### `ftp_chmod` *(SFTP only)*
Change file permissions on the remote server using octal notation.

**Parameters:**
- `path`: Remote file path
- `mode`: Permission mode in octal (e.g., "755", "644", "777")

**Common modes:**
- `644` - Files: Owner read/write, others read only
- `755` - Directories/Scripts: Owner all, others read/execute
- `600` - Private files: Owner read/write only
- `777` - Full permissions (use with caution)

**Example use cases:**
- "Set permissions on script.sh to 755"
- "Make upload.php executable"
- "Change config.php to 600 for security"
- Securing configuration files
- Making scripts executable
- Fixing permission issues

---

## Real-World Usage Scenarios

### Deploying a Website
```
"Sync my local dist folder to /public_html"
"Check if index.html exists on the server"
"Get file stats for all PHP files"
```

### Managing Configuration
```
"Read the contents of config.php"
"Copy config.php to config.backup.php"
"Update config.php with new database credentials"
```

### File Maintenance
```
"Find all .log files on the server"
"Delete all files matching temp-*"
"Create a backups directory"
"Set permissions on uploads folder to 755"
```

### Monitoring & Auditing
```
"Show me the complete file tree"
"Check disk space on the server"
"When was .htaccess last modified?"
"List all files in uploads larger than 1MB"
```

## Development

Clone and install locally:

```bash
git clone https://github.com/Kynlos/ftp-mcp.git
cd ftp-mcp
npm install
```

## Protocol Detection

ftp-mcp automatically detects the protocol based on your hostname:
- `ftp.example.com` → Uses FTP on port 21
- `sftp://example.com` → Uses SFTP on port 22
- Custom ports can be specified via `FTPMCP_PORT` or in `.ftpconfig`

## Git-Aware File Filtering

ftp-mcp automatically ignores files that shouldn't be deployed to production:

### Default Ignore Patterns
Always ignored by default:
- `node_modules/`
- `.git/`
- `.env` and `.env.*`
- `*.log` files
- `.DS_Store`, `Thumbs.db`
- IDE folders (`.vscode/`, `.idea/`)
- Temporary files (`*.swp`, `*~`)
- `.ftpconfig`
- Cache and coverage directories

### .gitignore Support
ftp-mcp automatically reads and respects your `.gitignore` file. Any patterns you've added to `.gitignore` will be honored during sync operations.

### .ftpignore Support
Create a `.ftpignore` file in your project root for FTP-specific ignore patterns:

```
# .ftpignore example
*.md
docs/**
tests/**
*.test.js
```

**Priority Order:**
1. Default patterns (always applied)
2. `.gitignore` patterns (if file exists)
3. `.ftpignore` patterns (if file exists)

**Example sync output:**
```
Sync complete:
Uploaded: 15
Downloaded: 0
Skipped: 3
Ignored: 47  ← Files filtered by ignore patterns
```

## Security Notes

- Never commit `.ftpconfig` files containing passwords to version control
- Use environment variables for CI/CD pipelines
- Consider using SSH keys with SFTP for enhanced security
- Set restrictive permissions (600/644) on sensitive files
- The `.ftpconfig` file is included in `.gitignore` by default
- Sensitive files like `.env` are automatically ignored during sync

## License

[MIT](LICENSE)

---

**Author:** [Kynlo Akari](https://github.com/Kynlos/)
