import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const TEST_DIR = "/tmp/text-test-" + Date.now();
const TOOL_PATH = path.join(process.cwd(), "tools/text/index.ts");

function run(args: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`npx tsx ${TOOL_PATH} ${args}`, {
      encoding: "utf-8",
      cwd: process.cwd(),
      env: { ...process.env, TEXT_MAX_INPUT_SIZE: "1048576" }
    });
    return { stdout: stdout.trim(), stderr: "", status: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "").trim(),
      stderr: (err.stderr || "").trim(),
      status: err.status || 1
    };
  }
}

function createTestFile(name: string, content: string): string {
  const filePath = path.join(TEST_DIR, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("Text Tool", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("case", () => {
    it("converts to uppercase", () => {
      const result = run('case --to upper -t "hello world"');
      assert.strictEqual(result.stdout, "HELLO WORLD");
    });

    it("converts to lowercase", () => {
      const result = run('case --to lower -t "HELLO WORLD"');
      assert.strictEqual(result.stdout, "hello world");
    });

    it("converts to title case", () => {
      const result = run('case --to title -t "hello world"');
      assert.strictEqual(result.stdout, "Hello World");
    });

    it("converts to camelCase", () => {
      const result = run('case --to camel -t "hello-world"');
      assert.strictEqual(result.stdout, "helloWorld");
    });

    it("converts to snake_case", () => {
      const result = run('case --to snake -t "helloWorld"');
      assert.strictEqual(result.stdout, "hello_world");
    });

    it("converts to kebab-case", () => {
      const result = run('case --to kebab -t "hello world"');
      assert.strictEqual(result.stdout, "hello-world");
    });

    it("converts to PascalCase", () => {
      const result = run('case --to pascal -t "hello-world"');
      assert.strictEqual(result.stdout, "HelloWorld");
    });

    it("converts to CONSTANT_CASE", () => {
      const result = run('case --to constant -t "hello world"');
      assert.strictEqual(result.stdout, "HELLO_WORLD");
    });
  });

  describe("transform", () => {
    it("trims whitespace", () => {
      const result = run('transform --ops trim -t "  hello  "');
      assert.strictEqual(result.stdout, "hello");
    });

    it("url encodes", () => {
      const result = run('transform --ops urlencode -t "hello world"');
      assert.strictEqual(result.stdout, "hello%20world");
    });

    it("url decodes", () => {
      const result = run('transform --ops urldecode -t "hello%20world"');
      assert.strictEqual(result.stdout, "hello world");
    });

    it("base64 encodes", () => {
      const result = run('transform --ops base64encode -t "hello"');
      assert.strictEqual(result.stdout, Buffer.from("hello").toString("base64"));
    });

    it("base64 decodes", () => {
      const encoded = Buffer.from("hello").toString("base64");
      const result = run(`transform --ops base64decode -t "${encoded}"`);
      assert.strictEqual(result.stdout, "hello");
    });

    it("html encodes", () => {
      const result = run('transform --ops htmlencode -t "<script>"');
      assert.strictEqual(result.stdout, "&lt;script&gt;");
    });

    it("html decodes", () => {
      const result = run('transform --ops htmldecode -t "&lt;script&gt;"');
      assert.strictEqual(result.stdout, "<script>");
    });

    it("applies multiple transforms", () => {
      const result = run('transform --ops trim,urlencode -t "  hello world  "');
      assert.strictEqual(result.stdout, "hello%20world");
    });

    it("strips HTML tags", () => {
      const result = run('transform --ops strip -t "<p>hello</p>"');
      assert.strictEqual(result.stdout, "hello");
    });

    it("escapes special characters", () => {
      const result = run('transform --ops escape -t "hello\nworld"');
      assert.strictEqual(result.stdout, "hello\\nworld");
    });
  });

  describe("template", () => {
    it("substitutes variables", () => {
      const result = run('template -t "Hello {{name}}!" --data \'{"name":"Alice"}\'');
      assert.strictEqual(result.stdout, "Hello Alice!");
    });

    it("substitutes multiple variables", () => {
      const result = run('template -t "{{greeting}} {{name}}!" --data \'{"greeting":"Hi","name":"Bob"}\'');
      assert.strictEqual(result.stdout, "Hi Bob!");
    });

    it("supports custom delimiters", () => {
      const result = run('template -t "Hello ${name}!" --prefix \'${\' --suffix \'}\' --data \'{"name":"Alice"}\'');
      assert.strictEqual(result.stdout, "Hello Alice!");
    });
  });

  describe("count", () => {
    it("counts characters", () => {
      const result = run('count -t "hello"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.characters, 5);
    });

    it("counts words", () => {
      const result = run('count -t "hello world test"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.words, 3);
    });

    it("counts lines", () => {
      const result = run('count -t "hello\nworld"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.lines, 2);
    });

    it("counts bytes", () => {
      const result = run('count -t "hello"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.bytes, 5);
    });
  });

  describe("extract", () => {
    it("extracts emails", () => {
      const result = run('extract --pattern email -t "Contact alice@example.com and bob@test.org"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.count, 2);
      assert(data.matches.includes("alice@example.com"));
      assert(data.matches.includes("bob@test.org"));
    });

    it("extracts URLs", () => {
      const result = run('extract --pattern url -t "Visit https://example.com and http://test.org"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.count, 2);
    });

    it("extracts numbers", () => {
      const result = run('extract --pattern number -t "Price: 19.99, count: 5"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.count, 2);
      assert(data.matches.includes("19.99"));
      assert(data.matches.includes("5"));
    });

    it("extracts with unique flag", () => {
      const result = run('extract --pattern email --unique -t "a@test.com b@test.com a@test.com"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.count, 2);
    });

    it("extracts with custom regex", () => {
      const result = run('extract --pattern "\\d{4}" -t "Years: 2020, 2021, 2022"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.count, 3);
    });
  });

  describe("replace", () => {
    it("replaces text", () => {
      const result = run('replace --find foo --replace bar -t "foo is foo"');
      assert.strictEqual(result.stdout, "bar is bar");
    });

    it("replaces first only with --all=false", () => {
      const result = run('replace --find foo --replace bar --all=false -t "foo foo foo"');
      assert.strictEqual(result.stdout, "bar foo foo");
    });

    it("replaces case-insensitively", () => {
      const result = run('replace --find HELLO --replace hi --ignoreCase -t "Hello HELLO"');
      assert.strictEqual(result.stdout, "hi hi");
    });
  });

  describe("trim", () => {
    it("trims both sides", () => {
      const result = run('trim -t "  hello  "');
      assert.strictEqual(result.stdout, "hello");
    });

    it("trims lines", () => {
      const result = run('trim -t "  hello  \n  world  "');
      assert.strictEqual(result.stdout, "hello\nworld");
    });

    it("trims left only", () => {
      const result = run('trim --mode left -t "  hello  "');
      assert.strictEqual(result.stdout, "hello  ");
    });

    it("trims right only", () => {
      const result = run('trim --mode right -t "  hello  "');
      assert.strictEqual(result.stdout, "  hello");
    });
  });

  describe("pad", () => {
    it("pads right", () => {
      const result = run('pad --width 10 -t "hello"');
      assert.strictEqual(result.stdout, "hello     ");
    });

    it("pads left", () => {
      const result = run('pad --width 10 --side left -t "hello"');
      assert.strictEqual(result.stdout, "     hello");
    });

    it("pads center", () => {
      const result = run('pad --width 10 --side center -t "hello"');
      assert.strictEqual(result.stdout.length, 10);
    });

    it("pads with custom character", () => {
      const result = run('pad --width 10 --char "-" -t "hello"');
      assert.strictEqual(result.stdout, "hello-----");
    });
  });

  describe("wrap", () => {
    it("wraps text to width", () => {
      const result = run('wrap --width 10 -t "hello world this is a test"');
      assert(result.stdout.includes("\n"));
    });

    it("preserves existing newlines", () => {
      const result = run('wrap --width 80 -t "hello\nworld"');
      assert(result.stdout.includes("\n"));
    });
  });

  describe("align", () => {
    it("aligns left", () => {
      const result = run('align --width 10 --side left -t "hello"');
      assert.strictEqual(result.stdout, "hello");
    });

    it("aligns right", () => {
      const result = run('align --width 10 --side right -t "hello"');
      assert.strictEqual(result.stdout, "     hello");
    });

    it("aligns center", () => {
      const result = run('align --width 10 --side center -t "hello"');
      assert.strictEqual(result.stdout.length, 10);
    });
  });

  describe("sort", () => {
    it("sorts alphabetically", () => {
      const result = run('sort -t "zebra\napple\nbanana"');
      assert.strictEqual(result.stdout, "apple\nbanana\nzebra");
    });

    it("sorts numerically", () => {
      const result = run('sort --numeric -t "10\n2\n1\n20"');
      assert.strictEqual(result.stdout, "1\n2\n10\n20");
    });

    it("sorts in reverse", () => {
      const result = run('sort --reverse -t "apple\nbanana"');
      assert.strictEqual(result.stdout, "banana\napple");
    });

    it("removes duplicates", () => {
      const result = run('sort --unique -t "a\nb\na\nc"');
      assert.strictEqual(result.stdout, "a\nb\nc");
    });
  });

  describe("unique", () => {
    it("removes duplicates", () => {
      const result = run('unique -t "a\nb\na\nc"');
      assert.strictEqual(result.stdout, "a\nb\nc");
    });

    it("counts occurrences", () => {
      const result = run('unique --count -t "a\nb\na"');
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.length, 2);
      assert.strictEqual(data.find((d: any) => d.line === "a").count, 2);
    });
  });

  describe("reverse", () => {
    it("reverses characters", () => {
      const result = run('reverse -t "hello"');
      assert.strictEqual(result.stdout, "olleh");
    });

    it("reverses words", () => {
      const result = run('reverse --mode words -t "hello world"');
      assert.strictEqual(result.stdout, "world hello");
    });

    it("reverses lines", () => {
      const result = run('reverse --mode lines -t "first\nsecond"');
      assert.strictEqual(result.stdout, "second\nfirst");
    });
  });

  describe("error handling", () => {
    it("reports missing input", () => {
      const result = run('case --to upper');
      assert.strictEqual(result.status, 1);
    });

    it("reports invalid case", () => {
      const result = run('case --to invalid -t "hello"');
      assert.strictEqual(result.status, 1);
    });

    it("reports file not found", () => {
      const result = run('count -f /nonexistent.txt');
      assert.strictEqual(result.status, 1);
    });
  });
});
