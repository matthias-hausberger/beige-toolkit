#!/usr/bin/env bun
/**
 * QR Code Generator Tool for Beige Toolkit
 *
 * Generates QR codes in multiple formats: ASCII art, terminal blocks, SVG, and PNG.
 * Pure TypeScript implementation with no native dependencies.
 *
 * @example
 *   qrcode --text "https://example.com"
 *   qrcode --text "Hello World" --format ascii
 *   qrcode --text "https://example.com" --format svg --output qr.svg
 */

import { parseArgs } from "node:util";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { zlibSync } from "node:zlib";

interface QRCodeOptions {
  text: string;
  format: "ascii" | "svg" | "png" | "terminal";
  output?: string;
  size: number;
  errorCorrection: "L" | "M" | "Q" | "H";
  darkColor: string;
  lightColor: string;
}

// Error correction levels (capacity percentages)
const ERROR_CORRECTION_BITS: Record<string, number> = {
  L: 7,
  M: 15,
  Q: 25,
  H: 30,
};

// Simplified QR Code matrix generator
// For production, use a proper library like 'qrcode'
function generateQRMatrix(text: string, errorLevel: string): boolean[][] {
  // This is a simplified implementation
  // In production, use: import QRCode from 'qrcode';

  // Determine version based on text length
  const len = text.length;
  let version = 1;
  if (len > 17) version = 2;
  if (len > 32) version = 3;
  if (len > 53) version = 4;
  if (len > 78) version = 5;
  if (len > 106) version = 6;
  if (len > 134) version = 7;
  if (len > 154) version = 8;
  if (len > 192) version = 9;
  if (len > 230) version = 10;

  // Module size formula: 4 * version + 17
  const moduleCount = 4 * version + 17;

  // Create matrix (all false = white, true = black)
  const matrix: boolean[][] = Array(moduleCount)
    .fill(null)
    .map(() => Array(moduleCount).fill(false));

  // Add finder patterns (top-left, top-right, bottom-left)
  addFinderPattern(matrix, 0, 0);
  addFinderPattern(matrix, moduleCount - 7, 0);
  addFinderPattern(matrix, 0, moduleCount - 7);

  // Add timing patterns
  for (let i = 8; i < moduleCount - 8; i++) {
    matrix[6][i] = i % 2 === 0;
    matrix[i][6] = i % 2 === 0;
  }

  // Add alignment patterns for version >= 2
  if (version >= 2) {
    const alignPos = moduleCount - 7;
    addAlignmentPattern(matrix, alignPos, alignPos);
  }

  // Add format information (simplified)
  addFormatInfo(matrix, errorLevel);

  // Encode data (simplified - just set some data modules based on text)
  const dataBytes = new TextEncoder().encode(text);
  let bitIndex = 0;
  const bits: number[] = [];

  // Convert bytes to bits
  for (const byte of dataBytes) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }

  // Fill data area (simplified - proper QR requires Reed-Solomon encoding)
  let upward = true;
  let col = moduleCount - 1;

  while (col > 0) {
    if (col === 6) col--; // Skip timing pattern column

    for (let row = upward ? moduleCount - 1 : 0;
         upward ? row >= 0 : row < moduleCount;
         row += upward ? -1 : 1) {

      for (let c = 0; c < 2; c++) {
        const currentCol = col - c;

        // Skip if module is already used (finder, timing, alignment, format)
        if (isReserved(matrix, currentCol, row, moduleCount)) {
          continue;
        }

        // Set data bit
        if (bitIndex < bits.length) {
          matrix[row][currentCol] = bits[bitIndex] === 1;
          bitIndex++;
        } else {
          // Padding
          matrix[row][currentCol] = false;
        }
      }
    }

    col -= 2;
    upward = !upward;
  }

  // Apply mask pattern 0 (XOR with checkerboard)
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (!isReserved(matrix, col, row, moduleCount)) {
        if ((row + col) % 2 === 0) {
          matrix[row][col] = !matrix[row][col];
        }
      }
    }
  }

  return matrix;
}

