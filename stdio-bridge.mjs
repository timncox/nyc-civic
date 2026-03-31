#!/usr/bin/env node
/**
 * NYC Civic stdio-to-HTTP bridge for Claude Desktop.
 * Starts the HTTP server, then bridges stdio JSON-RPC to it.
 * Buffers all stdin until the server is ready, ensuring no messages are lost.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PORT = 3001;
const SERVER_URL = `http://localhost:${SERVER_PORT}/mcp`;

// --- Start reading stdin immediately (buffer until server ready) ---

let sessionId = null;
const pendingQueue = []; // messages received before server ready
let serverReady = false;
let processing = false;
let stdinEnded = false;

let stdinBuffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split("\n");
  stdinBuffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (serverReady) {
        enqueue(msg);
      } else {
        pendingQueue.push(msg);
      }
    } catch {
      process.stderr.write(`Invalid JSON: ${line}\n`);
    }
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  if (!processing && serverReady) {
    server.kill();
    process.exit(0);
  }
});

// --- Start the HTTP server ---

const server = spawn("node", [join(__dirname, "dist", "server.js")], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(SERVER_PORT) },
});

server.stderr.on("data", (chunk) => process.stderr.write(chunk));

server.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  if (text.includes("listening") && !serverReady) {
    serverReady = true;
    // Flush buffered messages
    for (const msg of pendingQueue) {
      enqueue(msg);
    }
    pendingQueue.length = 0;
  }
});

server.on("exit", (code) => process.exit(code ?? 1));
process.on("exit", () => server.kill());
process.on("SIGTERM", () => { server.kill(); process.exit(0); });
process.on("SIGINT", () => { server.kill(); process.exit(0); });

// --- Queue + send ---

const queue = [];

function enqueue(message) {
  // Drop notifications (no id) that arrive before we have a session —
  // the server rejects them with "Server not initialized"
  // Note: id can be 0, so check for undefined/null specifically
  if (message.id === undefined && !sessionId) return;
  queue.push(message);
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    await sendToServer(queue.shift());
  }
  processing = false;
  if (stdinEnded) {
    server.kill();
    process.exit(0);
  }
}

async function sendToServer(message) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const res = await fetch(SERVER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(30000),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    // Notifications (no id) — drain response, don't output
    if (message.id === undefined || message.id === null) {
      await res.text();
      return;
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          process.stdout.write(line.slice(6) + "\n");
        }
      }
    } else {
      const data = await res.text();
      if (data.trim()) {
        process.stdout.write(data + "\n");
      }
    }
  } catch (err) {
    if (message.id) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: err.message },
        id: message.id,
      }) + "\n");
    }
    process.stderr.write(`Bridge error: ${err.message}\n`);
  }
}
