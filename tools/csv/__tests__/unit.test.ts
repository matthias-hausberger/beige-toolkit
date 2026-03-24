import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const TEST_DIR = "/tmp/csv-test-" + Date.now();
const TOOL_PATH = path.join(process.cwd(), "tools/csv/index.ts");

function run(args: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`npx tsx ${TOOL_PATH} ${args}`, {
      encoding: "utf-8",
      cwd: process.cwd(),
      env: { ...process.env, CSV_MAX_FILE_SIZE: "1048576", CSV_MAX_ROWS: "100" }
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      status: err.status || 1
    };
  }
}

function createTestFile(name: string, content: string): string {
  const filePath = path.join(TEST_DIR, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("CSV Tool", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("read", () => {
    it("reads basic CSV file", () => {
      const file = createTestFile("test.csv", "name,age\nAlice,30\nBob,25\n");
      const result = run(`read ${file}`);
      assert.strictEqual(result.status, 0);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rowCount, 2);
      assert.deepStrictEqual(data.headers, ["name", "age"]);
      assert.deepStrictEqual(data.rows[0], { name: "Alice", age: "30" });
    });

    it("reads TSV file with delimiter", () => {
      const file = createTestFile("test.tsv", "name\tage\nAlice\t30\n");
      const result = run(`read ${file} --delimiter '\\t'`);
      assert.strictEqual(result.status, 0);
      const data = JSON.parse(result.stdout);
      assert.deepStrictEqual(data.headers, ["name", "age"]);
    });

    it("respects limit option", () => {
      const file = createTestFile("test.csv", "n\n1\n2\n3\n4\n5\n");
      const result = run(`read ${file} --limit 2`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rows.length, 2);
    });

    it("respects offset option", () => {
      const file = createTestFile("test.csv", "n\n1\n2\n3\n");
      const result = run(`read ${file} --offset 1`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rows[0].n, "2");
    });

    it("handles file without headers", () => {
      const file = createTestFile("test.csv", "Alice,30\nBob,25\n");
      const result = run(`read ${file} --no-header`);
      const data = JSON.parse(result.stdout);
      assert.deepStrictEqual(data.headers, ["col_0", "col_1"]);
    });

    it("handles quoted fields", () => {
      const file = createTestFile("test.csv", 'name,desc\n"Smith, John","Hello, world!"\n');
      const result = run(`read ${file}`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rows[0].name, "Smith, John");
      assert.strictEqual(data.rows[0].desc, "Hello, world!");
    });
  });

  describe("write", () => {
    it("creates CSV from JSON", () => {
      const file = path.join(TEST_DIR, "out.csv");
      const result = run(`write ${file} --data '[{"name":"Alice","age":"30"}]'`);
      assert.strictEqual(result.status, 0);
      const content = fs.readFileSync(file, "utf-8");
      assert(content.includes("name,age"));
      assert(content.includes("Alice,30"));
    });

    it("appends to existing file", () => {
      const file = path.join(TEST_DIR, "out.csv");
      fs.writeFileSync(file, "name,age\nAlice,30\n");
      const result = run(`write ${file} --data '[{"name":"Bob","age":"25"}]' --append`);
      assert.strictEqual(result.status, 0);
      const content = fs.readFileSync(file, "utf-8");
      assert(content.includes("Bob"));
    });
  });

  describe("query", () => {
    it("filters with equals", () => {
      const file = createTestFile("test.csv", "name,status\nAlice,active\nBob,inactive\n");
      const result = run(`query ${file} --where "status = active"`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rowCount, 1);
      assert.strictEqual(data.rows[0].name, "Alice");
    });

    it("filters with greater than", () => {
      const file = createTestFile("test.csv", "name,age\nAlice,30\nBob,25\n");
      const result = run(`query ${file} --where "age > 26"`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rowCount, 1);
      assert.strictEqual(data.rows[0].name, "Alice");
    });

    it("filters with regex", () => {
      const file = createTestFile("test.csv", "name,email\nAlice,alice@example.com\nBob,bob@test.org\n");
      const result = run(`query ${file} --where "email ~ example"`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rowCount, 1);
      assert.strictEqual(data.rows[0].name, "Alice");
    });

    it("selects columns", () => {
      const file = createTestFile("test.csv", "a,b,c\n1,2,3\n");
      const result = run(`query ${file} --select "a,c"`);
      const data = JSON.parse(result.stdout);
      assert.deepStrictEqual(Object.keys(data.rows[0]), ["a", "c"]);
    });

    it("sorts ascending", () => {
      const file = createTestFile("test.csv", "name,num\nAlice,3\nBob,1\nCarol,2\n");
      const result = run(`query ${file} --orderBy num`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rows[0].name, "Bob");
      assert.strictEqual(data.rows[1].name, "Carol");
    });

    it("sorts descending", () => {
      const file = createTestFile("test.csv", "name,num\nAlice,1\nBob,3\nCarol,2\n");
      const result = run(`query ${file} --orderBy num --orderDir desc`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rows[0].name, "Bob");
    });
  });

  describe("convert", () => {
    it("converts to JSON", () => {
      const file = createTestFile("test.csv", "name,age\nAlice,30\n");
      const result = run(`convert ${file} --to json`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(Array.isArray(data), true);
      assert.strictEqual(data[0].name, "Alice");
    });

    it("converts to JSONL", () => {
      const file = createTestFile("test.csv", "name,age\nAlice,30\nBob,25\n");
      const result = run(`convert ${file} --to jsonl`);
      const lines = result.stdout.trim().split("\n");
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(JSON.parse(lines[0]).name, "Alice");
    });

    it("converts to TSV", () => {
      const file = createTestFile("test.csv", "name,age\nAlice,30\n");
      const result = run(`convert ${file} --to tsv`);
      assert(result.stdout.includes("\t"));
    });

    it("converts to markdown", () => {
      const file = createTestFile("test.csv", "name,age\nAlice,30\n");
      const result = run(`convert ${file} --to md`);
      assert(result.stdout.includes("| name |"));
      assert(result.stdout.includes("| --- |"));
    });

    it("saves to output file", () => {
      const file = createTestFile("test.csv", "name,age\nAlice,30\n");
      const outFile = path.join(TEST_DIR, "out.json");
      const result = run(`convert ${file} --to json -o ${outFile}`);
      assert.strictEqual(result.status, 0);
      assert(fs.existsSync(outFile));
    });
  });

  describe("stats", () => {
    it("returns file statistics", () => {
      const file = createTestFile("test.csv", "name,age,active\nAlice,30,true\nBob,25,false\nCarol,,true\n");
      const result = run(`stats ${file}`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rowCount, 3);
      assert.strictEqual(data.columnCount, 3);
      assert.strictEqual(data.columns.length, 3);
    });

    it("detects column types", () => {
      const file = createTestFile("test.csv", "num,str\n123,hello\n456,world\n");
      const result = run(`stats ${file}`);
      const data = JSON.parse(result.stdout);
      const numCol = data.columns.find((c: any) => c.name === "num");
      const strCol = data.columns.find((c: any) => c.name === "str");
      assert.strictEqual(numCol.type, "number");
      assert.strictEqual(strCol.type, "string");
    });

    it("counts unique values", () => {
      const file = createTestFile("test.csv", "status\nactive\nactive\ninactive\n");
      const result = run(`stats ${file}`);
      const data = JSON.parse(result.stdout);
      const statusCol = data.columns[0];
      assert.strictEqual(statusCol.uniqueCount, 2);
    });
  });

  describe("validate", () => {
    it("validates correct CSV", () => {
      const file = createTestFile("test.csv", "a,b,c\n1,2,3\n4,5,6\n");
      const result = run(`validate ${file}`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.valid, true);
      assert.strictEqual(data.issues.length, 0);
    });

    it("detects column count mismatch", () => {
      const file = createTestFile("test.csv", "a,b,c\n1,2,3\n4,5\n");
      const result = run(`validate ${file}`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.valid, false);
      assert(data.issues.some((i: any) => i.message.includes("mismatch")));
    });
  });

  describe("head/tail", () => {
    it("shows first N rows", () => {
      const file = createTestFile("test.csv", "n\n1\n2\n3\n4\n5\n");
      const result = run(`head ${file} -n 2`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rows.length, 2);
      assert.strictEqual(data.rows[0].n, "1");
    });

    it("shows last N rows", () => {
      const file = createTestFile("test.csv", "n\n1\n2\n3\n4\n5\n");
      const result = run(`tail ${file} -n 2`);
      const data = JSON.parse(result.stdout);
      assert.strictEqual(data.rows.length, 2);
      assert.strictEqual(data.rows[0].n, "4");
    });
  });

  describe("select", () => {
    it("selects specific columns", () => {
      const file = createTestFile("test.csv", "a,b,c\n1,2,3\n");
      const result = run(`select ${file} --columns "a,c"`);
      const content = result.stdout;
      assert(content.includes("a,c"));
      assert(!content.includes("b"));
    });
  });

  describe("filter", () => {
    it("filters by exact match", () => {
      const file = createTestFile("test.csv", "name,status\nAlice,active\nBob,inactive\n");
      const result = run(`filter ${file} --column status --value active`);
      const content = result.stdout;
      assert(content.includes("Alice"));
      assert(!content.includes("Bob"));
    });

    it("filters by regex", () => {
      const file = createTestFile("test.csv", "email\nalice@example.com\nbob@test.org\n");
      const result = run(`filter ${file} --column email --operator '~' --value example`);
      const content = result.stdout;
      assert(content.includes("alice"));
    });
  });

  describe("sort", () => {
    it("sorts ascending", () => {
      const file = createTestFile("test.csv", "name,num\nAlice,3\nBob,1\nCarol,2\n");
      const result = run(`sort ${file} --column num`);
      const content = result.stdout;
      const lines = content.trim().split("\n");
      assert(lines[1].includes("Bob")); // First data row
    });

    it("sorts descending", () => {
      const file = createTestFile("test.csv", "name,num\nAlice,1\nBob,3\nCarol,2\n");
      const result = run(`sort ${file} --column num --direction desc`);
      const content = result.stdout;
      const lines = content.trim().split("\n");
      assert(lines[1].includes("Bob"));
    });
  });

  describe("error handling", () => {
    it("reports file not found", () => {
      const result = run(`read /nonexistent/file.csv`);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes("not found") || result.stdout.includes("not found"));
    });

    it("reports missing required options", () => {
      const file = createTestFile("test.csv", "a\n1\n");
      const result = run(`filter ${file}`);
      assert.strictEqual(result.status, 1);
    });
  });
});
