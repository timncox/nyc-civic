#!/usr/bin/env node
console.log("Starting NYC Civic MCP App server...");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

import { getDb } from "./src/db.js";
import { resolveAddress } from "./src/geocoder.js";
import { lookupElectionDistrict } from "./src/scrapers/boe.js";
import { registerTools } from "./src/tools.js";

const resourceUri = "ui://civic-dashboard/mcp-app.html";

function createServer(): McpServer {
const server = new McpServer({
  name: "nyc-civic",
  version: "2.0.0",
  description: "Interactive NYC civic tracker — reps, votes, bills, Democratic Party org",
});

// ─── Primary App Tool ────────────────────────────────────────────────────────

registerAppTool(
  server,
  "civic_dashboard",
  {
    title: "NYC Civic Dashboard",
    description: "Show an interactive dashboard of NYC elected representatives, voting records, legislation, and Democratic Party organization for a given address.",
    inputSchema: {
      address: z.string().default("").describe("NYC street address"),
    },
    _meta: { ui: { resourceUri } },
  },
  async ({ address }: { address: string }) => {
    if (!address) {
      return {
        content: [{ type: "text", text: JSON.stringify({ address: null, districts: null, message: "Enter an NYC address to get started" }) }],
      };
    }
    const districts = await resolveAddress(address);
    // Try election district
    if (!districts.electionDistrict) {
      try {
        const boe = await lookupElectionDistrict(address);
        if (boe.electionDistrict) districts.electionDistrict = boe.electionDistrict;
      } catch { /* non-critical */ }
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ address, districts }) }],
    };
  },
);

// ─── UI Resource ─────────────────────────────────────────────────────────────

registerAppResource(
  server,
  resourceUri,
  resourceUri,
  { mimeType: RESOURCE_MIME_TYPE },
  async () => {
    const html = await fs.readFile(
      path.join(import.meta.dirname, "..", "dist", "mcp-app.html"),
      "utf-8",
    );
    return {
      contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
    };
  },
);

// ─── Register all data tools from src/tools.ts ───────────────────────────────

registerTools(server);

return server;
} // end createServer

// ─── HTTP Server ─────────────────────────────────────────────────────────────

await getDb(); // Initialize database

const expressApp = express();

// Serve landing page
expressApp.use(express.static(path.join(import.meta.dirname, "..", "public")));

expressApp.use(cors({
  origin: true,
  credentials: true,
  exposedHeaders: ["mcp-session-id"],
  allowedHeaders: ["Content-Type", "mcp-session-id", "Accept"],
}));
expressApp.use(express.json());

const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

// Strip stale session IDs before they reach the transport.
// The MCP SDK rejects requests with unknown session IDs internally,
// so we must remove the header for sessions we don't know about.
expressApp.use("/mcp", (req, _res, next) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && !sessions.has(sessionId)) {
    delete req.headers["mcp-session-id"];
  }
  next();
});

expressApp.post("/mcp", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Reuse existing session
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp] Error handling request for session", sessionId, e);
      if (!res.headersSent) res.status(500).json({ error: String(e) });
    }
    return;
  }

  // New session (stale sessions had their header stripped by middleware above)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });

  const sessionServer = createServer();

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await sessionServer.connect(transport);
  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    sessions.set(transport.sessionId, { transport, server: sessionServer });
  }
});

expressApp.get("/mcp", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No session" });
});

expressApp.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    transport.close();
    sessions.delete(sessionId);
  }
  res.status(200).end();
});

const PORT = parseInt(process.env.PORT || "3001", 10);
expressApp.listen(PORT, () => {
  console.log(`NYC Civic MCP v1.1.0 listening on http://localhost:${PORT}/mcp`);
});
