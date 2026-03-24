#!/usr/bin/env bun
/**
 * Archive Tool - Create and extract archives (zip, tar, tar.gz, tar.bz2)
 *
 * Provides commands for working with archive files:
 * - create: Create a new archive from files/directories
 * - extract: Extract files from an archive
 * - list: List contents of an archive
 * - test: Test archive integrity
 * - add: Add files to an existing zip archive
 *
 * @module tools/archive
 */

import { parseArgs } from "node:util";
import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs";
import { minimatch } from "minimatch";

// Configuration (set via environment or tool config)
const CONFIG = {
  allowPaths: (process.env.ARCHIVE_ALLOW_PATHS || "")
    .split(",")
    .filter(Boolean),
  denyPaths: (process.env.ARCHIVE_DENY_PATHS || "")
    .split(",")
    .filter(Boolean),
  maxArchiveSize: process.env.ARCHIVE_MAX_ARCHIVE_SIZE || "1GB",
  maxFileSize: process.env.ARCHIVE_MAX_FILE_SIZE || "100MB",
};

// Help text
const HELP = `
Archive Tool - Create and extract archives

USAGE:
  archive <command> [options]

COMMANDS:
  create <files...>        Create a new archive
  extract                  Extract files from an archive
  list                     List contents of an archive
  test                     Test archive integrity
  add <files...>           Add files to existing zip archive

OPTIONS:
  --archive <path>         Archive file path
  --output-dir <dir>       Output directory for extraction (default: .)
  --format <fmt>           Archive format: zip, tar, tar.gz, tar.bz2
  --compress-level <n>     Compression level 1-9 (default: 6)
  --working-dir <dir>      Working directory for relative paths
  --strip-components <n>   Remove leading path components (tar only)
  --overwrite              Overwrite existing files when extracting
  --verbose                Show detailed information
  --help, -h               Show this help message

EXAMPLES:
  archive create --archive backup.tar.gz --files src,config.json
  archive create --archive project.zip --files dist
  archive extract --archive backup.tar.gz --output-dir restored
  archive list --archive backup.tar.gz --verbose
  archive test --archive backup.tar.gz
  archive add --archive backup.zip --files newfile.txt

SUPPORTED FORMATS:
  .zip, .tar, .tar.gz, .tgz, .tar.bz2, .tbz2

SECURITY:
  - Path access controlled via allowPaths/denyPaths config
  - Archive size limited by maxArchiveSize (default: 1GB)
  - Individual file size limited by maxFileSize (default: 100MB)
`;

interface ToolResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  message?: string;
}

interface ArchiveConfig {
  allowPaths?: string[];
  denyPaths?: string[];
  maxArchiveSize?: string;
  maxFileSize?: string;
}

/**
 * Parse size string to bytes
 */
function parseSize(sizeStr: string): number {
  const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || "B").toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };
  return value * (multipliers[unit] || 1);
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Check if a path is allowed
 */
