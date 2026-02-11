#!/usr/bin/env node
/**
 * Read Counter Action - Node.js Example Pack
 *
 * Consumes a counter value (typically from the counter sensor trigger payload)
 * and returns a formatted message containing the counter value.
 *
 * Parameters are delivered via stdin as JSON from the Node.js wrapper.
 */

"use strict";

/**
 * @param {object} params
 * @param {number} params.counter - The counter value from the trigger payload.
 * @param {string} params.rule_ref - The rule reference the counter is scoped to.
 * @returns {object} Formatted message and raw counter value.
 */
function run(params) {
  const counter = params.counter !== undefined ? params.counter : 0;
  const ruleRef = params.rule_ref || "unknown";

  return {
    message: `Counter value is ${counter} (from rule: ${ruleRef})`,
    counter: counter,
    rule_ref: ruleRef,
  };
}

module.exports = { run };
