import { describe, expect, it } from "vitest";
import {
  convertRequest,
  convertResponse,
  detectClientProtocol,
  protocolPath,
} from "../src/lib/protocol/index.js";
import {
  chatToolsToAnthropic,
  anthropicToolsToChat,
  chatToolsToResponses,
  responsesToolsToChat,
} from "../src/lib/protocol/tools.js";
import {
  chatRequestToAnthropic,
  chatRequestToResponses,
  anthropicRequestToChat,
} from "../src/lib/protocol/convert-request.js";
import {
  anthropicResponseToChat,
  chatResponseToAnthropic,
  responsesResponseToChat,
  chatResponseToResponses,
} from "../src/lib/protocol/convert-response.js";
import { parseSseChunk, transformSseStream } from "../src/lib/protocol/stream.js";
import type { JsonObject } from "../src/lib/protocol/types.js";

const chatTools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      strict: true,
    },
  },
];

describe("detectClientProtocol", () => {
  it("detects paths", () => {
    expect(detectClientProtocol("/v1/chat/completions")).toBe("chat_completions");
    expect(detectClientProtocol("/v1/responses")).toBe("responses");
    expect(detectClientProtocol("/v1/messages")).toBe("messages");
    expect(detectClientProtocol("/v1/models")).toBeNull();
  });

  it("maps protocol paths", () => {
    expect(protocolPath("chat_completions")).toBe("/v1/chat/completions");
    expect(protocolPath("responses")).toBe("/v1/responses");
    expect(protocolPath("messages")).toBe("/v1/messages");
  });
});

describe("tools conversion", () => {
  it("round-trips chat ↔ anthropic tools", () => {
    const ant = chatToolsToAnthropic(chatTools);
    expect(ant[0].name).toBe("get_weather");
    expect((ant[0].input_schema as { properties: unknown }).properties).toBeTruthy();
    const back = anthropicToolsToChat(ant);
    expect(back[0].type).toBe("function");
    expect((back[0].function as { name: string }).name).toBe("get_weather");
  });

  it("converts chat tools to responses", () => {
    const r = chatToolsToResponses(chatTools);
    expect(r[0]).toMatchObject({
      type: "function",
      name: "get_weather",
      strict: true,
    });
    expect(responsesToolsToChat(r)[0]).toMatchObject({
      function: { strict: true },
    });
  });
});

describe("request conversion with tools", () => {
  const chatBody: JsonObject = {
    model: "grok-4.5",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Weather in SF?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"SF"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"temp":68}',
      },
      { role: "user", content: "Thanks" },
    ],
    tools: chatTools,
    tool_choice: "auto",
    stream: false,
    max_completion_tokens: 1024,
  };

  it("chat → anthropic preserves tools and tool results", () => {
    const ant = chatRequestToAnthropic(chatBody);
    expect(ant.model).toBe("grok-4.5");
    expect(ant.system).toContain("helpful");
    expect(ant.max_tokens).toBe(1024);
    expect(Array.isArray(ant.tools)).toBe(true);
    expect((ant.tools as { name: string }[])[0].name).toBe("get_weather");

    const messages = ant.messages as JsonObject[];
    // should include tool_use assistant and tool_result user
    const flat = JSON.stringify(messages);
    expect(flat).toContain("tool_use");
    expect(flat).toContain("tool_result");
    expect(flat).toContain("call_1");
    expect(flat).toContain("get_weather");
  });

  it("chat → responses preserves function calls", () => {
    const resp = chatRequestToResponses(chatBody);
    expect(resp.instructions).toContain("helpful");
    const input = resp.input as JsonObject[];
    expect(input.some((i) => i.type === "function_call")).toBe(true);
    expect(input.some((i) => i.type === "function_call_output")).toBe(true);
    const call = input.find((i) => i.type === "function_call") as JsonObject;
    expect(call.id).toBe("fc_call_1");
    expect(call.call_id).toBe("call_1");
    expect(call.id).not.toBe(call.call_id);
    expect(call.arguments).toBe('{"city":"SF"}');
    const result = input.find((i) => i.type === "function_call_output") as JsonObject;
    expect(result.call_id).toBe("call_1");
    expect((resp.tools as { name: string }[])[0].name).toBe("get_weather");
  });

  it("anthropic → chat round-trip tool_use", () => {
    const ant = chatRequestToAnthropic(chatBody);
    const back = anthropicRequestToChat(ant);
    const msgs = back.messages as JsonObject[];
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.tool_calls)).toBe(true);
  });

  it("convertRequest matrix", () => {
    const toMsg = convertRequest(chatBody, "chat_completions", "messages");
    expect(toMsg.tools).toBeTruthy();
    const toResp = convertRequest(chatBody, "chat_completions", "responses");
    expect(toResp.input).toBeTruthy();
    const identity = convertRequest(chatBody, "chat_completions", "chat_completions");
    expect(identity.messages).toBeTruthy();
  });
});

