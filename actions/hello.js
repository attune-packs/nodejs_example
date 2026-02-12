#!/usr/bin/env node
/**
 * Hello Action - Node.js Example Pack
 *
 * A minimal Node.js action that returns "Hello, Node.js".
 * Demonstrates the basic structure of a self-contained action in Attune.
 *
 * Actions receive parameters as JSON on stdin and write results to stdout.
 */

"use strict";

function main() {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("readable", () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
      data += chunk;
    }
  });
  process.stdin.on("end", () => {
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

    const name = params.name || "Node.js";
    const result = { message: `Hello, ${name}` };
    process.stdout.write(JSON.stringify(result) + "\n");
  });
}

main();
