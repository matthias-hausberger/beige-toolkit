#!/usr/bin/env bun
/**
 * Notification Tool for Beige Toolkit
 *
 * Send push notifications via ntfy.sh or self-hosted ntfy servers.
 * Great for alerting humans about important events, task completion, or errors.
 *
 * @example
 *   notify --message 'Task complete!'
 *   notify --message 'Build failed!' --priority high --title 'CI Alert'
 *   notify --message 'Check the logs' --tags warning,logs --emoji bell
 */

import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Config type
interface NotifyConfig {
  defaultTopic?: string;
  server?: string;
  allowTopics?: string[];
  denyTopics?: string[];
  defaultPriority?: string;
  token?: string;
}

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

// Load config from agent config file
function loadConfig(): NotifyConfig {
  const configPaths = [
    join(homedir(), ".beige", "agents", process.env.BEIGE_AGENT_NAME || "beige", "config.json"),
    join(homedir(), ".beige", "config.json"),
    "/etc/beige/config.json",
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        if (config.tools?.notify) {
          return config.tools.notify;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return {};
}

// Validate topic access
function validateTopic(topic: string, config: NotifyConfig): boolean {
  // If allowTopics is set, topic must be in the list
  if (config.allowTopics && config.allowTopics.length > 0) {
    if (!config.allowTopics.includes(topic)) {
      return false;
    }
  }

  // If denyTopics is set, topic must NOT be in the list
  if (config.denyTopics && config.denyTopics.length > 0) {
    if (config.denyTopics.includes(topic)) {
      return false;
    }
  }

  return true;
}

// Send notification via curl
function sendNotification(options: {
  message: string;
  topic: string;
  title?: string;
  priority?: string;
  tags?: string;
  emoji?: string;
  click?: string;
  attach?: string;
  delay?: string;
  actions?: string;
  server: string;
  token?: string;
}): { success: boolean; id?: string; error?: string } {
  const headers: string[] = [];

  // Add headers
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
    // Emoji can be used as a tag
    if (options.tags) {
      // Already has tags, add emoji
      headers[headers.findIndex((h) => h.startsWith("Tags:"))] = `Tags: ${options.tags},${options.emoji}`;
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
  if (options.actions) {
    headers.push(`Actions: ${options.actions}`);
  }
  if (options.token) {
    headers.push(`Authorization: Bearer ${options.token}`);
  }

  // Build curl command
  const url = `${options.server}/${options.topic}`;
  const curlArgs: string[] = ["-s", "-X", "POST", "-H", "Content-Type: text/plain"];

  // Add headers
  for (const header of headers) {
    curlArgs.push("-H", header);
  }

  // Add data
  curlArgs.push("-d", options.message);

  // Add URL
  curlArgs.push(url);

  const result = spawnSync("curl", curlArgs, {
    encoding: "utf-8",
    timeout: 30000,
  });

  if (result.error) {
    return { success: false, error: result.error.message };
  }

  if (result.status !== 0) {
    return { success: false, error: result.stderr || "Unknown curl error" };
  }

  // Parse response - ntfy returns JSON
  try {
    const response = JSON.parse(result.stdout);
    if (response.error) {
      return { success: false, error: response.error };
    }
    return { success: true, id: response.id };
  } catch {
    // If not JSON, just return success
    return { success: true };
  }
}

// Main CLI
async function main() {
  const { values, positionals } = parseArgs({
    options: {
      message: {
        type: "string",
        short: "m",
      },
      topic: {
        type: "string",
        short: "t",
      },
      title: {
        type: "string",
        short: "T",
      },
      priority: {
        type: "string",
        short: "p",
      },
      tags: {
        type: "string",
      },
      emoji: {
        type: "string",
        short: "e",
      },
      click: {
        type: "string",
        short: "c",
      },
      attach: {
        type: "string",
        short: "a",
      },
      delay: {
        type: "string",
        short: "d",
      },
      actions: {
        type: "string",
      },
      server: {
        type: "string",
        short: "s",
      },
      token: {
        type: "string",
      },
      quiet: {
        type: "boolean",
        short: "q",
      },
      help: {
        type: "boolean",
        short: "h",
      },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    console.log(`
notify - Send push notifications via ntfy.sh

USAGE:
  notify --message <text> [options]

OPTIONS:
  -m, --message <text>    Notification message (required)
  -t, --topic <name>      Topic to send to (default: from config or random)
  -T, --title <text>      Notification title
  -p, --priority <level>  Priority: min, low, default, high, urgent (or 1-5)
  --tags <tags>           Comma-separated tags (e.g., 'warning,skull')
  -e, --emoji <emoji>     Emoji for notification (e.g., 'bell', 'rotating_light')
  -c, --click <url>       URL to open when notification is clicked
  -a, --attach <url>      URL of attachment to include
  -d, --delay <duration>  Delay delivery (e.g., '30min', '2h', 'tomorrow, 10am')
  --actions <json>        JSON string of action buttons
  -s, --server <url>      Override ntfy server (default: https://ntfy.sh)
  --token <token>         Access token for protected topics
  -q, --quiet             Only output message ID on success
  -h, --help              Show this help

EXAMPLES:
  notify -m "Build complete!"
  notify -m "Error in production" -p high -T "Alert"
  notify -m "Check the logs" --tags warning --emoji bell
  notify -m "Click here" -c "https://example.com"

CONFIGURATION (in ~/.beige/config.json):
  {
    "tools": {
      "notify": {
        "defaultTopic": "my-topic",
        "server": "https://ntfy.sh",
        "defaultPriority": "default",
        "allowTopics": ["alerts", "builds"],
        "token": "tk_xxxxx"
      }
    }
  }

Ntfy.sh is a free notification service. Get the app at https://ntfy.sh
`);
    process.exit(0);
  }

  // Load config
  const config = loadConfig();

  // Get message from args or first positional
  let message = values.message;
  if (!message && positionals.length > 0) {
    message = positionals.join(" ");
  }

  if (!message) {
    console.error("Error: --message is required");
    process.exit(1);
  }

  // Get topic
  const topic = values.topic || config.defaultTopic;
  if (!topic) {
    console.error("Error: No topic specified and no defaultTopic in config");
    console.error("Use --topic <name> or set defaultTopic in config");
    process.exit(1);
  }

  // Validate topic access
  if (!validateTopic(topic, config)) {
    console.error(`Error: Topic "${topic}" is not allowed by config`);
    process.exit(1);
  }

  // Get priority
  const priorityValue = values.priority || config.defaultPriority;
  const priority = priorityValue ? PRIORITY_MAP[priorityValue] : undefined;

  // Get server
  const server = values.server || config.server || "https://ntfy.sh";

  // Get token
  const token = values.token || config.token;

  // Send notification
  const result = sendNotification({
    message,
    topic,
    title: values.title,
    priority,
    tags: values.tags,
    emoji: values.emoji,
    click: values.click,
    attach: values.attach,
    delay: values.delay,
    actions: values.actions,
    server,
    token,
  });

  if (result.success) {
    if (values.quiet && result.id) {
      console.log(result.id);
    } else {
      console.log(`✓ Notification sent to ${topic}`);
      if (result.id) {
        console.log(`  ID: ${result.id}`);
      }
    }
    process.exit(0);
  } else {
    console.error(`✗ Failed to send notification: ${result.error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