describe("response conversion with tools", () => {
  it("anthropic tool_use → chat tool_calls", () => {
    const ant: JsonObject = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus",
      content: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "get_weather",
          input: { city: "SF" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const chat = anthropicResponseToChat(ant);
    const msg = (chat.choices as JsonObject[])[0].message as JsonObject;
    expect(msg.content).toContain("Let me check");
    const tcs = msg.tool_calls as JsonObject[];
    expect(tcs).toHaveLength(1);
    expect((tcs[0].function as JsonObject).name).toBe("get_weather");
    expect((chat.choices as JsonObject[])[0].finish_reason).toBe("tool_calls");
  });

  it("chat tool_calls → anthropic tool_use", () => {
    const chat: JsonObject = {
      id: "chatcmpl_1",
      object: "chat.completion",
      model: "gpt",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_9",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"cmd":"ls"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const ant = chatResponseToAnthropic(chat);
    expect(ant.stop_reason).toBe("tool_use");
    const content = ant.content as JsonObject[];
    expect(content.some((c) => c.type === "tool_use")).toBe(true);
  });

  it("responses function_call → chat tool_calls", () => {
    const resp: JsonObject = {
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "fc_1",
          name: "get_weather",
          arguments: '{"city":"NYC"}',
        },
      ],
      usage: { input_tokens: 5, output_tokens: 6 },
    };
    const chat = responsesResponseToChat(resp);
    const msg = (chat.choices as JsonObject[])[0].message as JsonObject;
    expect(msg.content).toBe("ok");
    expect((msg.tool_calls as unknown[]).length).toBe(1);
  });

  it("chat → responses", () => {
    const chat: JsonObject = {
      id: "chatcmpl_x",
      model: "m",
      choices: [
        {
          message: {
            role: "assistant",
            content: "hi",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const resp = chatResponseToResponses(chat);
    expect(resp.object).toBe("response");
    expect((resp.output as unknown[]).length).toBe(2);
    const call = (resp.output as JsonObject[]).find((item) => item.type === "function_call");
    expect(call).toMatchObject({ id: "fc_c1", call_id: "c1" });
  });

  it("convertResponse matrix", () => {
    const ant: JsonObject = {
      id: "msg",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const chat = convertResponse(ant, "messages", "chat_completions");
    expect((chat.choices as unknown[])?.length).toBe(1);
    const back = convertResponse(chat, "chat_completions", "messages");
    expect(back.type).toBe("message");
  });
});

describe("SSE parse + transform", () => {
  it("parses sse events", () => {
    const { events, rest } = parseSseChunk(
      'event: message_start\ndata: {"type":"message_start"}\n\ndata: [DONE]\n\npartial',
    );
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("message_start");
    expect(events[1].data).toBe("[DONE]");
    expect(rest).toBe("partial");
  });

  it("transforms anthropic SSE to chat SSE with tool_use", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"claude","role":"assistant","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"SF\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });

    const out = transformSseStream(upstream, "messages", "chat_completions");
    const reader = out.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("tool_calls");
    expect(text).toContain("get_weather");
    expect(text).toContain("[DONE]");
    expect(text).toContain("tool_calls");
  });

  it("keeps interleaved Responses tool argument deltas on their own indexes", async () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_multi","model":"m"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_one","call_id":"call_one","name":"one","arguments":""}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_two","call_id":"call_two","name":"two","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_two","delta":"{\\"b\\":"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_one","delta":"{\\"a\\":"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_two","delta":"2}"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_one","delta":"1}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_multi","status":"completed","output":[{"type":"function_call","id":"fc_one","call_id":"call_one","name":"one","arguments":"{\\"a\\":1}"},{"type":"function_call","id":"fc_two","call_id":"call_two","name":"two","arguments":"{\\"b\\":2}"}]}}\n\n',
    ].join("");
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const out = transformSseStream(upstream, "responses", "chat_completions");
    const reader = out.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const events = parseSseChunk(text).events
      .filter((event) => event.data !== "[DONE]")
      .map((event) => JSON.parse(event.data) as JsonObject);
    const toolChunks = events.filter((event) => {
      const choice = ((event.choices as JsonObject[] | undefined) ?? [])[0];
      return Array.isArray((choice?.delta as JsonObject | undefined)?.tool_calls);
    });
    expect(toolChunks.some((event) => JSON.stringify(event).includes('"index":0'))).toBe(true);
    expect(toolChunks.some((event) => JSON.stringify(event).includes('"index":1'))).toBe(true);
    expect(text).toContain('"id":"call_one"');
    expect(text).toContain('"id":"call_two"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain("data: [DONE]");
  });

  it("assembles Responses tools that only appear in the final response output", async () => {
    const sse =
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_final","status":"completed","output":[{"type":"function_call","id":"fc_final","call_id":"call_final","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}]}}\n\n';
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const out = transformSseStream(upstream, "responses", "chat_completions");
    const reader = out.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain('"id":"call_final"');
    expect(text).toContain('"name":"lookup"');
    expect(text).toContain('\\"q\\":\\"x\\"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain("data: [DONE]");
  });
});
