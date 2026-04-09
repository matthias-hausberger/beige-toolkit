import { describe, it, expect } from "vitest";
import { extractCleanResponse } from "../index.js";

// ---------------------------------------------------------------------------
// Test cases for extractCleanResponse function
// ---------------------------------------------------------------------------

describe("extractCleanResponse", () => {
  describe("response marker patterns", () => {
    it("should extract after 'Now let me respond to X:'", () => {
      const input = `Analysis here.\n\nNow let me respond to Matthias:\n\nThanks, Matthias!`;
      expect(extractCleanResponse(input)).toBe("Thanks, Matthias!");
    });

    it("should extract after 'Now let me respond to X:' with newlines", () => {
      const input = `Analysis here.\n\nNow let me respond to\nMatthias:\n\nThanks, Matthias!`;
      expect(extractCleanResponse(input)).toBe("Thanks, Matthias!");
    });

    it("should extract after 'Now let me respond:' (no username)", () => {
      const input = `Analysis here.\n\nNow let me respond:\n\nClean response here.`;
      expect(extractCleanResponse(input)).toBe("Clean response here.");
    });

    it("should extract after 'Here is my response:'", () => {
      const input = `Analysis.\n\nHere is my response:\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });

    it("should extract after 'Here's my response:'", () => {
      const input = `Analysis.\n\nHere's my response:\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });

    it("should extract after 'Let me respond to X:'", () => {
      const input = `Analysis.\n\nLet me respond to Matthias:\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });
  });

  describe("section header patterns", () => {
    it("should extract after '---\\n## Response'", () => {
      const input = `Analysis.\n\n---\n## Response\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });

    it("should extract after '---\\n## Final Response'", () => {
      const input = `Analysis.\n\n---\n## Final Response\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });

    it("should extract after '---\\n## Comment'", () => {
      const input = `Analysis.\n\n---\n## Comment\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });

    it("should handle section header with spaces", () => {
      const input = `Analysis.\n\n---\n\n## Response\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });
  });

  describe("multi-paragraph analysis", () => {
    it("should handle bullet point analysis", () => {
      const input = `Excellent! The fix is clean and correct. It:\n\n- Captures the response data\n- Checks if deleted === 0\n- Otherwise, prints success\n\nNow let me respond to Matthias:\n\nThanks, Matthias!`;
      expect(extractCleanResponse(input)).toBe("Thanks, Matthias!");
    });

    it("should handle numbered list analysis", () => {
      const input = `The fix includes:\n\n1. First thing\n2. Second thing\n3. Third thing\n\nNow let me respond:\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });

    it("should handle Matthias's exact example", () => {
      const input = `Excellent! The fix is clean and correct. It:\n\nCaptures the response data from the PATCH call\nChecks if deleted === 0 (meaning no secrets were actually deleted)\nIf so, prints an error and exits with code 4\nOtherwise, prints the success message as before\nThis is a straightforward, minimal fix that addresses the issue of misleading success messages when deleting non-existent secrets. Now let me respond to Matthias:\n\nThanks, Matthias! Yeah, this was a simple but important fix — the server was already returning the deleted count, but the CLI was ignoring it. Now it properly errors out with exit code 4 when you try to delete a secret that doesn't exist, which makes scripting much more reliable.`;
      expect(extractCleanResponse(input)).toBe("Thanks, Matthias! Yeah, this was a simple but important fix — the server was already returning the deleted count, but the CLI was ignoring it. Now it properly errors out with exit code 4 when you try to delete a secret that doesn't exist, which makes scripting much more reliable.");
    });
  });

  describe("already clean responses", () => {
    it("should return clean response unchanged", () => {
      const input = `Thanks, Matthias! This was a simple fix.`;
      expect(extractCleanResponse(input)).toBe(input);
    });

    it("should return multi-paragraph clean response unchanged", () => {
      const input = `First paragraph.\n\nSecond paragraph.\n\nThird paragraph.`;
      expect(extractCleanResponse(input)).toBe(input);
    });

    it("should return response starting with @username", () => {
      const input = `@matthias-hausberger Thanks! This looks good.`;
      expect(extractCleanResponse(input)).toBe(input);
    });

    it("should return direct answer unchanged", () => {
      const input = `Yes, that's correct. The fix is ready to merge.`;
      expect(extractCleanResponse(input)).toBe(input);
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      expect(extractCleanResponse("")).toBe("");
    });

    it("should handle whitespace-only string", () => {
      expect(extractCleanResponse("   \n\n  ")).toBe("   \n\n  ");
    });

    it("should handle single line analysis", () => {
      const input = `Now let me respond to Matthias: Thanks!`;
      expect(extractCleanResponse(input)).toBe("Thanks!");
    });

    it("should handle multiple markers (use first)", () => {
      const input = `Analysis.\n\nNow let me respond:\n\n---\n## Response\n\nClean response.`;
      // First marker ("Now let me respond:") extracts everything after it
      // This includes the section marker which becomes part of the response
      const result = extractCleanResponse(input);
      expect(result).toContain("---");
      expect(result).toContain("## Response");
      expect(result).toContain("Clean response.");
    });

    it("should handle case-insensitive markers", () => {
      const input = `Analysis.\n\nNOW LET ME RESPOND TO MATTHIAS:\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });

    it("should handle marker at end of paragraph", () => {
      const input = `The fix is complete and tested. Now let me respond to Matthias:\n\nClean response.`;
      expect(extractCleanResponse(input)).toBe("Clean response.");
    });
  });

  describe("last paragraph heuristic", () => {
    it("should extract last paragraph if no marker found", () => {
      const input = `Great! The fix works.\n\nThis is a straightforward minimal fix.\n\nThanks for the review!`;
      expect(extractCleanResponse(input)).toBe("Thanks for the review!");
    });

    it("should extract last paragraph with analysis prefix", () => {
      const input = `Excellent! The fix is clean.\n\nThis addresses the issue.\n\nThanks, Matthias!`;
      // "Excellent!" at start triggers extraction of last paragraph
      expect(extractCleanResponse(input)).toBe("Thanks, Matthias!");
    });

    it("should NOT extract last paragraph if it looks like analysis", () => {
      const input = `First point.\n\nSecond point.\n\nThis is a comprehensive fix that addresses all edge cases.`;
      // Last paragraph starts with "This is" - analysis language
      // Should return original since it's clearly not a clean response
      expect(extractCleanResponse(input)).toBe(input);
    });
  });
});
