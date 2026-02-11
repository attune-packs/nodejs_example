#!/usr/bin/env node
/**
 * Counter Sensor - Node.js Example Pack
 *
 * A stateful Node.js sensor that demonstrates:
 * - RabbitMQ integration (amqplib) for rule lifecycle events
 * - Attune keystore API for persistent per-rule counter state
 * - Periodic event emission via the Attune events API
 * - Per-rule scoped counters with independent timers
 * - Graceful shutdown with timer cleanup
 *
 * Environment Variables (provided by attune-sensor service):
 *     ATTUNE_API_URL      - Base URL of the Attune API (e.g. http://localhost:8080)
 *     ATTUNE_API_TOKEN    - JWT token for authenticating API calls
 *     ATTUNE_SENSOR_ID    - Database ID of this sensor instance
 *     ATTUNE_SENSOR_REF   - Reference name (nodejs_example.counter_sensor)
 *     ATTUNE_MQ_URL       - RabbitMQ connection URL (e.g. amqp://localhost:5672)
 *     ATTUNE_MQ_EXCHANGE  - RabbitMQ exchange name (default: attune)
 *     ATTUNE_LOG_LEVEL    - Logging verbosity (default: info)
 */

"use strict";

const http = require("http");
const https = require("https");
const url = require("url");
const amqplib = require("amqplib");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_URL = process.env.ATTUNE_API_URL || "http://localhost:8080";
const API_TOKEN = process.env.ATTUNE_API_TOKEN || "";
const SENSOR_ID = process.env.ATTUNE_SENSOR_ID || "0";
const SENSOR_REF =
  process.env.ATTUNE_SENSOR_REF || "nodejs_example.counter_sensor";
const MQ_URL = process.env.ATTUNE_MQ_URL || "amqp://localhost:5672";
const MQ_EXCHANGE = process.env.ATTUNE_MQ_EXCHANGE || "attune";
const LOG_LEVEL = (process.env.ATTUNE_LOG_LEVEL || "info").toLowerCase();

const TRIGGER_TYPE = "nodejs_example.counter";
const KEY_PREFIX = "nodejs_example.counter";
const DEFAULT_INTERVAL = 1; // seconds

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL] !== undefined ? LOG_LEVELS[LOG_LEVEL] : 1;

const ROUTING_KEYS = [
  "rule.created",
  "rule.enabled",
  "rule.disabled",
  "rule.deleted",
];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logJson(level, message, extra) {
  if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < CURRENT_LOG_LEVEL) {
    return;
  }
  const entry = Object.assign(
    {
      timestamp: new Date().toISOString(),
      level: level,
      sensor: SENSOR_REF,
      message: message,
    },
    extra || {}
  );
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// HTTP helpers (built-in, no external deps for sensor API calls)
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request using Node built-in http/https modules.
 * Returns a Promise resolving to { statusCode, body }.
 */
