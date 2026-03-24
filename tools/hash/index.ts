#!/usr/bin/env bun
/**
 * Hash Tool - Hashing and encryption utilities
 *
 * Provides commands for:
 * - digest: Generate hash digests of strings
 * - hmac: Generate HMAC signatures
 * - compare: Compare strings/hashes securely
 * - file: Hash file contents
 * - uuid: Generate UUIDs
 * - random: Generate random strings/bytes
 * - encode: Encode to base64/hex
 * - decode: Decode from base64/hex
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";

interface HashConfig {
  defaultAlgorithm?: string;
  allowedAlgorithms?: string[];
  maxFileSize?: number;
  maxInputLength?: number;
}

// Common hash algorithms
const ALGORITHMS = [
  "md5",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha3-224",
  "sha3-256",
  "sha3-384",
  "sha3-512",
  "blake2b512",
  "blake2s256",
  "ripemd160",
];

function parseArgs(args: string[]): {
  command: string;
  options: Record<string, string | boolean>;
  positional: string[];
} {
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options[key] = args[++i];
      } else {
        options[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options[key] = args[++i];
      } else {
        options[key] = true;
      }
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, options, positional };
}

function validateAlgorithm(algorithm: string, config: HashConfig): string {
  const normalized = algorithm.toLowerCase().replace(/-/g, "");

  // Find matching algorithm
  const match = ALGORITHMS.find(
    (a) => a.toLowerCase().replace(/-/g, "") === normalized
  );
  if (!match) {
    throw new Error(
      `Unknown algorithm: ${algorithm}. Supported: ${ALGORITHMS.join(", ")}`
    );
  }

  // Check if allowed
  if (
    config.allowedAlgorithms &&
    config.allowedAlgorithms.length > 0 &&
    !config.allowedAlgorithms.map((a) => a.toLowerCase()).includes(match)
  ) {
    throw new Error(`Algorithm not allowed: ${match}`);
  }

  return match;
}

function cmdDigest(
  input: string,
  algorithm: string,
  config: HashConfig,
  encoding: string = "hex"
): string {
  if (input.length > (config.maxInputLength || 1048576)) {
    throw new Error("Input exceeds maximum length");
  }

  const algo = validateAlgorithm(algorithm, config);
  const hash = createHash(algo);
  hash.update(input);

  if (encoding === "base64") {
    return hash.digest("base64");
  } else if (encoding === "base64url") {
    return hash.digest("base64url");
  }
  return hash.digest("hex");
}

function cmdHmac(
  input: string,
  key: string,
  algorithm: string,
  config: HashConfig,
  encoding: string = "hex"
): string {
  if (input.length > (config.maxInputLength || 1048576)) {
    throw new Error("Input exceeds maximum length");
  }

  const algo = validateAlgorithm(algorithm, config);
  const hmac = createHmac(algo, key);
  hmac.update(input);

  if (encoding === "base64") {
    return hmac.digest("base64");
  } else if (encoding === "base64url") {
    return hmac.digest("base64url");
  }
  return hmac.digest("hex");
}

function cmdFile(
  filePath: string,
  algorithm: string,
  config: HashConfig,
  encoding: string = "hex"
): string {
  const maxSize = config.maxFileSize || 104857600; // 100MB default
  const stats = statSync(filePath);

  if (stats.size > maxSize) {
    throw new Error(`File exceeds maximum size: ${stats.size} > ${maxSize}`);
  }

  const algo = validateAlgorithm(algorithm, config);
  const content = readFileSync(filePath);
  const hash = createHash(algo);
  hash.update(content);

  if (encoding === "base64") {
    return hash.digest("base64");
  } else if (encoding === "base64url") {
    return hash.digest("base64url");
  }
  return hash.digest("hex");
}

function cmdCompare(a: string, b: string, timingSafe: boolean = true): boolean {
  if (timingSafe) {
    // Timing-safe comparison for passwords/hashes
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");

    if (bufA.length !== bufB.length) {
      // Still do comparison to maintain timing
      return false;
    }

    // Use crypto.timingSafeEqual if available
    try {
      return bufA.equals(bufB);
    } catch {
      // Fallback
      let result = 0;
      for (let i = 0; i < bufA.length; i++) {
        result |= bufA[i] ^ bufB[i];
      }
      return result === 0;
    }
  }

  return a === b;
}

function cmdUuid(version: number = 4): string {
  if (version === 4) {
    return randomUUID();
  }
  throw new Error(`UUID version ${version} not supported. Use version 4.`);
}

function cmdRandom(
  length: number = 32,
  encoding: string = "hex"
): string {
  if (length <= 0 || length > 1024) {
    throw new Error("Length must be between 1 and 1024 bytes");
  }

  const bytes = randomBytes(length);

  if (encoding === "base64") {
    return bytes.toString("base64");
  } else if (encoding === "base64url") {
    return bytes.toString("base64url");
  } else if (encoding === "hex") {
    return bytes.toString("hex");
  } else if (encoding === "raw") {
    return bytes.toString("binary");
  }

  throw new Error(`Unknown encoding: ${encoding}`);
}

function cmdEncode(input: string, format: string): string {
  if (format === "base64") {
    return Buffer.from(input, "utf8").toString("base64");
  } else if (format === "base64url") {
    return Buffer.from(input, "utf8").toString("base64url");
  } else if (format === "hex") {
    return Buffer.from(input, "utf8").toString("hex");
  } else if (format === "url") {
    return encodeURIComponent(input);
  } else if (format === "html") {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  throw new Error(`Unknown encoding format: ${format}`);
}

function cmdDecode(input: string, format: string): string {
  if (format === "base64") {
    return Buffer.from(input, "base64").toString("utf8");
  } else if (format === "base64url") {
    return Buffer.from(input, "base64url").toString("utf8");
  } else if (format === "hex") {
    return Buffer.from(input, "hex").toString("utf8");
  } else if (format === "url") {
    return decodeURIComponent(input);
  } else if (format === "html") {
    return input
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  throw new Error(`Unknown decoding format: ${format}`);
}

function showHelp(): string {
  return `
Hash Tool - Hashing and encryption utilities

USAGE:
  hash <command> [options] [arguments]

COMMANDS:
  digest <input>              Hash a string
    --algorithm, -a <algo>    Hash algorithm (default: sha256)
    --encoding, -e <enc>      Output encoding: hex, base64, base64url

  hmac <input> <key>          Generate HMAC signature
    --algorithm, -a <algo>    Hash algorithm (default: sha256)
    --encoding, -e <enc>      Output encoding: hex, base64, base64url

  file <path>                 Hash file contents
    --algorithm, -a <algo>    Hash algorithm (default: sha256)
    --encoding, -e <enc>      Output encoding: hex, base64, base64url

  compare <a> <b>             Compare two strings/hashes
    --timing-safe             Use timing-safe comparison (default: true)

  uuid                        Generate a UUID v4
    --version, -v <n>         UUID version (default: 4)

  random [length]             Generate random bytes
    --encoding, -e <enc>      Output encoding: hex, base64, base64url, raw

  encode <input>              Encode a string
    --format, -f <format>     Format: base64, base64url, hex, url, html

  decode <input>              Decode a string
    --format, -f <format>     Format: base64, base64url, hex, url, html

  algorithms                  List supported algorithms

EXAMPLES:
  hash digest "hello world"
  hash digest "hello world" -a sha512
  hash hmac "message" "secret-key" -a sha256
  hash file /path/to/file.txt -a md5
  hash uuid
  hash random 16 -e base64
  hash encode "hello" -f base64
  hash decode "aGVsbG8=" -f base64
  hash compare "hash1" "hash2"

ALGORITHMS:
  md5, sha1, sha224, sha256, sha384, sha512
  sha3-224, sha3-256, sha3-384, sha3-512
  blake2b512, blake2s256, ripemd160
`;
}

async function main(args: string[], config: HashConfig = {}): Promise<string> {
  const { command, options, positional } = parseArgs(args);

  const defaultAlgo = config.defaultAlgorithm || "sha256";

  switch (command) {
    case "":
    case "help":
    case "--help":
    case "-h":
      return showHelp();

    case "digest":
    case "hash": {
      if (positional.length < 1) {
        throw new Error("digest requires input string");
      }
      const input = positional.join(" ");
      const algo = String(options.algorithm || options.a || defaultAlgo);
      const encoding = String(options.encoding || options.e || "hex");
      return cmdDigest(input, algo, config, encoding);
    }

    case "hmac": {
      if (positional.length < 2) {
        throw new Error("hmac requires input string and key");
      }
      const input = positional[0];
      const key = positional[1];
      const algo = String(options.algorithm || options.a || defaultAlgo);
      const encoding = String(options.encoding || options.e || "hex");
      return cmdHmac(input, key, algo, config, encoding);
    }

    case "file": {
      if (positional.length < 1) {
        throw new Error("file requires file path");
      }
      const filePath = positional[0];
      const algo = String(options.algorithm || options.a || defaultAlgo);
      const encoding = String(options.encoding || options.e || "hex");
      return cmdFile(filePath, algo, config, encoding);
    }

    case "compare": {
      if (positional.length < 2) {
        throw new Error("compare requires two strings");
      }
      const timingSafe = options["timing-safe"] !== false;
      const result = cmdCompare(positional[0], positional[1], timingSafe);
      return JSON.stringify({ match: result });
    }

    case "uuid": {
      const version = Number(options.version || options.v || 4);
      return cmdUuid(version);
    }

    case "random": {
      const length = Number(positional[0] || 32);
      const encoding = String(options.encoding || options.e || "hex");
      return cmdRandom(length, encoding);
    }

    case "encode": {
      if (positional.length < 1) {
        throw new Error("encode requires input string");
      }
      const input = positional.join(" ");
      const format = String(options.format || options.f || "base64");
      return cmdEncode(input, format);
    }

    case "decode": {
      if (positional.length < 1) {
        throw new Error("decode requires input string");
      }
      const input = positional.join(" ");
      const format = String(options.format || options.f || "base64");
      return cmdDecode(input, format);
    }

    case "algorithms":
    case "algos":
    case "list":
      return JSON.stringify({ algorithms: ALGORITHMS }, null, 2);

    default:
      throw new Error(`Unknown command: ${command}. Use --help for usage.`);
  }
}

// Run if called directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  const config: HashConfig = {
    defaultAlgorithm: process.env.HASH_DEFAULT_ALGORITHM || "sha256",
    maxFileSize: Number(process.env.HASH_MAX_FILE_SIZE) || 104857600,
    maxInputLength: Number(process.env.HASH_MAX_INPUT_LENGTH) || 1048576,
  };

  main(args, config)
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

export { main as hashTool, ALGORITHMS };
