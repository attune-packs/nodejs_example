#!/usr/bin/env node
/**
 * Hello Action - Node.js Example Pack
 *
 * A minimal Node.js action that returns "Hello, Node.js".
 * Demonstrates the basic structure of a Node.js action in Attune.
 *
 * When invoked via the Node.js wrapper, the `run` export is called
 * with the action parameters as its argument.
 */

"use strict";

/**
 * Return a simple greeting message.
 * @param {object} params - Action parameters (unused).
 * @returns {{ message: string }}
 */
function run(params) {
  return { message: "Hello, Node.js" };
}

// Direct execution support (without the wrapper)
if (require.main === module) {
  const result = run({});
  process.stdout.write(JSON.stringify({ result, status: "success" }) + "\n");
  process.exit(0);
}

module.exports = { run };
