/**
 * Sanitization utility for redaction of secrets, tokens, and sensitive URLs
 * in runtime logs and incident reports.
 */

function sanitizeText(text) {
  if (typeof text !== "string") {
    return "";
  }
  let result = text;

  // Redact Bearer tokens
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>");

  // Redact OpenAI / Anthropic / general API keys like sk-...
  result = result.replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/gi, "sk-<redacted>");

  // Redact Basic Auth or credentials embedded in URLs: http://user:pass@host
  result = result.replace(/(https?:\/\/)[^\s:@]+:[^\s:@]+@/gi, "$1<redacted>@");

  // Redact secret query params or key-value pairs: code=..., token=..., key=..., secret=...
  result = result.replace(/(\b(?:code|token|access_token|refresh_token|secret|client_secret|key|api_key|apiKey|password)=)[^&\s"']+/gi, "$1<redacted>");

  // Redact JSON fields containing tokens or secrets
  result = result.replace(/"(access_token|refresh_token|token|secret|client_secret|apiKey|api_key|password)"\s*:\s*"[^"]+"/gi, '"$1":"<redacted>"');

  return result;
}

module.exports = {
  sanitizeText,
};
