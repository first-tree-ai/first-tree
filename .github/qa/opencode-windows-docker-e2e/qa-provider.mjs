import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.QA_PROVIDER_PORT || "43127");
const logPath = process.env.QA_PROVIDER_LOG;

if (!logPath) {
  throw new Error("QA_PROVIDER_LOG is required");
}

let requestSequence = 0;
const barrierDefinitions = {
  new: ["QA_CONCURRENCY_NEW_A_218A", "QA_CONCURRENCY_NEW_B_218A"],
  resume: ["QA_CONCURRENCY_RESUME_A_218A", "QA_CONCURRENCY_RESUME_B_218A"],
};
const barrierState = new Map(
  Object.entries(barrierDefinitions).map(([name, markers]) => [name, { markers, pending: [], released: false }]),
);

function writeLog(event) {
  fs.appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
      }
      return "";
    })
    .join("\n");
}

function messagesText(messages, role) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => !role || message?.role === role)
    .map((message) => contentText(message?.content))
    .join("\n");
}

function lastUserMessageText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index--) {
    if (list[index]?.role === "user") {
      return contentText(list[index]?.content);
    }
  }
  return "";
}

function sendSse(response, chunks) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function textChunks({ id, model, text }) {
  const created = Math.floor(Date.now() / 1000);
  return [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      },
    },
  ];
}

function toolCallChunks({ id, model, toolName, argumentsJson }) {
  const created = Math.floor(Date.now() / 1000);
  return [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_ftqa_218a",
                type: "function",
                function: {
                  name: toolName,
                  arguments: argumentsJson,
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      },
    },
  ];
}

function sendJsonCompletion(response, { id, model, text }) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      },
    }),
  );
}

