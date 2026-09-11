/**
 * Antigravity Error Classifier & Tool Activity Detector.
 */

const STREAM_INTERRUPTED_PATTERN = /(?:the stream was interrupted|stream(?: was)? interrupted|stream interruption)/i;
const AUTH_REQUIRED_PATTERN = /(?:Authentication required|authentication failed or timed out|not logged into Antigravity)/i;
const TLS_TIMEOUT_PATTERN = /(?:TLS handshake timeout|net\/http: TLS handshake timeout)/i;
const PROXY_REFUSED_PATTERN = /(?:proxyconnect tcp|actively refused it|connection refused)/i;
const ELIGIBILITY_FAILED_PATTERN = /(?:eligibility check failed|failed to get profile picture)/i;
const BLOCKED_TOOL_PATTERN = /(?:unsupported persistent tool)/i;
const TIMEOUT_PATTERN = /(?:antigravity turn timed out|timed out after)/i;

function extractErrorMessage(errorOrResult) {
  if (!errorOrResult) {
    return "";
  }
  if (typeof errorOrResult === "string") {
    return errorOrResult.trim();
  }
  if (errorOrResult instanceof Error) {
    return (errorOrResult.message || "").trim();
  }
  if (typeof errorOrResult === "object") {
    if (typeof errorOrResult.error === "string") {
      return errorOrResult.error.trim();
    }
    if (errorOrResult.error && typeof errorOrResult.error === "object") {
      if (typeof errorOrResult.error.message === "string") {
        return errorOrResult.error.message.trim();
      }
      try {
        return JSON.stringify(errorOrResult.error);
      } catch {
        return String(errorOrResult.error);
      }
    }
    if (typeof errorOrResult.message === "string") {
      return errorOrResult.message.trim();
    }
    if (typeof errorOrResult.status === "string") {
      return `status: ${errorOrResult.status}`;
    }
  }
  return String(errorOrResult).trim();
}

function classifyAntigravityFailure(errorOrResult) {
  const message = extractErrorMessage(errorOrResult);

  if (STREAM_INTERRUPTED_PATTERN.test(message)) {
    return {
      code: "STREAM_INTERRUPTED",
      retryable: true,
      message,
    };
  }

  if (AUTH_REQUIRED_PATTERN.test(message)) {
    return {
      code: "AUTH_REQUIRED",
      retryable: false,
      message,
    };
  }

  if (TLS_TIMEOUT_PATTERN.test(message)) {
    return {
      code: "TLS_TIMEOUT",
      retryable: false,
      message,
    };
  }

  if (PROXY_REFUSED_PATTERN.test(message)) {
    return {
      code: "PROXY_REFUSED",
      retryable: false,
      message,
    };
  }

  if (ELIGIBILITY_FAILED_PATTERN.test(message)) {
    return {
      code: "ELIGIBILITY_FAILED",
      retryable: false,
      message,
    };
  }

  if (BLOCKED_TOOL_PATTERN.test(message)) {
    return {
      code: "BLOCKED_TOOL",
      retryable: false,
      message,
    };
  }

  if (TIMEOUT_PATTERN.test(message)) {
    return {
      code: "TIMEOUT",
      retryable: false,
      message,
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    retryable: false,
    message: message || "unknown error",
  };
}

function hasToolCallEvidence(raw) {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const step = raw.step_update || raw.step || raw;

  // Step type explicitly set to "tool"
  if (step.step_type === "tool" || raw.step_type === "tool") {
    return true;
  }

  // Non-empty tool_name
  const toolName = (step.tool_name || raw.tool_name || "").trim();
  if (toolName) {
    return true;
  }

  // tool_calls array with at least one element
  if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
    return true;
  }
  if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
    return true;
  }

  // Tool input or tool result payload
  if (step.tool_input || step.tool_result || step.tool_call_id) {
    return true;
  }

  return false;
}

module.exports = {
  classifyAntigravityFailure,
  hasToolCallEvidence,
  extractErrorMessage,
};
