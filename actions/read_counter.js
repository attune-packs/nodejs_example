#!/usr/bin/env node
/**
 * Read Counter Action - Node.js Example Pack
 *
 * Consumes a counter value (typically from the counter sensor trigger payload)
 * and returns a formatted message containing the counter value.
 *
 * Parameters are delivered via stdin as JSON.
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

    const counter = params.counter !== undefined ? params.counter : 0;
    const ruleRef = params.rule_ref || "unknown";

    const result = {
      message: `Counter value is ${counter} (from rule: ${ruleRef})`,
      counter: counter,
      rule_ref: ruleRef,
    };
    process.stdout.write(JSON.stringify(result) + "\n");
  });
}

main();
