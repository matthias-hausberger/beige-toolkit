#!/usr/bin/env node
/**
 * Image Manipulation Tool
 * Provides image operations using ImageMagick
 */

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { access, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve, basename, extname } from "node:path";
import { createHash } from "node:crypto";

// Configuration
interface ImageConfig {
  maxFileSize: number;
  allowedFormats: string[];
  outputFormats: string[];
  pathAllowList: string[];
  pathDenyList: string[];
  defaultQuality: number;
  maxWidth: number;
  maxHeight: number;
}

const config: ImageConfig = {
  maxFileSize: parseInt(process.env.IMAGE_MAX_FILE_SIZE || "52428800", 10),
  allowedFormats: (process.env.IMAGE_ALLOWED_FORMATS || "png,jpg,jpeg,gif,webp,bmp,tiff,svg").split(","),
  outputFormats: (process.env.IMAGE_OUTPUT_FORMATS || "png,jpg,jpeg,gif,webp,bmp,tiff").split(","),
  pathAllowList: process.env.IMAGE_PATH_ALLOW_LIST?.split(",").filter(Boolean) || [],
  pathDenyList: process.env.IMAGE_PATH_DENY_LIST?.split(",").filter(Boolean) || [],
  defaultQuality: parseInt(process.env.IMAGE_DEFAULT_QUALITY || "85", 10),
  maxWidth: parseInt(process.env.IMAGE_MAX_WIDTH || "10000", 10),
  maxHeight: parseInt(process.env.IMAGE_MAX_HEIGHT || "10000", 10),
};

// Types
interface ImageInfo {
  format: string;
  width: number;
  height: number;
  depth: number;
  colors: number;
  fileSize: number;
  transparent: boolean;
  animated: boolean;
}

interface ResizeOptions {
  width?: number;
  height?: number;
  maintainAspect: boolean;
  upscale: boolean;
}

interface CropOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  gravity?: string;
}

interface RotateOptions {
  angle: number;
  background?: string;
}

// Utility functions
function error(message: string, code: number = 1): never {
  console.error(JSON.stringify({ error: message, code }));
  process.exit(code);
}

function output(data: object): void {
  console.log(JSON.stringify(data, null, 2));
}

function isPathAllowed(path: string): boolean {
  const resolved = resolve(path);
  
  // Check deny list first
  for (const denied of config.pathDenyList) {
    if (resolved.startsWith(resolve(denied))) {
      return false;
    }
  }
  
  // If allow list is empty, allow all (except denied)
  if (config.pathAllowList.length === 0) {
    return true;
  }
  
  // Check allow list
  for (const allowed of config.pathAllowList) {
    if (resolved.startsWith(resolve(allowed))) {
      return true;
    }
  }
  
  return false;
}

function getFormatFromPath(path: string): string {
  const ext = extname(path).toLowerCase().slice(1);
  return ext === "jpeg" ? "jpg" : ext;
}

function isValidInputFormat(format: string): boolean {
  return config.allowedFormats.includes(format.toLowerCase());
}

function isValidOutputFormat(format: string): boolean {
  return config.outputFormats.includes(format.toLowerCase());
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getFileSize(path: string): Promise<number> {
  const stats = await stat(path);
  return stats.size;
}

// ImageMagick execution
async function execImageMagick(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("convert", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `ImageMagick exited with code ${code}`));
      }
    });
    
    proc.on("error", (err) => {
      reject(new Error(`Failed to run ImageMagick: ${err.message}`));
    });
  });
}

// Check if ImageMagick is available
async function checkImageMagick(): Promise<boolean> {
  try {
    await execImageMagick(["--version"]);
    return true;
  } catch {
    return false;
  }
}

// Commands

