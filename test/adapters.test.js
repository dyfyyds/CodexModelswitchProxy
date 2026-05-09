import test from "node:test";
import assert from "node:assert/strict";
import { chatCompletionToResponse, responsesToChatBody } from "../src/adapters.js";

test("converts Responses text input to Chat Completions messages", () => {
  const body = responsesToChatBody(
    {
      model: "alias",
      instructions: "You are brief.",
      input: "hello",
      max_output_tokens: 64,
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Lookup something",
          parameters: { type: "object", properties: {} }
        }
      ]
    },
    "upstream-model"
  );

  assert.equal(body.model, "upstream-model");
  assert.deepEqual(body.messages, [
    { role: "system", content: "You are brief." },
    { role: "user", content: "hello" }
  ]);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.tools[0].function.name, "lookup");
});

test("wraps Chat Completions text as a Responses object", () => {
  const response = chatCompletionToResponse(
    {
      id: "chatcmpl_123",
      created: 123,
      choices: [{ message: { content: "done" } }],
      usage: { input_tokens: 1, output_tokens: 1 }
    },
    "alias"
  );

  assert.equal(response.object, "response");
  assert.equal(response.model, "alias");
  assert.equal(response.output_text, "done");
  assert.equal(response.output[0].content[0].text, "done");
});
