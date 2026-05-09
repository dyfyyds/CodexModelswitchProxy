export function resolveRoute(config, requestedModel) {
  const model = requestedModel || config.defaultModel;
  const route = config.models[model];

  if (route) {
    return {
      publicModel: model,
      upstreamModel: route.upstreamModel || model,
      provider: config.providers[route.provider],
      providerId: route.provider
    };
  }

  if (config.allowDirectModels && config.defaultProvider && config.providers[config.defaultProvider]) {
    return {
      publicModel: model,
      upstreamModel: model,
      provider: config.providers[config.defaultProvider],
      providerId: config.defaultProvider
    };
  }

  const known = Object.keys(config.models).join(", ");
  throw Object.assign(new Error(`Unknown model "${model}". Known models: ${known}`), { statusCode: 400 });
}

export function responsesToChatBody(body, upstreamModel) {
  const messages = [];

  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  messages.push(...inputToMessages(body.input));

  const chatBody = {
    model: upstreamModel,
    messages,
    stream: Boolean(body.stream)
  };

  // Request usage in final stream chunk
  if (chatBody.stream) {
    chatBody.stream_options = { include_usage: true };
  }

  // Disable DeepSeek thinking mode — Responses API has no way to pass back
  // reasoning_content across turns, which DeepSeek requires in multi-turn conversations
  chatBody.thinking = { type: "disabled" };

  copyIfDefined(body, chatBody, "temperature");
  copyIfDefined(body, chatBody, "top_p");
  copyIfDefined(body, chatBody, "presence_penalty");
  copyIfDefined(body, chatBody, "frequency_penalty");
  copyIfDefined(body, chatBody, "stop");
  copyIfDefined(body, chatBody, "seed");
  copyIfDefined(body, chatBody, "user");

  if (body.max_output_tokens !== undefined) {
    chatBody.max_tokens = body.max_output_tokens;
  } else {
    copyIfDefined(body, chatBody, "max_tokens");
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chatBody.tools = body.tools.map(responseToolToChatTool).filter(Boolean);
  }

  if (body.tool_choice) {
    chatBody.tool_choice = responseToolChoiceToChatToolChoice(body.tool_choice);
  }

  return chatBody;
}

export function chatCompletionToResponse(chat, publicModel) {
  const choice = chat.choices?.[0] || {};
  const message = choice.message || {};
  const text = contentToText(message.content);
  const output = [];

  if (text) {
    output.push({
      id: `msg_${chat.id || randomId()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }]
    });
  }

  for (const toolCall of message.tool_calls || []) {
    if (toolCall.type !== "function") {
      continue;
    }

    output.push({
      id: toolCall.id || `call_${randomId()}`,
      type: "function_call",
      status: "completed",
      call_id: toolCall.id || `call_${randomId()}`,
      name: toolCall.function?.name || "",
      arguments: toolCall.function?.arguments || ""
    });
  }

  return {
    id: chat.id?.startsWith("resp_") ? chat.id : `resp_${chat.id || randomId()}`,
    object: "response",
    created_at: chat.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: publicModel,
    output,
    output_text: text,
    usage: chat.usage || null
  };
}

export function inputToMessages(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  const messages = [];
  let pendingToolCalls = null;

  function flushToolCalls() {
    if (pendingToolCalls && pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: pendingToolCalls
      });
      pendingToolCalls = null;
    }
  }

  for (const item of input) {
    if (typeof item === "string") {
      flushToolCalls();
      messages.push({ role: "user", content: item });
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "message" || item.role) {
      flushToolCalls();
      messages.push({
        role: normalizeRole(item.role || "user"),
        content: responseContentToChatContent(item.content)
      });
      continue;
    }

    if (item.type === "function_call_output") {
      flushToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")
      });
      continue;
    }

    if (item.type === "function_call") {
      // Accumulate consecutive function_calls into a single assistant message
      if (!pendingToolCalls) {
        pendingToolCalls = [];
      }
      pendingToolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments || "{}"
        }
      });
    }
  }

  flushToolCalls();
  return messages;
}

function responseContentToChatContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
    } else if (part?.type === "input_text" || part?.type === "output_text") {
      parts.push({ type: "text", text: part.text || "" });
    } else if (part?.type === "text") {
      parts.push({ type: "text", text: part.text || "" });
    } else if (part?.type === "input_image" && part.image_url) {
      parts.push({ type: "image_url", image_url: { url: part.image_url } });
    }
  }

  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

function responseToolToChatTool(tool) {
  if (tool.type === "function" && tool.function) {
    return tool;
  }

  if (tool.type === "function" && tool.name) {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || {}
      }
    };
  }

  return null;
}

function responseToolChoiceToChatToolChoice(toolChoice) {
  if (typeof toolChoice === "string") {
    return toolChoice;
  }

  if (toolChoice?.type === "function" && toolChoice.name) {
    return {
      type: "function",
      function: { name: toolChoice.name }
    };
  }

  return toolChoice;
}

function copyIfDefined(source, target, key) {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function normalizeRole(role) {
  if (role === "developer") {
    return "system";
  }
  if (["system", "assistant", "user", "tool"].includes(role)) {
    return role;
  }
  return "user";
}

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => part?.text || "").join("");
}

function randomId() {
  return Math.random().toString(36).slice(2);
}