function barrierFor(text) {
  for (const [name, markers] of Object.entries(barrierDefinitions)) {
    const marker = markers.find((value) => text.includes(value));
    if (marker) return { name, marker };
  }
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: "qa-model",
            object: "model",
            created: 0,
            owned_by: "ftqa",
          },
        ],
      }),
    );
    return;
  }

  const releaseMatch = request.url?.match(/^\/ftqa\/barriers\/(new|resume)\/release$/);
  if (request.method === "POST" && releaseMatch) {
    const name = releaseMatch[1];
    const barrier = barrierState.get(name);
    if (!barrier || barrier.released || barrier.pending.length !== barrier.markers.length) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: "barrier is not ready for one-time release",
          name,
          pending: barrier?.pending.length ?? 0,
        }),
      );
      return;
    }

    barrier.released = true;
    const releasedAt = new Date().toISOString();
    for (const pending of barrier.pending) {
      const text = [
        "QA_PROVIDER_BARRIER_RELEASE",
        `barrier=${name}`,
        `marker=${pending.marker}`,
        `firstTurn=${pending.firstTurn}`,
      ].join(" ");
      writeLog({
        kind: "barrier_release",
        barrier: name,
        marker: pending.marker,
        requestID: pending.requestID,
        releasedAt,
      });
      writeLog({
        kind: "response",
        requestID: pending.requestID,
        responseMode: `barrier_${name}_release`,
        text,
      });
      if (pending.body.stream) {
        sendSse(
          pending.response,
          textChunks({
            id: pending.completionID,
            model: pending.body.model || "qa-model",
            text,
          }),
        );
      } else {
        sendJsonCompletion(pending.response, {
          id: pending.completionID,
          model: pending.body.model || "qa-model",
          text,
        });
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name,
        releasedAt,
        requestIDs: barrier.pending.map((pending) => pending.requestID),
      }),
    );
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }

  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const requestID = ++requestSequence;
    const completionID = `chatcmpl-ftqa-${requestID}`;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      writeLog({
        kind: "invalid_json",
        requestID,
        error: String(error),
      });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid JSON" } }));
      return;
    }

    const userText = lastUserMessageText(body.messages);
    const systemText = messagesText(body.messages, "system");
    const allText = messagesText(body.messages);
    const toolMessageCount = (Array.isArray(body.messages) ? body.messages : []).filter(
      (message) => message?.role === "tool",
    ).length;
    const toolNames = (Array.isArray(body.tools) ? body.tools : []).map((tool) => tool?.function?.name).filter(Boolean);

    writeLog({
      kind: "request",
      requestID,
      method: request.method,
      url: request.url,
      authorizationPresent: Boolean(request.headers.authorization),
      userAgent: request.headers["user-agent"] || null,
      model: body.model,
      stream: body.stream,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolMessageCount,
      toolNames,
      markers: {
        slock: systemText.includes("SLOCK_STANDING_PROMPT_MARKER_218A"),
        v1System: systemText.includes("V1_TURN_SYSTEM_MARKER_218A"),
        projectAgents: systemText.includes("PROJECT_AGENTS_MARKER_218A"),
        instructions: systemText.includes("INSTRUCTIONS_MARKER_218A"),
        plugin: systemText.includes("PLUGIN_SYSTEM_MARKER_218A"),
        firstTurn: allText.includes("FIRST_TURN_MARKER_218A"),
        toolResult: allText.includes("QA_TOOL_RESULT_218A"),
        mcpResult: allText.includes("MCP_OUTPUT_218A"),
        bridgeEnv:
          allText.includes("FT_AGENT=agent-v1-218a") &&
          allText.includes("FT_CHAT=chat-v1-218a") &&
          allText.includes("OC_PASS=") &&
          !allText.includes("OC_PASS=qa-server-secret-218a"),
      },
      body,
    });

    const concurrencyBarrier = barrierFor(userText);
    if (concurrencyBarrier) {
      const barrier = barrierState.get(concurrencyBarrier.name);
      if (
        !barrier ||
        barrier.released ||
        barrier.pending.some((pending) => pending.marker === concurrencyBarrier.marker)
      ) {
        writeLog({
          kind: "barrier_error",
          barrier: concurrencyBarrier.name,
          marker: concurrencyBarrier.marker,
          requestID,
        });
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "duplicate or already-released concurrency barrier marker",
          }),
        );
        return;
      }
      const arrivedAt = new Date().toISOString();
      barrier.pending.push({
        body,
        completionID,
        firstTurn: allText.includes("FIRST_TURN_MARKER_218A"),
        marker: concurrencyBarrier.marker,
        requestID,
        response,
      });
      writeLog({
        kind: "barrier_arrival",
        barrier: concurrencyBarrier.name,
        marker: concurrencyBarrier.marker,
        requestID,
        arrivedAt,
        pending: barrier.pending.length,
      });
      return;
    }

    if (userText.includes("QA_FORCE_500")) {
      writeLog({ kind: "response", requestID, responseMode: "forced_500" });
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "FTQA forced provider failure",
            type: "server_error",
          },
        }),
      );
      return;
    }

    if (userText.includes("QA_DELAY_SHORT")) {
      writeLog({ kind: "response", requestID, responseMode: "delayed_short" });
      let ended = false;
      const timer = setTimeout(() => {
        if (ended) return;
        const text = `QA_PROVIDER_DELAY_SHORT_COMPLETE request=${requestID}`;
        if (body.stream) {
          sendSse(
            response,
            textChunks({
              id: completionID,
              model: body.model || "qa-model",
              text,
            }),
          );
        } else {
          sendJsonCompletion(response, {
            id: completionID,
            model: body.model || "qa-model",
            text,
          });
        }
      }, 2_000);
      const markAbort = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        writeLog({ kind: "client_abort", requestID });
      };
      request.once("aborted", markAbort);
      response.once("close", () => {
        if (!response.writableEnded) markAbort();
      });
      return;
    }

    if (userText.includes("QA_DELAY")) {
      writeLog({ kind: "response", requestID, responseMode: "delayed" });
      let ended = false;
      const timer = setTimeout(() => {
        if (ended) return;
        const text = `QA_PROVIDER_DELAY_COMPLETE request=${requestID}`;
        if (body.stream) {
          sendSse(
            response,
            textChunks({
              id: completionID,
              model: body.model || "qa-model",
              text,
            }),
          );
        } else {
          sendJsonCompletion(response, {
            id: completionID,
            model: body.model || "qa-model",
            text,
          });
        }
      }, 90_000);
      const markAbort = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        writeLog({ kind: "client_abort", requestID });
      };
      request.once("aborted", markAbort);
      response.once("close", () => {
        if (!response.writableEnded) markAbort();
      });
      return;
    }

    const toolName = toolNames.find((name) => name === "bash");
    if (userText.includes("QA_CALL_BRIDGE") && toolMessageCount === 0 && toolName) {
      writeLog({
        kind: "response",
        requestID,
        responseMode: "bridge_tool_call",
        toolName,
      });
      sendSse(
        response,
        toolCallChunks({
          id: completionID,
          model: body.model || "qa-model",
          toolName,
          argumentsJson: JSON.stringify({
            command:
              'printf \'FT_AGENT=%s FT_CHAT=%s OC_PASS=%s FT_MARKER=%s\' "$FIRST_TREE_AGENT_ID" "$FIRST_TREE_CHAT_ID" "$OPENCODE_SERVER_PASSWORD" "$FIRST_TREE_PROVIDER_MARKER"',
            description: "Read deterministic First Tree bridge environment",
          }),
        }),
      );
      return;
    }

    if (userText.includes("QA_CALL_BASH") && toolMessageCount === 0 && toolName) {
      writeLog({
        kind: "response",
        requestID,
        responseMode: "tool_call",
        toolName,
      });
      sendSse(
        response,
        toolCallChunks({
          id: completionID,
          model: body.model || "qa-model",
          toolName,
          argumentsJson: JSON.stringify({
            command: process.env.FTQA_SHELL_COMMAND ?? "printf QA_TOOL_RESULT_218A",
            description: "Emit deterministic QA marker",
          }),
        }),
      );
      return;
    }

    if (userText.includes("QA_CALL_BACKGROUND") && toolMessageCount === 0 && toolName) {
      writeLog({
        kind: "response",
        requestID,
        responseMode: "background_tool_call",
        toolName,
      });
      sendSse(
        response,
        toolCallChunks({
          id: completionID,
          model: body.model || "qa-model",
          toolName,
          argumentsJson: JSON.stringify({
            command: process.env.FTQA_BACKGROUND_COMMAND ?? '/usr/bin/python3 "$FTQA_DAEMONIZE_SCRIPT"',
            description: "Start one double-forked synthetic QA daemon",
          }),
        }),
      );
      return;
    }

    if (userText.includes("QA_CALL_BACKGROUND_HOLD") && toolMessageCount > 0) {
      writeLog({
        kind: "response",
        requestID,
        responseMode: "background_hold",
      });
      let ended = false;
      const timer = setTimeout(() => {
        if (ended) return;
        const text = `QA_BACKGROUND_HOLD_COMPLETE request=${requestID}`;
        if (body.stream) {
          sendSse(
            response,
            textChunks({
              id: completionID,
              model: body.model || "qa-model",
              text,
            }),
          );
        } else {
          sendJsonCompletion(response, {
            id: completionID,
            model: body.model || "qa-model",
            text,
          });
        }
      }, 90_000);
      const markAbort = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        writeLog({ kind: "client_abort", requestID });
      };
      request.once("aborted", markAbort);
      response.once("close", () => {
        if (!response.writableEnded) markAbort();
      });
      return;
    }

    const mcpToolName = toolNames.find((name) => name.includes("qa_echo"));
    if (userText.includes("QA_CALL_MCP") && toolMessageCount === 0 && mcpToolName) {
      writeLog({
        kind: "response",
        requestID,
        responseMode: "tool_call",
        toolName: mcpToolName,
      });
      sendSse(
        response,
        toolCallChunks({
          id: completionID,
          model: body.model || "qa-model",
          toolName: mcpToolName,
          argumentsJson: '{"text":"MCP_INPUT_218A"}',
        }),
      );
      return;
    }

    const markerSummary = {
      slock: systemText.includes("SLOCK_STANDING_PROMPT_MARKER_218A"),
      v1System: systemText.includes("V1_TURN_SYSTEM_MARKER_218A"),
      projectAgents: systemText.includes("PROJECT_AGENTS_MARKER_218A"),
      instructions: systemText.includes("INSTRUCTIONS_MARKER_218A"),
      plugin: systemText.includes("PLUGIN_SYSTEM_MARKER_218A"),
      firstTurn: allText.includes("FIRST_TURN_MARKER_218A"),
      toolResult: allText.includes("QA_TOOL_RESULT_218A"),
      mcpResult: allText.includes("MCP_OUTPUT_218A"),
      bridgeEnv:
        allText.includes("FT_AGENT=agent-v1-218a") &&
        allText.includes("FT_CHAT=chat-v1-218a") &&
        allText.includes("OC_PASS=") &&
        !allText.includes("OC_PASS=qa-server-secret-218a"),
    };
    const text = [
      "QA_PROVIDER_OK",
      `request=${requestID}`,
      ...Object.entries(markerSummary).map(([key, value]) => `${key}=${value}`),
      `messages=${Array.isArray(body.messages) ? body.messages.length : 0}`,
    ].join(" ");

    writeLog({
      kind: "response",
      requestID,
      responseMode: body.stream ? "stream_text" : "json_text",
      text,
    });

    if (body.stream) {
      sendSse(
        response,
        textChunks({
          id: completionID,
          model: body.model || "qa-model",
          text,
        }),
      );
    } else {
      sendJsonCompletion(response, {
        id: completionID,
        model: body.model || "qa-model",
        text,
      });
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  writeLog({ kind: "ready", port });
  process.stdout.write(`QA provider ready on http://127.0.0.1:${port}\n`);
});

function shutdown(signal) {
  writeLog({ kind: "shutdown", signal });
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