function httpRequest(method, reqUrl, body) {
  return new Promise(function (resolve, reject) {
    const parsed = new url.URL(reqUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const options = {
      method: method,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        Authorization: "Bearer " + API_TOKEN,
        "Content-Type": "application/json",
      },
      timeout: 5000,
    };

    const req = lib.request(options, function (res) {
      const chunks = [];
      res.on("data", function (chunk) {
        chunks.push(chunk);
      });
      res.on("end", function () {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (_e) {
          // not JSON
        }
        resolve({ statusCode: res.statusCode, body: parsed, raw: raw });
      });
    });

    req.on("error", function (err) {
      reject(err);
    });

    req.on("timeout", function () {
      req.destroy(new Error("Request timeout"));
    });

    if (body !== undefined && body !== null) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Keystore API helpers
// ---------------------------------------------------------------------------

async function keystoreGet(keyRef) {
  try {
    const res = await httpRequest(
      "GET",
      API_URL + "/api/v1/keys/" + encodeURIComponent(keyRef)
    );
    if (res.statusCode === 200 && res.body && res.body.data) {
      return res.body.data.value;
    }
    if (res.statusCode === 404) {
      return null;
    }
    logJson("warn", "keystore GET unexpected status", {
      key: keyRef,
      status: res.statusCode,
    });
    return null;
  } catch (err) {
    logJson("error", "keystore GET failed", {
      key: keyRef,
      error: err.message,
    });
    return null;
  }
}

async function keystorePut(keyRef, value) {
  try {
    const res = await httpRequest(
      "PUT",
      API_URL + "/api/v1/keys/" + encodeURIComponent(keyRef),
      { value: String(value), name: "Counter: " + keyRef }
    );
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      logJson("warn", "keystore PUT unexpected status", {
        key: keyRef,
        status: res.statusCode,
      });
      return false;
    }
    return true;
  } catch (err) {
    logJson("error", "keystore PUT failed", {
      key: keyRef,
      error: err.message,
    });
    return false;
  }
}

async function keystoreCreate(keyRef, value) {
  try {
    const res = await httpRequest("POST", API_URL + "/api/v1/keys", {
      ref: keyRef,
      owner_type: "sensor",
      owner_sensor_ref: SENSOR_REF,
      name: "Counter: " + keyRef,
      value: String(value),
      encrypted: false,
    });
    if (res.statusCode === 200 || res.statusCode === 201) {
      return true;
    }
    if (res.statusCode === 409) {
      // Key already exists (race condition) — update instead
      return await keystorePut(keyRef, value);
    }
    logJson("warn", "keystore POST unexpected status", {
      key: keyRef,
      status: res.statusCode,
    });
    return false;
  } catch (err) {
    logJson("error", "keystore POST failed", {
      key: keyRef,
      error: err.message,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

async function emitEvent(payload, ruleRef) {
  const body = {
    trigger_type: TRIGGER_TYPE,
    payload: payload,
    trigger_instance_id: "rule_" + ruleRef,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await httpRequest("POST", API_URL + "/api/v1/events", body);
      if (res.statusCode === 200 || res.statusCode === 201) {
        return true;
      }
      logJson("warn", "event POST unexpected status", {
        status: res.statusCode,
        attempt: attempt + 1,
        rule_ref: ruleRef,
      });
    } catch (err) {
      logJson("error", "event POST failed", {
        error: err.message,
        attempt: attempt + 1,
      });
    }
    // Exponential backoff
    await sleep(500 * Math.pow(2, attempt));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Per-rule counter
// ---------------------------------------------------------------------------

class RuleCounter {
  /**
   * @param {number} ruleId
   * @param {string} ruleRef
   * @param {object} triggerParams
   */
  constructor(ruleId, ruleRef, triggerParams) {
    this.ruleId = ruleId;
    this.ruleRef = ruleRef;
    this.interval = (triggerParams && triggerParams.interval_seconds) || DEFAULT_INTERVAL;
    this.keyRef = KEY_PREFIX + "." + ruleRef.replace(/\./g, "_");
    this._timer = null;
    this._stopped = false;
    this._ticking = false;
  }

  start() {
    if (this._timer !== null) {
      return;
    }
    this._stopped = false;
    this._scheduleTick();
    logJson("info", "counter started", {
      rule_id: this.ruleId,
      rule_ref: this.ruleRef,
      interval: this.interval,
    });
  }

  stop() {
    this._stopped = true;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    logJson("info", "counter stopped", {
      rule_id: this.ruleId,
      rule_ref: this.ruleRef,
    });
  }

  _scheduleTick() {
    if (this._stopped) return;
    const self = this;
    this._timer = setTimeout(function () {
      self._timer = null;
      if (self._stopped) return;
      self._ticking = true;
      self
        ._tick()
        .catch(function (err) {
          logJson("error", "counter tick failed", {
            rule_ref: self.ruleRef,
            error: err.message,
          });
        })
        .then(function () {
          self._ticking = false;
          self._scheduleTick();
        });
    }, this.interval * 1000);
  }

  async _tick() {
    // Read current value from keystore
    const raw = await keystoreGet(this.keyRef);
    let counter = 0;
    if (raw !== null) {
      const parsed = parseInt(raw, 10);
      counter = isNaN(parsed) ? 0 : parsed;
    }

    // Increment
    counter += 1;

    // Write back to keystore
    if (raw === null) {
      await keystoreCreate(this.keyRef, counter);
    } else {
      await keystorePut(this.keyRef, counter);
    }

    // Build event payload
    const payload = {
      counter: counter,
      rule_ref: this.ruleRef,
      sensor_ref: SENSOR_REF,
      fired_at: new Date().toISOString(),
    };

    // Emit event
    await emitEvent(payload, this.ruleRef);
  }
}

// ---------------------------------------------------------------------------
// Rule manager
// ---------------------------------------------------------------------------

class RuleManager {
  constructor() {
    /** @type {Map<number, RuleCounter>} */
    this._rules = new Map();
  }

  handleMessage(message) {
    const eventType = message.event_type || "";
    const ruleId = message.rule_id;
    const ruleRef = message.rule_ref || "rule_" + ruleId;
    const triggerType = message.trigger_type || "";
    const triggerParams = message.trigger_params || {};

    // Only handle messages for our trigger type
    if (triggerType && triggerType !== TRIGGER_TYPE) {
      return;
    }

    if (eventType === "RuleCreated" || eventType === "RuleEnabled") {
      this._startRule(ruleId, ruleRef, triggerParams);
    } else if (eventType === "RuleDisabled" || eventType === "RuleDeleted") {
      this._stopRule(ruleId);
    } else {
      logJson("debug", "ignoring unknown event_type", {
        event_type: eventType,
      });
    }
  }

  _startRule(ruleId, ruleRef, triggerParams) {
    if (this._rules.has(ruleId)) {
      // Already tracking — restart with potentially new params
      this._rules.get(ruleId).stop();
    }
    const rc = new RuleCounter(ruleId, ruleRef, triggerParams);
    this._rules.set(ruleId, rc);
    rc.start();
  }

  _stopRule(ruleId) {
    const rc = this._rules.get(ruleId);
    if (rc) {
      rc.stop();
      this._rules.delete(ruleId);
    }
  }

  stopAll() {
    for (const [_id, rc] of this._rules) {
      rc.stop();
    }
    this._rules.clear();
  }

  get activeCount() {
    return this._rules.size;
  }
}

// ---------------------------------------------------------------------------
// RabbitMQ consumer
// ---------------------------------------------------------------------------

async function startMqConsumer(ruleManager, shutdownSignal) {
  const queueName = "sensor." + SENSOR_REF;

  while (!shutdownSignal.stopped) {
    let connection = null;
    let channel = null;
    try {
      logJson("info", "connecting to RabbitMQ", { url: MQ_URL });
      connection = await amqplib.connect(MQ_URL, { heartbeat: 30 });

      connection.on("error", function (err) {
        logJson("warn", "RabbitMQ connection error", { error: err.message });
      });
      connection.on("close", function () {
        logJson("debug", "RabbitMQ connection closed");
      });

      channel = await connection.createChannel();

      // Declare exchange (idempotent)
      await channel.assertExchange(MQ_EXCHANGE, "topic", { durable: true });

      // Declare and bind queue
      await channel.assertQueue(queueName, { durable: true });
      for (const rk of ROUTING_KEYS) {
        await channel.bindQueue(queueName, MQ_EXCHANGE, rk);
      }

      logJson("info", "RabbitMQ connected, consuming", { queue: queueName });

      // Set up consumer
      await channel.consume(
        queueName,
        function (msg) {
          if (msg === null) return; // consumer cancelled

          try {
            const message = JSON.parse(msg.content.toString("utf8"));
            logJson("debug", "received MQ message", {
              event_type: message.event_type,
            });
            ruleManager.handleMessage(message);
          } catch (err) {
            if (err instanceof SyntaxError) {
              logJson("warn", "invalid JSON in MQ message", {
                body: msg.content.toString("utf8").slice(0, 200),
              });
            } else {
              logJson("error", "error processing MQ message", {
                error: err.message,
              });
            }
          }

          channel.ack(msg);
        },
        { noAck: false }
      );

      // Wait until shutdown or connection drops
      await new Promise(function (resolve) {
        function onShutdown() {
          resolve();
        }
        shutdownSignal.once("shutdown", onShutdown);
        connection.once("close", function () {
          shutdownSignal.removeListener("shutdown", onShutdown);
          resolve();
        });
      });
    } catch (err) {
      logJson("warn", "RabbitMQ error, retrying in 5s", {
        error: err.message,
      });
    } finally {
      if (channel) {
        try {
          await channel.close();
        } catch (_e) {
          // ignore
        }
      }
      if (connection) {
        try {
          await connection.close();
        } catch (_e) {
          // ignore
        }
      }
    }

    if (!shutdownSignal.stopped) {
      await sleep(5000);
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap: fetch existing active rules on startup
// ---------------------------------------------------------------------------

async function fetchActiveRules(ruleManager) {
  try {
    const reqUrl =
      API_URL +
      "/api/v1/rules?trigger_ref=" +
      encodeURIComponent(TRIGGER_TYPE) +
      "&enabled=true";
    const res = await httpRequest("GET", reqUrl);

    if (res.statusCode !== 200) {
      logJson("warn", "failed to fetch active rules", {
        status: res.statusCode,
      });
      return;
    }

    const rules =
      res.body && Array.isArray(res.body.data) ? res.body.data : [];

    for (const rule of rules) {
      const ruleId = rule.id;
      const ruleRef = rule.ref || "rule_" + ruleId;
      const enabled = rule.enabled !== false;
      if (ruleId && enabled) {
        ruleManager.handleMessage({
          event_type: "RuleCreated",
          rule_id: ruleId,
          rule_ref: ruleRef,
          trigger_type: TRIGGER_TYPE,
          trigger_params: rule.trigger_params || {},
        });
      }
    }

    logJson("info", "bootstrapped active rules", { count: rules.length });
  } catch (err) {
    logJson("warn", "could not fetch active rules on startup", {
      error: err.message,
    });
  }
}

// ---------------------------------------------------------------------------
// Shutdown signal (simple EventEmitter-like)
// ---------------------------------------------------------------------------

const EventEmitter = require("events");

class ShutdownSignal extends EventEmitter {
  constructor() {
    super();
    this.stopped = false;
  }

  trigger() {
    if (this.stopped) return;
    this.stopped = true;
    this.emit("shutdown");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  logJson("info", "sensor starting", {
    sensor_ref: SENSOR_REF,
    api_url: API_URL,
  });

  const shutdownSignal = new ShutdownSignal();
  const ruleManager = new RuleManager();

  // Handle termination signals
  function onSignal(sig) {
    logJson("info", "shutdown signal received", { signal: sig });
    shutdownSignal.trigger();
  }
  process.on("SIGTERM", function () {
    onSignal("SIGTERM");
  });
  process.on("SIGINT", function () {
    onSignal("SIGINT");
  });

  // Bootstrap: load already-active rules from the API
  await fetchActiveRules(ruleManager);

  // Start RabbitMQ consumer (runs until shutdown)
  const mqPromise = startMqConsumer(ruleManager, shutdownSignal);

  logJson("info", "sensor running", {
    active_rules: ruleManager.activeCount,
  });

  // Heartbeat loop in the main flow
  while (!shutdownSignal.stopped) {
    await new Promise(function (resolve) {
      const timer = setTimeout(resolve, 10000);
      shutdownSignal.once("shutdown", function () {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!shutdownSignal.stopped) {
      logJson("debug", "heartbeat", {
        active_rules: ruleManager.activeCount,
      });
    }
  }

  // Graceful shutdown
  logJson("info", "shutting down", {
    active_rules: ruleManager.activeCount,
  });
  ruleManager.stopAll();

  // Give MQ consumer a moment to clean up
  await Promise.race([mqPromise, sleep(5000)]);

  logJson("info", "sensor stopped");
  process.exit(0);
}

main().catch(function (err) {
  logJson("error", "fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
