import { chatCompletionToResponse } from "./adapters.js";

export async function pipeUpstreamStream(upstreamResponse, downstreamResponse) {
  downstreamResponse.writeHead(upstreamResponse.status, streamHeaders(upstreamResponse.headers));

  for await (const chunk of upstreamResponse.body) {
    downstreamResponse.write(chunk);
  }

  downstreamResponse.end();
}

export async function pipeChatStreamAsResponses(upstreamResponse, downstreamResponse, publicModel) {
  downstreamResponse.writeHead(upstreamResponse.status, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  if (!upstreamResponse.ok) {
    downstreamResponse.write(await upstreamResponse.text());
    downstreamResponse.end();
    return;
  }

  const responseId = `resp_${Date.now().toString(36)}`;
  const msgItemId = `msg_${Date.now().toString(36)}`;

  let fullText = "";
  let toolCalls = {};
  let emittedMessage = false;
  let seq = 0;

  // response.created
  emit(downstreamResponse, "response.created", {
    type: "response.created",
    sequence_number: ++seq,
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model: publicModel,
      output: []
    }
  });

  let buffer = "";

  for await (const chunk of upstreamResponse.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;

      if (data === "[DONE]") {
        finishStream(downstreamResponse, publicModel, responseId, msgItemId,
          fullText, toolCalls, emittedMessage, seq);
        downstreamResponse.end();
        return;
      }

      const parsed = safeJson(data);
      if (!parsed) continue;

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta || {};

      // Skip reasoning_content — Codex may not support reasoning events
      // Just accumulate silently, it still counts toward usage

      // Content (text output)
      if (delta.content) {
        if (!emittedMessage) {
          emit(downstreamResponse, "response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: ++seq,
            output_index: 0,
            item: {
              type: "message",
              id: msgItemId,
              status: "in_progress",
              role: "assistant",
              content: []
            }
          });
          emittedMessage = true;
        }
        fullText += delta.content;
        emit(downstreamResponse, "response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: ++seq,
          item_id: msgItemId,
          output_index: 0,
          content_index: 0,
          delta: delta.content
        });
      }

      // Tool calls (function call deltas)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: "", name: "", arguments: "" };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }
    }
  }

  // Stream ended without [DONE]
  finishStream(downstreamResponse, publicModel, responseId, msgItemId,
    fullText, toolCalls, emittedMessage, seq);
  downstreamResponse.end();
}

function finishStream(response, publicModel, responseId, msgItemId,
  fullText, toolCalls, emittedMessage, seq) {

  const output = [];

  // Close message item
  if (emittedMessage) {
    emit(response, "response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: ++seq,
      output_index: 0,
      item: {
        type: "message",
        id: msgItemId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: fullText }]
      }
    });
    output.push({
      type: "message",
      id: msgItemId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: fullText }]
    });
  }

  // Emit tool call items
  const baseIndex = emittedMessage ? 1 : 0;
  for (const [idx, tc] of Object.entries(toolCalls)) {
    const relIdx = Number(idx);
    const outputIndex = baseIndex + relIdx;
    const callId = tc.id || `call_${responseId}_${relIdx}`;
    const itemId = `fc_${callId}`;

    emit(response, "response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: ++seq,
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: itemId,
        call_id: callId,
        name: tc.name,
        arguments: "",
        status: "in_progress"
      }
    });

    if (tc.arguments) {
      emit(response, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: ++seq,
        item_id: itemId,
        output_index: outputIndex,
        delta: tc.arguments
      });
    }

    emit(response, "response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: ++seq,
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: itemId,
        call_id: callId,
        name: tc.name,
        arguments: tc.arguments,
        status: "completed"
      }
    });

    output.push({
      type: "function_call",
      id: itemId,
      call_id: callId,
      name: tc.name,
      arguments: tc.arguments,
      status: "completed"
    });
  }

  // response.completed
  emit(response, "response.completed", {
    type: "response.completed",
    sequence_number: ++seq,
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: publicModel,
      output,
      output_text: fullText
    }
  });

  response.write("data: [DONE]\n\n");
}

export function emit(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamHeaders(headers) {
  const result = {
    "Content-Type": headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  };

  const requestId = headers.get("x-request-id");
  if (requestId) {
    result["X-Upstream-Request-Id"] = requestId;
  }

  return result;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
