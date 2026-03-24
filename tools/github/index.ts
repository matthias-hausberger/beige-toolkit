import { spawn } from "child_process";
import { join } from "path";

// ToolHandler type is defined inline so this file is self-contained.
// It can be installed anywhere (e.g. ~/.beige/tools/github/) without needing
// the beige source tree.
type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: { cwd?: string; workspaceDir?: string }
) => Promise<{ output: string; exitCode: number }>;

export type GhExecutor = (
  args: string[],
  cwd?: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