async function cmdInfo(inputPath: string): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath)) {
    error(`Access denied: ${inputPath}`);
  }
  
  const inputFormat = getFormatFromPath(inputPath);
  if (!isValidInputFormat(inputFormat)) {
    error(`Invalid input format: ${inputFormat}`);
  }
  
  const fileSize = await getFileSize(inputPath);
  if (fileSize > config.maxFileSize) {
    error(`File too large: ${fileSize} bytes (max: ${config.maxFileSize})`);
  }
  
  try {
    const { stdout } = await execImageMagick([
      inputPath,
      "-print",
      JSON.stringify({
        format: "%m",
        width: "%w",
        height: "%h",
        depth: "%[depth]",
        colors: "%k",
        transparent: "%[opaque]",
      }),
      "info:",
    ]);
    
    // Parse the JSON-like output
    const parsed = stdout.trim();
    
    // Alternative: use identify command for cleaner output
    const { stdout: identifyOut } = await execImageMagick([
      "identify",
      "-format",
      "%m %w %h %[depth] %k %t",
      inputPath,
    ]);
    
    const parts = identifyOut.trim().split(" ");
    const info: ImageInfo = {
      format: parts[0] || "unknown",
      width: parseInt(parts[1], 10) || 0,
      height: parseInt(parts[2], 10) || 0,
      depth: parseInt(parts[3], 10) || 8,
      colors: parseInt(parts[4], 10) || 0,
      fileSize,
      transparent: false,
      animated: parts[0]?.toLowerCase() === "gif",
    };
    
    output({
      success: true,
      info,
      path: inputPath,
    });
  } catch (err) {
    error(`Failed to get image info: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdResize(
  inputPath: string,
  outputPath: string,
  options: Partial<ResizeOptions>
): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const inputFormat = getFormatFromPath(inputPath);
  const outputFormat = getFormatFromPath(outputPath);
  
  if (!isValidInputFormat(inputFormat)) {
    error(`Invalid input format: ${inputFormat}`);
  }
  
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const width = options.width || config.maxWidth;
  const height = options.height || config.maxHeight;
  
  if (width > config.maxWidth || height > config.maxHeight) {
    error(`Dimensions exceed maximum: ${width}x${height} (max: ${config.maxWidth}x${config.maxHeight})`);
  }
  
  const args: string[] = [inputPath];
  
  // Build resize argument
  let resizeArg = "";
  if (options.width && options.height) {
    resizeArg = options.maintainAspect !== false 
      ? `${width}x${height}` 
      : `${width}x${height}!`;
  } else if (options.width) {
    resizeArg = `${width}x`;
  } else if (options.height) {
    resizeArg = `x${height}`;
  }
  
  if (!options.upscale) {
    resizeArg += ">";
  }
  
  args.push("-resize", resizeArg);
  
  // Quality for lossy formats
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    
    const outputSize = await getFileSize(outputPath);
    
    output({
      success: true,
      input: inputPath,
      output: outputPath,
      dimensions: { width, height },
      outputSize,
    });
  } catch (err) {
    error(`Resize failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdCrop(
  inputPath: string,
  outputPath: string,
  options: CropOptions
): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const { x, y, width, height, gravity } = options;
  
  const args: string[] = [inputPath];
  
  if (gravity) {
    args.push("-gravity", gravity);
  }
  
  args.push("-crop", `${width}x${height}+${x}+${y}`);
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    
    const outputSize = await getFileSize(outputPath);
    
    output({
      success: true,
      input: inputPath,
      output: outputPath,
      crop: { x, y, width, height, gravity },
      outputSize,
    });
  } catch (err) {
    error(`Crop failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdConvert(
  inputPath: string,
  outputPath: string,
  quality?: number
): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const inputFormat = getFormatFromPath(inputPath);
  const outputFormat = getFormatFromPath(outputPath);
  
  if (!isValidInputFormat(inputFormat)) {
    error(`Invalid input format: ${inputFormat}`);
  }
  
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const args: string[] = [inputPath];
  
  const q = quality || config.defaultQuality;
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(q));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    
    const inputSize = await getFileSize(inputPath);
    const outputSize = await getFileSize(outputPath);
    
    output({
      success: true,
      input: inputPath,
      output: outputPath,
      inputFormat,
      outputFormat,
      inputSize,
      outputSize,
      compressionRatio: inputSize / outputSize,
    });
  } catch (err) {
    error(`Convert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdRotate(
  inputPath: string,
  outputPath: string,
  options: RotateOptions
): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const args: string[] = [inputPath];
  
  if (options.background) {
    args.push("-background", options.background);
  }
  
  args.push("-rotate", String(options.angle));
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    
    const outputSize = await getFileSize(outputPath);
    
    output({
      success: true,
      input: inputPath,
      output: outputPath,
      angle: options.angle,
      outputSize,
    });
  } catch (err) {
    error(`Rotate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdFlip(inputPath: string, outputPath: string): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const args: string[] = [inputPath, "-flip"];
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    output({ success: true, input: inputPath, output: outputPath, operation: "flip" });
  } catch (err) {
    error(`Flip failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdFlop(inputPath: string, outputPath: string): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const args: string[] = [inputPath, "-flop"];
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    output({ success: true, input: inputPath, output: outputPath, operation: "flop" });
  } catch (err) {
    error(`Flop failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdThumbnail(
  inputPath: string,
  outputPath: string,
  width: number,
  height?: number
): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const h = height || width;
  const args: string[] = [inputPath, "-thumbnail", `${width}x${h}`];
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    const outputSize = await getFileSize(outputPath);
    
    output({
      success: true,
      input: inputPath,
      output: outputPath,
      thumbnail: { width, height: h },
      outputSize,
    });
  } catch (err) {
    error(`Thumbnail failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdOptimize(
  inputPath: string,
  outputPath: string,
  quality?: number
): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const q = quality || config.defaultQuality;
  
  const args: string[] = [
    inputPath,
    "-strip",  // Remove metadata
    "-interlace", "Plane",  // Progressive loading
    "-quality", String(q),
    outputPath,
  ];
  
  try {
    await execImageMagick(args);
    
    const inputSize = await getFileSize(inputPath);
    const outputSize = await getFileSize(outputPath);
    const savings = ((1 - outputSize / inputSize) * 100).toFixed(1);
    
    output({
      success: true,
      input: inputPath,
      output: outputPath,
      inputSize,
      outputSize,
      savings: `${savings}%`,
      quality: q,
    });
  } catch (err) {
    error(`Optimize failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdWatermark(
  inputPath: string,
  watermarkPath: string,
  outputPath: string,
  gravity: string = "southeast"
): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!await fileExists(watermarkPath)) {
    error(`Watermark file not found: ${watermarkPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(watermarkPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const args: string[] = [
    inputPath,
    "-gravity", gravity,
    "-composite",
    watermarkPath,
    "-composite",
  ];
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    
    output({
      success: true,
      input: inputPath,
      watermark: watermarkPath,
      output: outputPath,
      gravity,
    });
  } catch (err) {
    error(`Watermark failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdBlur(
  inputPath: string,
  outputPath: string,
  radius: number = 5,
  sigma?: number
): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const s = sigma || radius;
  const args: string[] = [inputPath, "-blur", `${radius}x${s}`];
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    output({
      success: true,
      input: inputPath,
      output: outputPath,
      blur: { radius, sigma: s },
    });
  } catch (err) {
    error(`Blur failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdSharpen(
  inputPath: string,
  outputPath: string,
  radius: number = 2,
  sigma?: number
): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const s = sigma || radius;
  const args: string[] = [inputPath, "-sharpen", `${radius}x${s}`];
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    output({
      success: true,
      input: inputPath,
      output: outputPath,
      sharpen: { radius, sigma: s },
    });
  } catch (err) {
    error(`Sharpen failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdGrayscale(inputPath: string, outputPath: string): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const args: string[] = [inputPath, "-colorspace", "Gray"];
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    output({ success: true, input: inputPath, output: outputPath, operation: "grayscale" });
  } catch (err) {
    error(`Grayscale failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdSepia(inputPath: string, outputPath: string, threshold: number = 80): Promise<void> {
  if (!await fileExists(inputPath)) {
    error(`Input file not found: ${inputPath}`);
  }
  
  if (!isPathAllowed(inputPath) || !isPathAllowed(outputPath)) {
    error(`Access denied`);
  }
  
  const outputFormat = getFormatFromPath(outputPath);
  if (!isValidOutputFormat(outputFormat)) {
    error(`Invalid output format: ${outputFormat}`);
  }
  
  const args: string[] = [inputPath, "-sepia-tone", `${threshold}%`];
  
  if (["jpg", "jpeg", "webp"].includes(outputFormat)) {
    args.push("-quality", String(config.defaultQuality));
  }
  
  args.push(outputPath);
  
  try {
    await execImageMagick(args);
    output({
      success: true,
      input: inputPath,
      output: outputPath,
      operation: "sepia",
      threshold,
    });
  } catch (err) {
    error(`Sepia failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Main CLI
async function main() {
  const { positionals, values } = parseArgs({
    options: {
      width: { type: "string", short: "w" },
      height: { type: "string", short: "h" },
      quality: { type: "string", short: "q" },
      x: { type: "string" },
      y: { type: "string" },
      angle: { type: "string", short: "a" },
      gravity: { type: "string", short: "g" },
      radius: { type: "string", short: "r" },
      sigma: { type: "string", short: "s" },
      background: { type: "string", short: "b" },
      threshold: { type: "string", short: "t" },
      "maintain-aspect": { type: "boolean", default: true },
      upscale: { type: "boolean", default: false },
      help: { type: "boolean", short: "?" },
    },
    allowPositionals: true,
    strict: false,
  });
  
  const [command, ...args] = positionals;
  
  if (values.help || !command) {
    console.log(`
Image Manipulation Tool

Commands:
  resize <input> <output> [--width W] [--height H]  Resize image
  crop <input> <output> --x X --y Y --width W --height H  Crop image
  convert <input> <output> [--quality Q]  Convert between formats
  rotate <input> <output> --angle A  Rotate image
  flip <input> <output>  Flip vertically
  flop <input> <output>  Flip horizontally
  thumbnail <input> <output> --width W  Create thumbnail
  optimize <input> <output> [--quality Q]  Optimize for web
  watermark <input> <watermark> <output>  Add watermark
  blur <input> <output> [--radius R]  Blur image
  sharpen <input> <output> [--radius R]  Sharpen image
  grayscale <input> <output>  Convert to grayscale
  sepia <input> <output> [--threshold T]  Apply sepia tone
  info <input>  Get image information

Options:
  --width, -w     Width in pixels
  --height, -h    Height in pixels
  --quality, -q   Quality (1-100) for lossy formats
  --x, --y        Offset for crop
  --angle, -a     Rotation angle in degrees
  --gravity, -g   Position (North, South, East, West, Center, etc.)
  --radius, -r    Blur/sharpen radius
  --sigma, -s     Blur/sharpen sigma
  --background, -b  Background color for rotation
  --threshold, -t  Sepia threshold (0-100)
  --maintain-aspect  Maintain aspect ratio (default: true)
  --upscale       Allow upscaling (default: false)
  --help, -?      Show this help

Environment Variables:
  IMAGE_MAX_FILE_SIZE     Maximum file size (default: 52428800)
  IMAGE_ALLOWED_FORMATS   Allowed input formats (default: png,jpg,jpeg,gif,webp,bmp,tiff,svg)
  IMAGE_OUTPUT_FORMATS    Allowed output formats (default: png,jpg,jpeg,gif,webp,bmp,tiff)
  IMAGE_PATH_ALLOW_LIST   Allowed paths
  IMAGE_PATH_DENY_LIST    Denied paths
  IMAGE_DEFAULT_QUALITY   Default quality (default: 85)
  IMAGE_MAX_WIDTH         Maximum width (default: 10000)
  IMAGE_MAX_HEIGHT        Maximum height (default: 10000)
`);
    process.exit(0);
  }
  
  // Check ImageMagick availability
  if (!await checkImageMagick()) {
    error("ImageMagick is not installed or not available in PATH. Install with: apt-get install imagemagick");
  }
  
  // Parse numeric options
  const width = values.width ? parseInt(values.width, 10) : undefined;
  const height = values.height ? parseInt(values.height, 10) : undefined;
  const quality = values.quality ? parseInt(values.quality, 10) : undefined;
  const x = values.x ? parseInt(values.x, 10) : 0;
  const y = values.y ? parseInt(values.y, 10) : 0;
  const angle = values.angle ? parseFloat(values.angle) : 0;
  const radius = values.radius ? parseInt(values.radius, 10) : undefined;
  const sigma = values.sigma ? parseInt(values.sigma, 10) : undefined;
  const threshold = values.threshold ? parseInt(values.threshold, 10) : 80;
  
  switch (command) {
    case "info":
      await cmdInfo(args[0]);
      break;
      
    case "resize":
      await cmdResize(args[0], args[1], {
        width,
        height,
        maintainAspect: values["maintain-aspect"],
        upscale: values.upscale,
      });
      break;
      
    case "crop":
      if (!width || !height) {
        error("crop requires --width and --height");
      }
      await cmdCrop(args[0], args[1], { x, y, width, height, gravity: values.gravity });
      break;
      
    case "convert":
      await cmdConvert(args[0], args[1], quality);
      break;
      
    case "rotate":
      await cmdRotate(args[0], args[1], { angle, background: values.background });
      break;
      
    case "flip":
      await cmdFlip(args[0], args[1]);
      break;
      
    case "flop":
      await cmdFlop(args[0], args[1]);
      break;
      
    case "thumbnail":
      if (!width) {
        error("thumbnail requires --width");
      }
      await cmdThumbnail(args[0], args[1], width, height);
      break;
      
    case "optimize":
      await cmdOptimize(args[0], args[1], quality);
      break;
      
    case "watermark":
      await cmdWatermark(args[0], args[1], args[2], values.gravity);
      break;
      
    case "blur":
      await cmdBlur(args[0], args[1], radius || 5, sigma);
      break;
      
    case "sharpen":
      await cmdSharpen(args[0], args[1], radius || 2, sigma);
      break;
      
    case "grayscale":
      await cmdGrayscale(args[0], args[1]);
      break;
      
    case "sepia":
      await cmdSepia(args[0], args[1], threshold);
      break;
      
    default:
      error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  error(`Unexpected error: ${err.message}`);
});