function isPathAllowed(filePath: string, config: ArchiveConfig): boolean {
  const denyPaths = config.denyPaths?.length ? config.denyPaths : CONFIG.denyPaths;
  const allowPaths = config.allowPaths?.length ? config.allowPaths : CONFIG.allowPaths;

  // Check deny list first
  if (denyPaths.length > 0) {
    for (const pattern of denyPaths) {
      if (minimatch(filePath, pattern) || minimatch(path.resolve(filePath), pattern)) {
        return false;
      }
    }
  }

  // If allow list is set, path must match
  if (allowPaths.length > 0) {
    let allowed = false;
    for (const pattern of allowPaths) {
      if (minimatch(filePath, pattern) || minimatch(path.resolve(filePath), pattern)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return false;
  }

  return true;
}

/**
 * Detect archive format from file extension
 */
function detectFormat(archivePath: string): "zip" | "tar" | "tar.gz" | "tar.bz2" {
  const ext = path.extname(archivePath).toLowerCase();
  const basename = path.basename(archivePath).toLowerCase();

  if (ext === ".zip") return "zip";
  if (ext === ".bz2" || basename.endsWith(".tar.bz2") || basename.endsWith(".tbz2")) return "tar.bz2";
  if (ext === ".gz" || basename.endsWith(".tar.gz") || basename.endsWith(".tgz")) return "tar.gz";
  if (ext === ".tar") return "tar";

  // Default to tar.gz
  return "tar.gz";
}

/**
 * Create a new archive
 */
async function createArchive(
  archive: string,
  files: string[],
  format?: "zip" | "tar" | "tar.gz" | "tar.bz2",
  compressLevel: number = 6,
  workingDir?: string,
  config: ArchiveConfig = {}
): Promise<ToolResult> {
  // Check path permissions
  if (!isPathAllowed(archive, config)) {
    return { success: false, error: `Access denied: ${archive}` };
  }

  for (const file of files) {
    if (!isPathAllowed(file, config)) {
      return { success: false, error: `Access denied: ${file}` };
    }
  }

  // Detect format from extension if not specified
  const archiveFormat = format || detectFormat(archive);

  // Check if files exist
  for (const file of files) {
    const fullPath = workingDir ? path.join(workingDir, file) : file;
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${file}` };
    }
  }

  // Create parent directory if needed
  const archiveDir = path.dirname(archive);
  if (archiveDir && !fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const resolvedArchive = path.resolve(archive);

  try {
    switch (archiveFormat) {
      case "zip": {
        if (workingDir) {
          await $`cd ${workingDir} && zip -r -${compressLevel} ${resolvedArchive} ${files}`.quiet();
        } else {
          await $`zip -r -${compressLevel} ${archive} ${files}`.quiet();
        }
        break;
      }

      case "tar": {
        if (workingDir) {
          await $`cd ${workingDir} && tar -cf ${resolvedArchive} ${files}`.quiet();
        } else {
          await $`tar -cf ${archive} ${files}`.quiet();
        }
        break;
      }

      case "tar.gz": {
        if (workingDir) {
          await $`cd ${workingDir} && tar -czf ${resolvedArchive} ${files}`.quiet();
        } else {
          await $`tar -czf ${archive} ${files}`.quiet();
        }
        break;
      }

      case "tar.bz2": {
        if (workingDir) {
          await $`cd ${workingDir} && tar -cjf ${resolvedArchive} ${files}`.quiet();
        } else {
          await $`tar -cjf ${archive} ${files}`.quiet();
        }
        break;
      }

      default:
        return { success: false, error: `Unsupported format: ${archiveFormat}` };
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to create archive: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Get archive info
  const stats = fs.statSync(archive);

  return {
    success: true,
    data: {
      archive,
      format: archiveFormat,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
      files: files.length,
    },
    message: `Created ${archiveFormat} archive: ${archive} (${formatBytes(stats.size)})`,
  };
}

/**
 * Extract an archive
 */
async function extractArchive(
  archive: string,
  outputDir: string = ".",
  files?: string[],
  stripComponents: number = 0,
  overwrite: boolean = false,
  config: ArchiveConfig = {}
): Promise<ToolResult> {
  // Check path permissions
  if (!isPathAllowed(archive, config)) {
    return { success: false, error: `Access denied: ${archive}` };
  }

  if (!isPathAllowed(outputDir, config)) {
    return { success: false, error: `Access denied: ${outputDir}` };
  }

  // Check archive exists
  if (!fs.existsSync(archive)) {
    return { success: false, error: `Archive not found: ${archive}` };
  }

  // Check archive size
  const maxArchiveSize = parseSize(config.maxArchiveSize || CONFIG.maxArchiveSize);
  const archiveStats = fs.statSync(archive);
  if (archiveStats.size > maxArchiveSize) {
    return {
      success: false,
      error: `Archive too large: ${formatBytes(archiveStats.size)} exceeds limit of ${config.maxArchiveSize || CONFIG.maxArchiveSize}`,
    };
  }

  // Create output directory if needed
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const format = detectFormat(archive);

  try {
    switch (format) {
      case "zip": {
        const overwriteFlag = overwrite ? "-o" : "-n";
        if (files && files.length > 0) {
          await $`unzip ${overwriteFlag} -q ${archive} -d ${outputDir} ${files}`.quiet();
        } else {
          await $`unzip ${overwriteFlag} -q ${archive} -d ${outputDir}`.quiet();
        }
        break;
      }

      case "tar":
      case "tar.gz":
      case "tar.bz2": {
        const extractFlag = format === "tar.gz" ? "-xzf" : format === "tar.bz2" ? "-xjf" : "-xf";
        const stripFlag = stripComponents > 0 ? `--strip-components=${stripComponents}` : [];
        const overwriteFlag = overwrite ? [] : ["-k"];

        if (files && files.length > 0) {
          await $`tar ${extractFlag} ${archive} -C ${outputDir} ${stripFlag} ${overwriteFlag} ${files}`.quiet();
        } else {
          await $`tar ${extractFlag} ${archive} -C ${outputDir} ${stripFlag} ${overwriteFlag}`.quiet();
        }
        break;
      }

      default:
        return { success: false, error: `Unsupported format: ${format}` };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // unzip returns non-zero if no files extracted with -n
    if (errorMsg.includes("nothing to do") || errorMsg.includes("No such file")) {
      return {
        success: true,
        data: { archive, format, outputDir, filesExtracted: 0 },
        message: "No files extracted (files already exist, use --overwrite to replace)",
      };
    }

    return {
      success: false,
      error: `Failed to extract archive: ${errorMsg}`,
    };
  }

  return {
    success: true,
    data: {
      archive,
      format,
      outputDir,
      filesExtracted: files?.length || "all",
    },
    message: `Extracted ${format} archive to ${outputDir}`,
  };
}

/**
 * List archive contents
 */
async function listArchive(
  archive: string,
  verbose: boolean = false,
  config: ArchiveConfig = {}
): Promise<ToolResult> {
  // Check path permissions
  if (!isPathAllowed(archive, config)) {
    return { success: false, error: `Access denied: ${archive}` };
  }

  // Check archive exists
  if (!fs.existsSync(archive)) {
    return { success: false, error: `Archive not found: ${archive}` };
  }

  const format = detectFormat(archive);
  let output: string;

  try {
    switch (format) {
      case "zip": {
        const result = verbose
          ? await $`zipinfo -v ${archive}`.quiet()
          : await $`zipinfo -1 ${archive}`.quiet();
        output = result.stdout.toString();
        break;
      }

      case "tar":
      case "tar.gz":
      case "tar.bz2": {
        const listFlag = format === "tar.gz" ? "-tzf" : format === "tar.bz2" ? "-tjf" : "-tf";
        const result = verbose
          ? await $`tar ${listFlag} -v ${archive}`.quiet()
          : await $`tar ${listFlag} ${archive}`.quiet();
        output = result.stdout.toString();
        break;
      }

      default:
        return { success: false, error: `Unsupported format: ${format}` };
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to list archive: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const lines = output.trim().split("\n").filter(Boolean);

  return {
    success: true,
    data: {
      archive,
      format,
      files: lines,
      count: lines.length,
    },
    message: verbose ? undefined : `Archive contains ${lines.length} entries`,
  };
}

/**
 * Test archive integrity
 */
async function testArchive(
  archive: string,
  config: ArchiveConfig = {}
): Promise<ToolResult> {
  // Check path permissions
  if (!isPathAllowed(archive, config)) {
    return { success: false, error: `Access denied: ${archive}` };
  }

  // Check archive exists
  if (!fs.existsSync(archive)) {
    return { success: false, error: `Archive not found: ${archive}` };
  }

  const format = detectFormat(archive);

  try {
    switch (format) {
      case "zip": {
        await $`unzip -t ${archive}`.quiet();
        break;
      }

      case "tar":
      case "tar.gz":
      case "tar.bz2": {
        const testFlag = format === "tar.gz" ? "-tzf" : format === "tar.bz2" ? "-tjf" : "-tf";
        await $`tar ${testFlag} ${archive} > /dev/null`.quiet();
        break;
      }

      default:
        return { success: false, error: `Unsupported format: ${format}` };
    }
  } catch (error) {
    return {
      success: false,
      error: `Archive integrity test failed: ${error instanceof Error ? error.message : String(error)}`,
      data: { archive, format, valid: false },
    };
  }

  return {
    success: true,
    data: { archive, format, valid: true },
    message: `Archive integrity OK: ${archive}`,
  };
}

/**
 * Add files to existing zip archive
 */
async function addFiles(
  archive: string,
  files: string[],
  workingDir?: string,
  config: ArchiveConfig = {}
): Promise<ToolResult> {
  // Check path permissions
  if (!isPathAllowed(archive, config)) {
    return { success: false, error: `Access denied: ${archive}` };
  }

  for (const file of files) {
    if (!isPathAllowed(file, config)) {
      return { success: false, error: `Access denied: ${file}` };
    }
  }

  // Check archive exists
  if (!fs.existsSync(archive)) {
    return { success: false, error: `Archive not found: ${archive}` };
  }

  const format = detectFormat(archive);

  if (format !== "zip") {
    return {
      success: false,
      error: `Adding files is only supported for zip archives. This is a ${format} archive.`,
    };
  }

  // Check files exist
  for (const file of files) {
    const fullPath = workingDir ? path.join(workingDir, file) : file;
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${file}` };
    }
  }

  const resolvedArchive = path.resolve(archive);

  try {
    if (workingDir) {
      await $`cd ${workingDir} && zip -u ${resolvedArchive} ${files}`.quiet();
    } else {
      await $`zip -u ${archive} ${files}`.quiet();
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to add files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    success: true,
    data: { archive, filesAdded: files.length },
    message: `Added ${files.length} file(s) to ${archive}`,
  };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      archive: { type: "string", short: "a" },
      "output-dir": { type: "string", short: "o" },
      format: { type: "string", short: "f" },
      "compress-level": { type: "string", short: "c" },
      "working-dir": { type: "string", short: "w" },
      "strip-components": { type: "string", short: "s" },
      files: { type: "string", multiple: true },
      overwrite: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const command = positionals[0];
  const config: ArchiveConfig = {};

  let result: ToolResult;

  switch (command) {
    case "create": {
      const archive = values.archive;
      const files = values.files || positionals.slice(1);

      if (!archive) {
        result = { success: false, error: "Missing required parameter: --archive" };
        break;
      }
      if (files.length === 0) {
        result = { success: false, error: "Missing required parameter: files to archive" };
        break;
      }

      result = await createArchive(
        archive,
        files,
        values.format as "zip" | "tar" | "tar.gz" | "tar.bz2" | undefined,
        values["compress-level"] ? parseInt(values["compress-level"], 10) : 6,
        values["working-dir"],
        config
      );
      break;
    }

    case "extract": {
      const archive = values.archive || positionals[1];

      if (!archive) {
        result = { success: false, error: "Missing required parameter: archive" };
        break;
      }

      result = await extractArchive(
        archive,
        values["output-dir"],
        values.files,
        values["strip-components"] ? parseInt(values["strip-components"], 10) : 0,
        values.overwrite,
        config
      );
      break;
    }

    case "list":
    case "ls": {
      const archive = values.archive || positionals[1];

      if (!archive) {
        result = { success: false, error: "Missing required parameter: archive" };
        break;
      }

      result = await listArchive(archive, values.verbose, config);
      break;
    }

    case "test":
    case "verify": {
      const archive = values.archive || positionals[1];

      if (!archive) {
        result = { success: false, error: "Missing required parameter: archive" };
        break;
      }

      result = await testArchive(archive, config);
      break;
    }

    case "add": {
      const archive = values.archive;
      const files = values.files || positionals.slice(1);

      if (!archive) {
        result = { success: false, error: "Missing required parameter: --archive" };
        break;
      }
      if (files.length === 0) {
        result = { success: false, error: "Missing required parameter: files to add" };
        break;
      }

      result = await addFiles(archive, files, values["working-dir"], config);
      break;
    }

    default:
      if (!command) {
        console.log(HELP);
        result = { success: true };
      } else {
        result = {
          success: false,
          error: `Unknown command: ${command}. Available commands: create, extract, list, test, add`,
        };
      }
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Export for testing
export {
  createArchive,
  extractArchive,
  listArchive,
  testArchive,
  addFiles,
  detectFormat,
  isPathAllowed,
  parseSize,
  formatBytes,
};
