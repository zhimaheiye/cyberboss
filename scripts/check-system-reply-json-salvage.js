#!/usr/bin/env node
/**
 * Tiny self-check: system reply JSON salvage must accept trailing junk
 * and still resolve send_message / silent without inventing actions.
 */
const assert = require("assert");
const {
  resolveSystemReplyDelivery,
  extractSystemActionJsonCandidate,
} = require("../src/core/stream-delivery");

const policy = {
  runtimeId: "claudecode",
  allowPlainTextSendMessage: false,
  maxPlainTextLength: 280,
  maxPlainTextLines: 3,
};

function check(name, input, expectedKind, expectedMessage) {
  const resolved = resolveSystemReplyDelivery(input, policy);
  assert.equal(resolved.kind, expectedKind, `${name}: kind`);
  if (expectedKind === "send_message") {
    assert.equal(resolved.message, expectedMessage, `${name}: message`);
  }
  console.log(`ok  ${name} -> ${resolved.kind}${resolved.message ? ` ${JSON.stringify(resolved.message)}` : ""}`);
}

check(
  "trailing bracket",
  '{"action":"send_message","message":"x"}]',
  "send_message",
  "x"
);
check(
  "fenced with trailing tokens",
  "```json\n{\"action\":\"send_message\",\"message\":\"x\"}\n```\n<total_tokens>42</total_tokens>",
  "send_message",
  "x"
);
check(
  "fenced with stray }]",
  "```json\n{\"action\":\"send_message\",\"message\":\"在呢\"}\n```\n}]",
  "send_message",
  "在呢"
);
check("clean silent", '{"action":"silent"}', "silent");
check("empty", "", "invalid");
check("garbage", "not json", "invalid");
check("no invent from unrelated object", '{"foo":1}]', "invalid");

const salvaged = extractSystemActionJsonCandidate(
  'noise {"action":"send_message","message":"hi"}] footer'
);
assert.equal(salvaged, '{"action":"send_message","message":"hi"}');
console.log("ok  extract candidate from surrounding noise");

console.log("\nAll system-reply JSON salvage checks passed.");
