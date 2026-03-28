/**
 * Shared binary resolution utility.
 *
 * When the gateway process is launched from a GUI app, systemd service, or
 * launchd, it often inherits a minimal PATH that does not include Homebrew
 * (/opt/homebrew/bin) or Linuxbrew (/home/linuxbrew/.linuxbrew/bin).
 *
 * This helper tries multiple strategies to locate a binary:
 *   1. `which <name>` — uses whatever PATH the current process has
 *   2. Common Homebrew / Linuxbrew / system paths
 *   3. Falls back to the bare name (spawn will fail with a clear ENOENT)
 */

import { execFileSync } from "node:child_process";

/**
 * Common install paths to probe when `which` fails.
 * Order: Apple Silicon Homebrew, Intel Homebrew, Linuxbrew, system.
 */
const COMMON_PREFIXES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/home/linuxbrew/.linuxbrew/bin",
];

/**
 * Resolve the absolute path to a CLI binary.
 *
 * @param name  Binary name (e.g. "gh", "git", "slackcli", "confluence")
 * @returns     Absolute path if found, otherwise the bare name as fallback.
 */
export function resolveBin(name: string): string {
  // 1. Try `which` — works when PATH is adequate
  try {
    return execFileSync("which", [name], { encoding: "utf-8", timeout: 3000 }).trim();
  } catch { /* not on PATH */ }

  // 2. Probe common paths
  for (const prefix of COMMON_PREFIXES) {
    const candidate = `${prefix}/${name}`;
    try {
      execFileSync("test", ["-x", candidate], { timeout: 1000 });
      return candidate;
    } catch { /* not here */ }
  }

  // 3. Bare name fallback — spawn will produce a clear error
  return name;
}
