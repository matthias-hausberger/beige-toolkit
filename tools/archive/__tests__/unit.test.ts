import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createArchive,
  extractArchive,
  listArchive,
  testArchive,
  addFiles,
  detectFormat,
  isPathAllowed,
  parseSize,
  formatBytes,
} from "../index";

const TEST_DIR = "/tmp/archive-tool-test";
const TEST_CONFIG = {};

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function setupTestFiles() {
  cleanup();
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, "src"), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, "file1.txt"), "Hello, World!");
  fs.writeFileSync(path.join(TEST_DIR, "file2.txt"), "Another file");
  fs.writeFileSync(path.join(TEST_DIR, "src", "code.ts"), "const x = 1;");
  fs.writeFileSync(path.join(TEST_DIR, "config.json"), '{"key": "value"}');
}

describe("Archive Tool", () => {
  beforeEach(() => {
    setupTestFiles();
  });

  afterEach(() => {
    cleanup();
  });

  describe("detectFormat", () => {
    it("should detect tar.gz from extension", () => {
      expect(detectFormat("archive.tar.gz")).toBe("tar.gz");
    });

    it("should detect tar.gz from .tgz", () => {
      expect(detectFormat("archive.tgz")).toBe("tar.gz");
    });

    it("should detect tar.bz2 from extension", () => {
      expect(detectFormat("archive.tar.bz2")).toBe("tar.bz2");
    });

    it("should detect tar.bz2 from .tbz2", () => {
      expect(detectFormat("archive.tbz2")).toBe("tar.bz2");
    });

    it("should detect zip", () => {
      expect(detectFormat("archive.zip")).toBe("zip");
    });

    it("should detect tar", () => {
      expect(detectFormat("archive.tar")).toBe("tar");
    });

    it("should default to tar.gz for unknown extensions", () => {
      expect(detectFormat("archive.unknown")).toBe("tar.gz");
    });
  });

  describe("parseSize", () => {
    it("should parse bytes", () => {
      expect(parseSize("100B")).toBe(100);
    });

    it("should parse kilobytes", () => {
      expect(parseSize("1KB")).toBe(1024);
    });

    it("should parse megabytes", () => {
      expect(parseSize("10MB")).toBe(10 * 1024 * 1024);
    });

    it("should parse gigabytes", () => {
      expect(parseSize("1GB")).toBe(1024 * 1024 * 1024);
    });

    it("should parse with space", () => {
      expect(parseSize("100 MB")).toBe(100 * 1024 * 1024);
    });

    it("should return 0 for invalid input", () => {
      expect(parseSize("invalid")).toBe(0);
    });
  });

  describe("formatBytes", () => {
    it("should format 0 bytes", () => {
      expect(formatBytes(0)).toBe("0 B");
    });

    it("should format bytes", () => {
      expect(formatBytes(500)).toBe("500 B");
    });

    it("should format kilobytes", () => {
      expect(formatBytes(1024)).toBe("1 KB");
    });

    it("should format megabytes", () => {
      expect(formatBytes(1024 * 1024)).toBe("1 MB");
    });

    it("should format with decimal", () => {
      expect(formatBytes(1500)).toBe("1.46 KB");
    });
  });

  describe("isPathAllowed", () => {
    it("should allow all paths when no restrictions", () => {
      expect(isPathAllowed("/any/path", {})).toBe(true);
    });

    it("should deny blocked paths", () => {
      expect(isPathAllowed("/etc/passwd", { denyPaths: ["/etc/**"] })).toBe(false);
    });

    it("should allow only whitelisted paths", () => {
      expect(isPathAllowed("/workspace/file.txt", { allowPaths: ["/workspace/**"] })).toBe(true);
    });

    it("should deny non-whitelisted paths", () => {
      expect(isPathAllowed("/tmp/file.txt", { allowPaths: ["/workspace/**"] })).toBe(false);
    });

    it("should check deny list before allow list", () => {
      expect(
        isPathAllowed("/workspace/secret", {
          allowPaths: ["/workspace/**"],
          denyPaths: ["/workspace/secret"],
        })
      ).toBe(false);
    });
  });

  describe("createArchive", () => {
    it("should create a tar.gz archive", async () => {
      const archivePath = path.join(TEST_DIR, "test.tar.gz");
      const result = await createArchive(
        archivePath,
        [path.join(TEST_DIR, "file1.txt"), path.join(TEST_DIR, "file2.txt")],
        "tar.gz",
        6,
        undefined,
        TEST_CONFIG
      );

      expect(result.success).toBe(true);
      expect(result.data?.format).toBe("tar.gz");
      expect(result.data?.files).toBe(2);
      expect(fs.existsSync(archivePath)).toBe(true);
    });

    it("should create a zip archive", async () => {
      const archivePath = path.join(TEST_DIR, "test.zip");
      const result = await createArchive(
        archivePath,
        [path.join(TEST_DIR, "file1.txt")],
        "zip",
        6,
        undefined,
        TEST_CONFIG
      );

      expect(result.success).toBe(true);
      expect(result.data?.format).toBe("zip");
      expect(fs.existsSync(archivePath)).toBe(true);
    });

    it("should fail with non-existent files", async () => {
      const archivePath = path.join(TEST_DIR, "test.tar.gz");
      const result = await createArchive(
        archivePath,
        [path.join(TEST_DIR, "nonexistent.txt")],
        "tar.gz",
        6,
        undefined,
        TEST_CONFIG
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should deny access to blocked paths", async () => {
      const archivePath = "/etc/test.tar.gz";
      const result = await createArchive(
        archivePath,
        ["/etc/passwd"],
        "tar.gz",
        6,
        undefined,
        { denyPaths: ["/etc/**"] }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Access denied");
    });

    it("should work with working directory", async () => {
      const archivePath = path.join(TEST_DIR, "relative.tar.gz");
      const result = await createArchive(
        archivePath,
        ["file1.txt", "src"],
        "tar.gz",
        6,
        TEST_DIR,
        TEST_CONFIG
      );

      expect(result.success).toBe(true);
      expect(fs.existsSync(archivePath)).toBe(true);
    });
  });

  describe("listArchive", () => {
    it("should list archive contents", async () => {
      const archivePath = path.join(TEST_DIR, "list-test.tar.gz");
      await createArchive(
        archivePath,
        [path.join(TEST_DIR, "file1.txt"), path.join(TEST_DIR, "file2.txt")],
        "tar.gz",
        6,
        undefined,
        TEST_CONFIG
      );

      const result = await listArchive(archivePath, false, TEST_CONFIG);

      expect(result.success).toBe(true);
      expect(result.data?.count).toBe(2);
    });

    it("should fail with non-existent archive", async () => {
      const result = await listArchive("/nonexistent/archive.tar.gz", false, TEST_CONFIG);
      expect(result.success).toBe(false);
    });

    it("should deny access to blocked paths", async () => {
      const result = await listArchive("/etc/secret.tar.gz", false, { denyPaths: ["/etc/**"] });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Access denied");
    });
  });

  describe("testArchive", () => {
    it("should verify a valid archive", async () => {
      const archivePath = path.join(TEST_DIR, "valid.tar.gz");
      await createArchive(
        archivePath,
        [path.join(TEST_DIR, "file1.txt")],
        "tar.gz",
        6,
        undefined,
        TEST_CONFIG
      );

      const result = await testArchive(archivePath, TEST_CONFIG);

      expect(result.success).toBe(true);
      expect(result.data?.valid).toBe(true);
    });

    it("should fail with non-existent archive", async () => {
      const result = await testArchive("/nonexistent/archive.tar.gz", TEST_CONFIG);
      expect(result.success).toBe(false);
    });
  });

  describe("extractArchive", () => {
    it("should extract a tar.gz archive", async () => {
      const archivePath = path.join(TEST_DIR, "extract-test.tar.gz");
      await createArchive(
        archivePath,
        [path.join(TEST_DIR, "file1.txt"), path.join(TEST_DIR, "file2.txt")],
        "tar.gz",
        6,
        undefined,
        TEST_CONFIG
      );

      const outputDir = path.join(TEST_DIR, "extracted");
      const result = await extractArchive(archivePath, outputDir, undefined, 0, true, TEST_CONFIG);

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "tmp", "archive-tool-test", "file1.txt"))).toBe(true);
    });

    it("should fail with non-existent archive", async () => {
      const result = await extractArchive("/nonexistent/archive.tar.gz", TEST_DIR, undefined, 0, true, TEST_CONFIG);
      expect(result.success).toBe(false);
    });

    it("should deny access to blocked paths", async () => {
      const result = await extractArchive("/etc/secret.tar.gz", TEST_DIR, undefined, 0, true, {
        denyPaths: ["/etc/**"],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("addFiles", () => {
    it("should add files to existing zip archive", async () => {
      const archivePath = path.join(TEST_DIR, "add-test.zip");
      await createArchive(
        archivePath,
        [path.join(TEST_DIR, "file1.txt")],
        "zip",
        6,
        undefined,
        TEST_CONFIG
      );

      const result = await addFiles(
        archivePath,
        [path.join(TEST_DIR, "file2.txt")],
        undefined,
        TEST_CONFIG
      );

      expect(result.success).toBe(true);
      expect(result.data?.filesAdded).toBe(1);
    });

    it("should fail for non-zip archives", async () => {
      const archivePath = path.join(TEST_DIR, "add-test.tar.gz");
      await createArchive(
        archivePath,
        [path.join(TEST_DIR, "file1.txt")],
        "tar.gz",
        6,
        undefined,
        TEST_CONFIG
      );

      const result = await addFiles(
        archivePath,
        [path.join(TEST_DIR, "file2.txt")],
        undefined,
        TEST_CONFIG
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("only supported for zip");
    });

    it("should fail with non-existent file to add", async () => {
      const archivePath = path.join(TEST_DIR, "add-missing.zip");
      await createArchive(
        archivePath,
        [path.join(TEST_DIR, "file1.txt")],
        "zip",
        6,
        undefined,
        TEST_CONFIG
      );

      const result = await addFiles(
        archivePath,
        [path.join(TEST_DIR, "nonexistent.txt")],
        undefined,
        TEST_CONFIG
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });
});