function addFinderPattern(matrix: boolean[][], row: number, col: number): void {
  // Outer border (7x7 black border with white inner)
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const isOuter = r === 0 || r === 6 || c === 0 || c === 6;
      const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      matrix[row + r][col + c] = isOuter || isInner;
    }
  }

  // Add separator (white border around finder)
  // Already white by default, just ensure 1 module margin
}

function addAlignmentPattern(matrix: boolean[][], row: number, col: number): void {
  // 5x5 pattern: outer black, center black, white between
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const isOuter = Math.abs(r) === 2 || Math.abs(c) === 2;
      const isCenter = r === 0 && c === 0;
      if (row + r >= 0 && row + r < matrix.length &&
          col + c >= 0 && col + c < matrix.length) {
        matrix[row + r][col + c] = isOuter || isCenter;
      }
    }
  }
}

function addFormatInfo(matrix: boolean[][], errorLevel: string): void {
  // Simplified format info - just set some modules around finders
  const size = matrix.length;

  // Top-left format area
  for (let i = 0; i < 8; i++) {
    if (i !== 6) { // Skip timing pattern
      matrix[8][i] = i % 2 === 0;
      matrix[i][8] = i % 2 === 0;
    }
  }

  // Top-right format area
  for (let i = 0; i < 8; i++) {
    matrix[8][size - 1 - i] = i % 2 === 0;
  }

  // Bottom-left format area
  for (let i = 0; i < 7; i++) {
    matrix[size - 1 - i][8] = i % 2 === 0;
  }

  // Dark module
  matrix[size - 8][8] = true;
}

function isReserved(matrix: boolean[][], col: number, row: number, size: number): boolean {
  // Finder patterns (with separator)
  if (row < 9 && col < 9) return true; // Top-left
  if (row < 9 && col >= size - 8) return true; // Top-right
  if (row >= size - 8 && col < 9) return true; // Bottom-left

  // Timing patterns
  if (row === 6 || col === 6) return true;

  // Format info
  if (row === 8 || col === 8) return true;

  return false;
}

function matrixToAscii(matrix: boolean[][], size: number): string {
  const moduleSize = Math.max(1, Math.floor(size / matrix.length));
  const lines: string[] = [];

  for (const row of matrix) {
    let line = "";
    for (const cell of row) {
      line += cell ? "██" : "  ";
    }
    // Scale vertically
    for (let i = 0; i < moduleSize; i++) {
      lines.push(line);
    }
  }

  // Add quiet zone (border)
  const border = "  ".repeat(matrix.length + 2);
  const result = [border, ...lines.map(l => "  " + l + "  "), border];
  return result.join("\n");
}

function matrixToTerminal(matrix: boolean[][]): string {
  // Use Unicode block characters for better display
  const lines: string[] = [];

  // Top border
  lines.push("\x1b[47m" + "  ".repeat(matrix.length + 2) + "\x1b[0m");

  for (const row of matrix) {
    let line = "\x1b[47m  \x1b[0m"; // Left border (white)
    for (const cell of row) {
      if (cell) {
        line += "\x1b[40m  \x1b[0m"; // Black module
      } else {
        line += "\x1b[47m  \x1b[0m"; // White module
      }
    }
    line += "\x1b[47m  \x1b[0m"; // Right border
    lines.push(line);
  }

  // Bottom border
  lines.push("\x1b[47m" + "  ".repeat(matrix.length + 2) + "\x1b[0m");

  return lines.join("\n");
}

