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

    case "no_result_exit_1":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      process.stderr.write("fatal error: crashed before emitting result\n");
      process.exit(1);
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

    case "malformed_stdout":
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-123" }));
      await sleep(20);
      console.log("NOT_JSON_OUTPUT_LINE_HERE");
      process.exit(1);
      break;

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
