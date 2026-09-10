const scenario = process.env.TEST_SCENARIO || "default";

async function main() {
  switch (scenario) {
    case "success_exit_0":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "SUCCESS",
          response: "scenario 1 success response",
          num_turns: 1,
          usage: { total_tokens: 42 }
        }
      }));
      process.exit(0);
      break;

    case "success_exit_1":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "SUCCESS",
          response: "scenario 2 success response despite exit 1",
          num_turns: 1,
          usage: { total_tokens: 88 }
        }
      }));
      process.stderr.write('Failed to close MCP instance "MaaMCP": exit status 1\nLanguage server shutdown timed out\n');
      process.exit(1);
      break;

    // 3. status missing + valid response + conversationId + exit 0
    case "status_missing_exit_0":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          response: "{\"action\":\"silent\"}",
          num_turns: 1,
          usage: { total_tokens: 15 }
        }
      }));
      process.exit(0);
      break;

    // 4. status missing + valid response + teardown exit 1
    case "status_missing_exit_1":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          response: "{\"action\":\"send_message\",\"message\":\"醒啦？今天这一觉睡得挺沉\"}",
          num_turns: 1,
          usage: { total_tokens: 25 }
        }
      }));
      process.stderr.write('Failed to close MCP instance "fastctx": exit status 1\nLanguage server shutdown timed out\n');
      process.exit(1);
      break;

    // 5. Confirmed success statuses: DONE and COMPLETED
    case "status_done_exit_0":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "DONE",
          response: "done status result",
          num_turns: 1
        }
      }));
      process.exit(0);
      break;

    case "status_completed_exit_0":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "COMPLETED",
          response: "completed status result",
          num_turns: 1
        }
      }));
      process.exit(0);
      break;

    // 6. FAILED + response
    case "failed_result_exit_0":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "FAILED",
          response: "{\"action\":\"silent\"}"
        }
      }));
      process.exit(0);
      break;

    case "failed_result_exit_1":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "FAILED",
          error: "model quota exceeded or turn failed"
        }
      }));
      process.stderr.write("turn failed with status FAILED\n");
      process.exit(1);
      break;

    // 7. ERROR + error
    case "error_result_exit_1":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "ERROR",
          error: "internal language server error"
        }
      }));
      process.stderr.write("language server internal error\n");
      process.exit(1);
      break;

    // 8. Unknown non-empty status: WEIRD_STATE
    case "unsupported_status_weird":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "WEIRD_STATE",
          response: "some unexpected state payload"
        }
      }));
      process.exit(0);
      break;

    // 9. No result + exit 0
    case "no_result_exit_0":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      process.exit(0);
      break;

    // 10. No result + exit 1
    case "no_result_exit_1":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      process.stderr.write("fatal error: crashed before emitting result\n");
      process.exit(1);
      break;

    // 11. Conversation mismatch
    case "conversation_mismatch":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-unexpected-999" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-unexpected-999",
          status: "SUCCESS",
          response: "mismatched conversation"
        }
      }));
      process.exit(0);
      break;

    // 12. Malformed stdout
    case "malformed_stdout":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log("NOT_JSON_OUTPUT_LINE_HERE");
      process.exit(1);
      break;

    // 13. Blocked persistent tool
    case "blocked_tool":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "step_update",
        tool_name: "schedule",
        tool_input: { DurationSeconds: 60 }
      }));
      await sleep(20);
      console.log(JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "SUCCESS",
          response: "should not reach this"
        }
      }));
      process.exit(0);
      break;

    default:
      console.error(`Unknown scenario: ${scenario}`);
      process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
