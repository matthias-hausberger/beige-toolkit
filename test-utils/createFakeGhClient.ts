/**
 * Fake gh CLI client for testing the GitHub tool without real network calls.
 *
 * Usage:
 *
 *   const fake = createFakeGhClient();
 *   fake.register(["repo", "list"], { output: "my-org/my-repo", exitCode: 0 });
 *
 *   // Then stub the tool's runGh internals by passing the fake's run function
 *   // as the executor to createHandler.
 */

export interface FakeGhResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

export type GhExecutor = (
  args: string[],
  token?: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface FakeGhClient {
  /**
   * Register a canned response for a specific args prefix.
   * The first args that startsWith the registered prefix wins.
   */
  register(argsPrefix: string[], result: FakeGhResult): void;

  /**
   * The executor function to inject into the tool handler.
   * Pass this to createHandler({ ... }, { executor: fake.run }).
   */
  run: GhExecutor;

  /** All args arrays that were dispatched through this fake. */
  calls: string[][];

  /** Tokens passed to each invocation (parallel index with calls). */
  tokens: (string | undefined)[];
}

export function createFakeGhClient(): FakeGhClient {
  const responses: Array<{ prefix: string[]; result: FakeGhResult }> = [];
  const calls: string[][] = [];
  const tokens: (string | undefined)[] = [];

  const run: GhExecutor = async (args: string[], token?: string) => {
    calls.push([...args]);
    tokens.push(token);

    for (const { prefix, result } of responses) {
      const matches = prefix.every((p, i) => args[i] === p);
      if (matches) {
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode,
        };
      }
    }

    // Unregistered call — return a clear error so tests fail loudly.
    return {
      stdout: "",
      stderr: `[FakeGhClient] No response registered for args: ${JSON.stringify(args)}`,
      exitCode: 1,
    };
  };

  return {
    calls,
    tokens,
    register(argsPrefix, result) {
      responses.push({ prefix: argsPrefix, result });
    },
    run,
  };
}
