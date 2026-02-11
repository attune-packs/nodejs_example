#!/usr/bin/env node
/**
 * HTTP Example Action - Node.js Example Pack
 *
 * Demonstrates using the `node-fetch` library to make an HTTP call to example.com.
 * Receives parameters via the Node.js wrapper (stdin JSON with code_path).
 */

const fetch = require("node-fetch");

async function run(params) {
  const url = params.url || "https://example.com";

  const response = await fetch(url, { timeout: 10000 });
  const text = await response.text();

  return {
    status_code: response.status,
    url: response.url,
    content_length: text.length,
    snippet: text.slice(0, 500),
    success: response.ok,
  };
}

module.exports = { run };
