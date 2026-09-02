function mapAntigravityMessageToRuntimeEvents(raw, context = {}) {
  if (!raw || typeof raw !== "object") {
    return [];
  }

  const turnId = context.turnId || "";
  const event = raw.event;

  switch (event) {
    case "init": {
      const threadId = raw.conversation_id || context.fallbackThreadId || "";
      if (!threadId) {
        return [];
      }
      return [
        {
          type: "runtime.turn.started",
          payload: {
            threadId,
            turnId,
          },
        },
      ];
    }

    case "step_update": {
      // Stage 2 intentionally ignores step_update events (including agent_response deltas)
      // to rely purely on the stable result.response and prevent duplicate replies.
      return [];
    }

    case "result": {
      const result = raw.result || {};
      const threadId = result.conversation_id || raw.conversation_id || context.fallbackThreadId || "";
      const status = result.status;
      const usage = result.usage;
      const events = [];

      if (usage && typeof usage === "object") {
        events.push({
          type: "runtime.context.updated",
          payload: {
            runtimeId: "antigravity",
            threadId,
            turnId,
            inputTokens: Number(usage.input_tokens) || 0,
            cacheReadInputTokens: Number(usage.cache_read_tokens) || 0,
            outputTokens: Number(usage.output_tokens) || 0,
            reasoningTokens: Number(usage.thinking_tokens) || 0,
            currentTokens: Number(usage.total_tokens) || 0,
          },
        });
      }

      if (status === "SUCCESS") {
        const responseText = typeof result.response === "string" ? result.response.trim() : "";
        if (responseText) {
          events.push({
            type: "runtime.reply.completed",
            payload: {
              threadId,
              turnId,
              itemId: `agy-result-${turnId}`,
              text: responseText,
            },
          });
        }
        events.push({
          type: "runtime.turn.completed",
          payload: {
            threadId,
            turnId,
            text: responseText,
          },
        });
      } else {
        const errorText =
          (typeof result.response === "string" && result.response.trim()) ||
          result.error ||
          result.message ||
          `Antigravity turn failed with status ${status || "UNKNOWN"}`;

        events.push({
          type: "runtime.turn.failed",
          payload: {
            threadId,
            turnId,
            text: String(errorText),
          },
        });
      }

      return events;
    }

    default:
      return [];
  }
}

module.exports = {
  mapAntigravityMessageToRuntimeEvents,
};