function matrixToSvg(matrix: boolean[][], options: QRCodeOptions): string {
  const moduleSize = Math.max(4, Math.floor(options.size / matrix.length));
  const totalSize = moduleSize * (matrix.length + 2); // +2 for quiet zone
  const margin = moduleSize;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${totalSize}" height="${totalSize}"
     viewBox="0 0 ${totalSize} ${totalSize}">
  <rect width="100%" height="100%" fill="${options.lightColor}"/>
  <g fill="${options.darkColor}">
`;

  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix[row].length; col++) {
      if (matrix[row][col]) {
        const x = margin + col * moduleSize;
        const y = margin + row * moduleSize;
        svg += `    <rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}"/>\n`;
      }
    }
  }

  svg += `  </g>\n</svg>`;
  return svg;
}

function matrixToPng(matrix: boolean[][], options: QRCodeOptions): Buffer {
  const moduleSize = Math.max(4, Math.floor(options.size / matrix.length));
  const totalSize = moduleSize * (matrix.length + 2);
  const margin = moduleSize;

  // Create raw pixel data (RGBA)
  const pixels = Buffer.alloc(totalSize * totalSize * 4);

  // Parse colors
  const darkColor = hexToRgb(options.darkColor);
  const lightColor = hexToRgb(options.lightColor);

  // Fill with light color (background)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = lightColor.r;
    pixels[i + 1] = lightColor.g;
    pixels[i + 2] = lightColor.b;
    pixels[i + 3] = 255; // Alpha
  }

  // Draw dark modules
  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix[row].length; col++) {
      if (matrix[row][col]) {
        for (let py = 0; py < moduleSize; py++) {
          for (let px = 0; px < moduleSize; px++) {
            const x = margin + col * moduleSize + px;
            const y = margin + row * moduleSize + py;
            const idx = (y * totalSize + x) * 4;
            pixels[idx] = darkColor.r;
            pixels[idx + 1] = darkColor.g;
            pixels[idx + 2] = darkColor.b;
            pixels[idx + 3] = 255;
          }
        }
      }
    }
  }

  // Create PNG
  return createPng(pixels, totalSize, totalSize);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  // Expand short hex
  if (hex.length === 4) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }

  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) {
    return { r: 0, g: 0, b: 0 }; // Default to black
  }
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

// Simple PNG encoder (no external dependencies)
function createPng(pixels: Buffer, width: number, height: number): Buffer {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // Bit depth
  ihdr[9] = 2;  // Color type (RGB)
  ihdr[10] = 0; // Compression
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace

  const ihdrChunk = createChunk("IHDR", ihdr);

  // IDAT chunk (compressed image data)
  // Add filter byte (0 = None) before each scanline
  const rawData = Buffer.alloc(height * (1 + width * 3));
  let rawIdx = 0;
  for (let y = 0; y < height; y++) {
    rawData[rawIdx++] = 0; // Filter byte
    for (let x = 0; x < width; x++) {
      const pixelIdx = (y * width + x) * 4;
      rawData[rawIdx++] = pixels[pixelIdx];     // R
      rawData[rawIdx++] = pixels[pixelIdx + 1]; // G
      rawData[rawIdx++] = pixels[pixelIdx + 2]; // B
    }
  }

  const compressed = zlibSync.deflateSync(rawData);
  const idatChunk = createChunk("IDAT", compressed);

  // IEND chunk
  const iendChunk = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  // CRC = CRC32(type + data)
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

// CRC32 implementation
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  const table = getCrc32Table();

  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
  }

  return crc ^ 0xffffffff;
}

let crc32Table: Uint32Array | null = null;

function getCrc32Table(): Uint32Array {
  if (crc32Table) return crc32Table;

  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc32Table[i] = c;
  }
  return crc32Table;
}

