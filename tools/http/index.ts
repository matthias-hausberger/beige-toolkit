/**
 * HTTP Fetch Tool for Beige agents
 * 
 * A simple wrapper using curl for making HTTP requests to external APIs and services.
 * Supports GET, POST, PUT, DELETE methods with custom headers and timeouts.
 */

import { spawn } from "child_process";

import type { ToolHandler } from "@beige/tool-utils";

interface HttpConfig {
  allowDomains?: string | string[];
  denyDomains?: string | string[];
  defaultTimeout?: number;
  maxResponseSize?: number;
}

interface ParsedRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeout: number;
}

/**
 * Parse command line arguments into a request object
 */
function parseArgs(args: string[], defaultTimeout: number): ParsedRequest | { error: string } {
  if (args.length < 2) {
    return { error: "Usage: http <get|post|put|delete> <url> [--header key=value]... [--timeout seconds] [-- body]" };
  }

  const method = args[0].toUpperCase() as "GET" | "POST" | "PUT" | "DELETE";
  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
    return { error: `Invalid method: ${method}. Must be GET, POST, PUT, or DELETE.` };
  }

  const url = args[1];
  
  // Validate URL
  try {
    new URL(url);
  } catch {
    return { error: `Invalid URL: ${url}` };
  }

  const headers: Record<string, string> = {};
  let body: string | undefined;
  let timeout = defaultTimeout;

  // Parse remaining arguments
  let i = 2;
  while (i < args.length) {
    if (args[i] === "--header" && i + 1 < args.length) {
      const headerValue = args[i + 1];
      const eqIndex = headerValue.indexOf("=");
      if (eqIndex === -1) {
        return { error: `Invalid header format: ${headerValue}. Use --header key=value` };
      }
      const key = headerValue.slice(0, eqIndex);
      const value = headerValue.slice(eqIndex + 1);
      headers[key] = value;
      i += 2;
    } else if (args[i] === "--timeout" && i + 1 < args.length) {
      const timeoutValue = parseInt(args[i + 1], 10);
      if (isNaN(timeoutValue) || timeoutValue <= 0) {
        return { error: `Invalid timeout: ${args[i + 1]}. Must be a positive number.` };
      }
      timeout = timeoutValue;
      i += 2;
    } else if (args[i] === "--") {
      // Body starts after --
      body = args.slice(i + 1).join(" ");
      break;
    } else {
      i++;
    }
  }

  return { method, url, headers, body, timeout };
}

/**
 * Check if URL is allowed based on domain configuration
 */
function isUrlAllowed(url: string, config: HttpConfig): { allowed: boolean; reason?: string } {
  const urlObj = new URL(url);
  const hostname = urlObj.hostname.toLowerCase();

  // Check deny list first
  if (config.denyDomains) {
    const denyList = Array.isArray(config.denyDomains) ? config.denyDomains : [config.denyDomains];
    for (const denied of denyList) {
      const deniedLower = denied.toLowerCase();
      if (hostname === deniedLower || hostname.endsWith("." + deniedLower)) {
        return { allowed: false, reason: `Domain '${hostname}' is in deny list` };
      }
    }
  }

  // Check allow list
  if (config.allowDomains) {
    const allowList = Array.isArray(config.allowDomains) ? config.allowDomains : [config.allowDomains];
    let matched = false;
    for (const allowed of allowList) {
      const allowedLower = allowed.toLowerCase();
      if (hostname === allowedLower || hostname.endsWith("." + allowedLower)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { allowed: false, reason: `Domain '${hostname}' is not in allow list` };
    }
  }

  return { allowed: true };
}

/**
 * HTTP Fetch Tool — Make HTTP requests to external services
 * Executes on the gateway host using curl.
 *
 * Commands:
 *   get <url> [--header key=value]... [--timeout seconds]
 *   post <url> [--header key=value]... [--timeout seconds] [-- body]
 *   put <url> [--header key=value]... [--timeout seconds] [-- body]
 *   delete <url> [--header key=value]... [--timeout seconds]
 *
 * Config:
 *   allowDomains    — only allow requests to these domains (default: all)
 *   denyDomains     — always block requests to these domains (deny beats allow)
 *   defaultTimeout  — default timeout in seconds (default: 30)
 *   maxResponseSize — maximum response size in bytes (default: 1MB)
 */
export function createHandler(config: Record<string, unknown>): ToolHandler {
  const httpConfig: HttpConfig = {
    allowDomains: config.allowDomains as string | string[] | undefined,
    denyDomains: config.denyDomains as string | string[] | undefined,
    defaultTimeout: (config.defaultTimeout as number) ?? 30,
    maxResponseSize: (config.maxResponseSize as number) ?? 1048576, // 1MB
  };

  return async (args: string[]) => {
    const parsed = parseArgs(args, httpConfig.defaultTimeout);
    if ("error" in parsed) {
      return { output: `Error: ${parsed.error}`, exitCode: 1 };
    }

    // Check domain permissions
    const urlCheck = isUrlAllowed(parsed.url, httpConfig);
    if (!urlCheck.allowed) {
      return { output: `Permission denied: ${urlCheck.reason}`, exitCode: 1 };
    }

    // Build curl command
    const curlArgs: string[] = ["-s", "-X", parsed.method];
    
    // Add headers
    for (const [key, value] of Object.entries(parsed.headers)) {
      curlArgs.push("-H", `${key}: ${value}`);
    }
    
    // Add body for POST/PUT
    if (parsed.body && ["POST", "PUT"].includes(parsed.method)) {
      curlArgs.push("-d", parsed.body);
    }
    
    // Add timeout
    curlArgs.push("--max-time", String(parsed.timeout));
    
    // Add URL
    curlArgs.push(parsed.url);

    // Execute curl
    return new Promise((resolve) => {
      const proc = spawn("curl", curlArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          resolve({ output: `Error: ${stderr || stdout}`, exitCode: 1 });
          return;
        }

        // Check response size
        if (stdout.length > httpConfig.maxResponseSize!) {
          resolve({
            output: `Error: Response too large (${stdout.length} bytes). Maximum allowed: ${httpConfig.maxResponseSize} bytes.`,
            exitCode: 1,
          });
          return;
        }

        resolve({ output: stdout, exitCode: 0 });
      });

      // Set timeout
      setTimeout(() => {
        proc.kill();
        resolve({ output: `Error: Request timed out after ${parsed.timeout} seconds`, exitCode: 1 });
      }, parsed.timeout * 1000);
    });
  };
}
