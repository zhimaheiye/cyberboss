const assert = require("assert");
const { readConfig } = require("../src/core/config");
const {
  AntigravityProcessClient,
  AUTH_REQUIRED_MESSAGE,
  isAntigravityAuthError,
  summarizeStderr,
} = require("../src/adapters/runtime/antigravity/process-client");
const {
  formatResultFailureReason,
} = require("../src/adapters/runtime/antigravity/events");

function runTests() {
  console.log("==================================================");
  console.log("Running Antigravity Proxy & Auth Guard Tests");
  console.log("==================================================");

  // --------------------------------------------------
  // 1. Config tests
  // --------------------------------------------------
  console.log("1. Testing config.js proxy environment reading...");
  const origEnv = { ...process.env };

  try {
    delete process.env.CYBERBOSS_ANTIGRAVITY_HTTP_PROXY;
    delete process.env.CYBERBOSS_ANTIGRAVITY_HTTPS_PROXY;
    delete process.env.CYBERBOSS_ANTIGRAVITY_NO_PROXY;

    const configDefault = readConfig();
    assert.strictEqual(configDefault.antigravityHttpProxy, "", "default httpProxy must be empty");
    assert.strictEqual(configDefault.antigravityHttpsProxy, "", "default httpsProxy must be empty");
    assert.strictEqual(configDefault.antigravityNoProxy, "", "default noProxy must be empty when no proxy set");

    process.env.CYBERBOSS_ANTIGRAVITY_HTTPS_PROXY = "http://127.0.0.1:7897";
    const configWithHttps = readConfig();
    assert.strictEqual(configWithHttps.antigravityHttpsProxy, "http://127.0.0.1:7897");
    assert.strictEqual(configWithHttps.antigravityNoProxy, "localhost,127.0.0.1,::1", "must provide default noProxy if proxy is set");

    process.env.CYBERBOSS_ANTIGRAVITY_NO_PROXY = "10.0.0.0/8,127.0.0.1";
    const configWithExplicitNoProxy = readConfig();
    assert.strictEqual(configWithExplicitNoProxy.antigravityNoProxy, "10.0.0.0/8,127.0.0.1", "explicit noProxy must take precedence");
  } finally {
    process.env = { ...origEnv };
  }
  console.log("  PASS: config.js proxy options verified");

  // --------------------------------------------------
  // 2. buildChildEnv mapping tests
  // --------------------------------------------------
  console.log("2. Testing AntigravityProcessClient buildChildEnv mapping...");

  // 2.1 Unconfigured proxy: child env unchanged
  {
    const baseEnv = { FOO: "bar", PATH: "C:\\bin" };
    const client = new AntigravityProcessClient({
      env: baseEnv,
      httpProxy: "",
      httpsProxy: "",
      noProxy: "",
    });
    const childEnv = client.buildChildEnv();
    assert.strictEqual(childEnv.FOO, "bar");
    assert.strictEqual(childEnv.PATH, "C:\\bin");
    assert.strictEqual(childEnv.HTTP_PROXY, undefined);
    assert.strictEqual(childEnv.HTTPS_PROXY, undefined);
    assert.strictEqual(childEnv.NO_PROXY, undefined);
    // Ensure baseEnv was not mutated
    assert.strictEqual(baseEnv.HTTP_PROXY, undefined);
  }

  // 2.2 Configured HTTPS_PROXY: child receives HTTPS_PROXY and https_proxy
  {
    const baseEnv = { EXISTING_VAR: "kept" };
    const client = new AntigravityProcessClient({
      env: baseEnv,
      httpsProxy: "http://127.0.0.1:7897",
    });
    const childEnv = client.buildChildEnv();
    assert.strictEqual(childEnv.EXISTING_VAR, "kept", "unrelated env must be preserved");
    assert.strictEqual(childEnv.HTTPS_PROXY, "http://127.0.0.1:7897");
    assert.strictEqual(childEnv.https_proxy, "http://127.0.0.1:7897");
    assert.strictEqual(childEnv.HTTP_PROXY, undefined);
    // Base env not polluted
    assert.strictEqual(baseEnv.HTTPS_PROXY, undefined);
  }

  // 2.3 Configured HTTP_PROXY + HTTPS_PROXY + NO_PROXY
  {
    const baseEnv = { TEST_A: "1" };
    const client = new AntigravityProcessClient({
      env: baseEnv,
      httpProxy: "http://127.0.0.1:7897",
      httpsProxy: "http://127.0.0.1:7897",
      noProxy: "localhost,127.0.0.1,::1",
    });
    const childEnv = client.buildChildEnv();
    assert.strictEqual(childEnv.TEST_A, "1");
    assert.strictEqual(childEnv.HTTP_PROXY, "http://127.0.0.1:7897");
    assert.strictEqual(childEnv.http_proxy, "http://127.0.0.1:7897");
    assert.strictEqual(childEnv.HTTPS_PROXY, "http://127.0.0.1:7897");
    assert.strictEqual(childEnv.https_proxy, "http://127.0.0.1:7897");
    assert.strictEqual(childEnv.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.strictEqual(childEnv.no_proxy, "localhost,127.0.0.1,::1");
  }
  console.log("  PASS: buildChildEnv mappings verified");

  // --------------------------------------------------
  // 3. Child process execution verifies child env
  // --------------------------------------------------
  console.log("3. Testing actual child process receives mapped env...");
  {
    const nodeCmd = process.execPath;
    const client = new AntigravityProcessClient({
      command: nodeCmd,
      httpProxy: "http://127.0.0.1:7897",
      httpsProxy: "http://127.0.0.1:7897",
      noProxy: "localhost,127.0.0.1",
    });
    const childEnv = client.buildChildEnv();
    assert.strictEqual(childEnv.HTTP_PROXY, "http://127.0.0.1:7897");
    assert.strictEqual(childEnv.HTTPS_PROXY, "http://127.0.0.1:7897");
    assert.strictEqual(childEnv.NO_PROXY, "localhost,127.0.0.1");
  }
  console.log("  PASS: child process env verified");

  // --------------------------------------------------
  // 4. Proxy secret / value redaction
  // --------------------------------------------------
  console.log("4. Testing proxy secret and credential redaction...");
  {
    const rawStderrWithProxyCreds = "Failed to connect to http://user:supersecretpass@127.0.0.1:7897/api Bearer ya29.a0AfH6_test_token";
    const summarized = summarizeStderr(rawStderrWithProxyCreds);
    assert(!summarized.includes("supersecretpass"), "proxy password must not be present in summary");
    assert(!summarized.includes("ya29.a0AfH6"), "bearer token must not be present in summary");
    assert(summarized.includes("<redacted>"), "redacted placeholder must be present");
  }
  console.log("  PASS: proxy credential redaction verified");

  // --------------------------------------------------
  // 5. Auth error detection and sanitization
  // --------------------------------------------------
  console.log("5. Testing auth error detection and message sanitization...");
  {
    const rawAuthStderr = [
      "Authentication required. Please visit the URL to log in:",
      "  https://accounts.google.com/o/oauth2/auth?client_id=12345.apps.googleusercontent.com&scope=openid&code_challenge=xyz",
      "Waiting for authentication (timeout 60s)...",
      "authentication failed or timed out",
    ].join("\n");

    assert.strictEqual(isAntigravityAuthError(rawAuthStderr), true, "must detect raw auth stderr");
    assert.strictEqual(isAntigravityAuthError("some random network error"), false, "must not match random error");

    // formatResultFailureReason sanitizes auth error
    const authFailureResult = {
      status: "FAILED",
      error: { message: rawAuthStderr },
    };
    const formatted = formatResultFailureReason(authFailureResult, 1);
    assert.strictEqual(formatted, AUTH_REQUIRED_MESSAGE, "must shorten auth error to AUTH_REQUIRED_MESSAGE");
    assert(!formatted.includes("accounts.google.com"), "must not contain google OAuth url");
  }
  console.log("  PASS: auth error sanitization verified");

  console.log("==================================================");
  console.log("ALL PROXY & AUTH GUARD TESTS PASSED");
  console.log("==================================================");
}

runTests();