async function generateQRCode(options: QRCodeOptions): Promise<string | Buffer> {
  const matrix = generateQRMatrix(options.text, options.errorCorrection);

  switch (options.format) {
    case "ascii":
      return matrixToAscii(matrix, options.size);

    case "terminal":
      return matrixToTerminal(matrix);

    case "svg":
      return matrixToSvg(matrix, options);

    case "png":
      return matrixToPng(matrix, options);

    default:
      throw new Error(`Unknown format: ${options.format}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      text: {
        type: "string",
        short: "t",
        description: "Text or URL to encode",
      },
      format: {
        type: "string",
        short: "f",
        default: "terminal",
        description: "Output format: ascii, svg, png, terminal",
      },
      output: {
        type: "string",
        short: "o",
        description: "Output file path (for svg/png)",
      },
      size: {
        type: "string",
        short: "s",
        default: "25",
        description: "Size of QR code",
      },
      errorCorrection: {
        type: "string",
        short: "e",
        default: "M",
        description: "Error correction: L, M, Q, H",
      },
      "dark-color": {
        type: "string",
        default: "#000000",
        description: "Dark module color",
      },
      "light-color": {
        type: "string",
        default: "#FFFFFF",
        description: "Light module color",
      },
      help: {
        type: "boolean",
        short: "h",
        default: false,
        description: "Show help",
      },
    },
    allowPositional: true,
  });

  if (values.help) {
    console.log(`
QR Code Generator - Generate QR codes from text or URLs

Usage: qrcode --text "your text" [options]

Options:
  -t, --text <string>       Text or URL to encode (required)
  -f, --format <format>     Output format: ascii, svg, png, terminal (default: terminal)
  -o, --output <file>       Output file path (for svg/png formats)
  -s, --size <number>       Size of QR code (default: 25)
  -e, --errorCorrection <L|M|Q|H>  Error correction level (default: M)
  --dark-color <color>      Color for dark modules (default: #000000)
  --light-color <color>     Color for light modules (default: #FFFFFF)
  -h, --help                Show this help

Examples:
  qrcode --text "https://example.com"
  qrcode -t "Hello World" -f ascii
  qrcode -t "https://example.com" -f svg -o qr.svg
  qrcode -t "Contact: +1234567890" -f png -o contact.png -s 200
`);
    process.exit(0);
  }

  // Get text from positional or --text flag
  const text = values.text || positionals.join(" ");

  if (!text) {
    console.error("Error: --text is required");
    console.error("Use --help for usage information");
    process.exit(1);
  }

  const format = values.format as QRCodeOptions["format"];
  if (!["ascii", "svg", "png", "terminal"].includes(format)) {
    console.error(`Error: Invalid format "${format}". Use: ascii, svg, png, terminal`);
    process.exit(1);
  }

  const errorCorrection = values.errorCorrection.toUpperCase();
  if (!["L", "M", "Q", "H"].includes(errorCorrection)) {
    console.error(`Error: Invalid error correction "${errorCorrection}". Use: L, M, Q, H`);
    process.exit(1);
  }

  const options: QRCodeOptions = {
    text,
    format,
    output: values.output,
    size: parseInt(values.size, 10) || 25,
    errorCorrection: errorCorrection as "L" | "M" | "Q" | "H",
    darkColor: parseColor(values["dark-color"] || "#000000"),
    lightColor: parseColor(values["light-color"] || "#FFFFFF"),
  };

  try {
    const result = await generateQRCode(options);

    if (options.output && (format === "svg" || format === "png")) {
      // Save to file
      const outputPath = resolve(options.output);

      // Create directory if needed
      const dir = dirname(outputPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      if (Buffer.isBuffer(result)) {
        writeFileSync(outputPath, result);
      } else {
        writeFileSync(outputPath, result);
      }

      console.log(`QR code saved to: ${outputPath}`);
    } else {
      // Output to stdout
      if (Buffer.isBuffer(result)) {
        process.stdout.write(result);
      } else {
        console.log(result);
      }
    }
  } catch (error) {
    console.error(`Error generating QR code: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function parseColor(color: string): string {
  // Validate and normalize color
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return color;
  }
  if (/^#[0-9A-Fa-f]{3}$/.test(color)) {
    // Expand #RGB to #RRGGBB
    const r = color[1];
    const g = color[2];
    const b = color[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  // Named colors - return as-is (SVG supports them)
  return color;
}

main();
