import { describe, it, beforeEach } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";

// Priority mapping
const PRIORITY_MAP: Record<string, string> = {
  min: "5",
  low: "4",
  default: "3",
  high: "2",
  urgent: "1",
  "5": "5",
  "4": "4",
  "3": "3",
  "2": "2",
  "1": "1",
};

// Topic validation
function validateTopic(
  topic: string,
  config: { allowTopics?: string[]; denyTopics?: string[] }
): boolean {
  if (config.allowTopics && config.allowTopics.length > 0) {
    if (!config.allowTopics.includes(topic)) {
      return false;
    }
  }

  if (config.denyTopics && config.denyTopics.length > 0) {
    if (config.denyTopics.includes(topic)) {
      return false;
    }
  }

  return true;
}

// URL construction
function buildUrl(server: string, topic: string): string {
  return `${server}/${topic}`;
}

// Header construction
interface NotificationOptions {
  title?: string;
  priority?: string;
  tags?: string;
  emoji?: string;
  click?: string;
  attach?: string;
  delay?: string;
  token?: string;
}

function buildHeaders(options: NotificationOptions): string[] {
  const headers: string[] = [];

  if (options.title) {
    headers.push(`Title: ${options.title}`);
  }
  if (options.priority) {
    headers.push(`Priority: ${options.priority}`);
  }
  if (options.tags) {
    headers.push(`Tags: ${options.tags}`);
  }
  if (options.emoji) {
    if (options.tags) {
      const idx = headers.findIndex((h) => h.startsWith("Tags:"));
      if (idx >= 0) {
        headers[idx] = `Tags: ${options.tags},${options.emoji}`;
      }
    } else {
      headers.push(`Tags: ${options.emoji}`);
    }
  }
  if (options.click) {
    headers.push(`Click: ${options.click}`);
  }
  if (options.attach) {
    headers.push(`Attach: ${options.attach}`);
  }
  if (options.delay) {
    headers.push(`Delay: ${options.delay}`);
  }
  if (options.token) {
    headers.push(`Authorization: Bearer ${options.token}`);
  }

  return headers;
}

// Response parsing
function parseResponse(stdout: string): {
  success: boolean;
  id?: string;
  error?: string;
} {
  try {
    const response = JSON.parse(stdout);
    if (response.error) {
      return { success: false, error: response.error };
    }
    return { success: true, id: response.id };
  } catch {
    return { success: true };
  }
}

describe("Notify Tool", () => {
  describe("Priority mapping", () => {
    it("maps named priorities correctly", () => {
      expect(PRIORITY_MAP["min"]).toBe("5");
      expect(PRIORITY_MAP["low"]).toBe("4");
      expect(PRIORITY_MAP["default"]).toBe("3");
      expect(PRIORITY_MAP["high"]).toBe("2");
      expect(PRIORITY_MAP["urgent"]).toBe("1");
    });

    it("maps numeric priorities correctly", () => {
      expect(PRIORITY_MAP["1"]).toBe("1");
      expect(PRIORITY_MAP["2"]).toBe("2");
      expect(PRIORITY_MAP["3"]).toBe("3");
      expect(PRIORITY_MAP["4"]).toBe("4");
      expect(PRIORITY_MAP["5"]).toBe("5");
    });
  });

  describe("Topic validation", () => {
    it("allows any topic when no restrictions", () => {
      expect(validateTopic("any-topic", {})).toBe(true);
    });

    it("allows topics in allowTopics list", () => {
      const config = { allowTopics: ["alerts", "builds"] };
      expect(validateTopic("alerts", config)).toBe(true);
      expect(validateTopic("builds", config)).toBe(true);
      expect(validateTopic("other", config)).toBe(false);
    });

    it("blocks topics in denyTopics list", () => {
      const config = { denyTopics: ["private", "secret"] };
      expect(validateTopic("private", config)).toBe(false);
      expect(validateTopic("secret", config)).toBe(false);
      expect(validateTopic("public", config)).toBe(true);
    });

    it("denyTopics takes precedence", () => {
      const config = {
        allowTopics: ["alerts", "private"],
        denyTopics: ["private"],
      };
      expect(validateTopic("alerts", config)).toBe(true);
      expect(validateTopic("private", config)).toBe(false);
    });
  });

  describe("URL construction", () => {
    it("builds correct URL for default server", () => {
      expect(buildUrl("https://ntfy.sh", "my-topic")).toBe(
        "https://ntfy.sh/my-topic"
      );
    });

    it("builds correct URL for custom server", () => {
      expect(buildUrl("https://ntfy.example.com", "alerts")).toBe(
        "https://ntfy.example.com/alerts"
      );
    });
  });

  describe("Header construction", () => {
    it("builds title header", () => {
      const headers = buildHeaders({ title: "Alert" });
      expect(headers).toContain("Title: Alert");
    });

    it("builds priority header", () => {
      const headers = buildHeaders({ priority: "high" });
      expect(headers).toContain("Priority: high");
    });

    it("builds tags header", () => {
      const headers = buildHeaders({ tags: "warning,build" });
      expect(headers).toContain("Tags: warning,build");
    });

    it("appends emoji to existing tags", () => {
      const headers = buildHeaders({ tags: "warning", emoji: "bell" });
      expect(headers).toContain("Tags: warning,bell");
    });

    it("creates tags header with just emoji", () => {
      const headers = buildHeaders({ emoji: "bell" });
      expect(headers).toContain("Tags: bell");
    });

    it("builds click header", () => {
      const headers = buildHeaders({ click: "https://example.com" });
      expect(headers).toContain("Click: https://example.com");
    });

    it("builds delay header", () => {
      const headers = buildHeaders({ delay: "30min" });
      expect(headers).toContain("Delay: 30min");
    });

    it("builds auth header", () => {
      const headers = buildHeaders({ token: "tk_test123" });
      expect(headers).toContain("Authorization: Bearer tk_test123");
    });

    it("builds multiple headers", () => {
      const headers = buildHeaders({
        title: "Alert",
        priority: "high",
        tags: "warning",
      });
      expect(headers).toContain("Title: Alert");
      expect(headers).toContain("Priority: high");
      expect(headers).toContain("Tags: warning");
      expect(headers.length).toBe(3);
    });
  });

  describe("Response parsing", () => {
    it("parses successful response", () => {
      const result = parseResponse('{"id":"abc123","topic":"test"}');
      expect(result.success).toBe(true);
      expect(result.id).toBe("abc123");
    });

    it("parses error response", () => {
      const result = parseResponse('{"error":"Invalid topic"}');
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid topic");
    });

    it("handles non-JSON response", () => {
      const result = parseResponse("OK");
      expect(result.success).toBe(true);
    });
  });
});
