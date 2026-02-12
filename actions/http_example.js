#!/usr/bin/env node
/**
 * HTTP Example Action - Node.js Example Pack
 *
 * Demonstrates using the built-in https/http modules to make an HTTP call.
 * Receives parameters via stdin as JSON.
 */

"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");

function fetchUrl(url, timeout) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;

    const req = mod.get(url, { timeout }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          status_code: res.statusCode,
          url: url,
          content_length: body.length,
          snippet: body.slice(0, 500),
          success: res.statusCode >= 200 && res.statusCode < 400,
        });
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

function main() {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("readable", () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
      data += chunk;
    }
  });
  process.stdin.on("end", async () => {
    // Parse the first line as JSON parameters
    const firstLine = data.split("\n")[0].trim();
    let params = {};
    if (firstLine) {
      try {
        params = JSON.parse(firstLine);
      } catch {
        // ignore parse errors, use empty params
      }
    }

    const url = params.url || "https://example.com";
    const timeout = (params.timeout || 10) * 1000;

    try {
      const result = await fetchUrl(url, timeout);
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch (err) {
      process.stderr.write(
        JSON.stringify({ error: err.message || String(err) }) + "\n",
      );
      process.exit(1);
    }
  });
}

main();
