import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl } from "../../core/bootstrap.js";
import { cliFetch } from "../../core/cli-fetch.js";
import { print } from "../../core/output.js";
import { sanitizeTerminalText } from "../../core/terminal-safety.js";
import { resolveAgent } from "../_shared/resolve-agent.js";

export function registerChatOpenCommand(chat: Command): void {
  chat
    .command("open <agent-name>")
    .description("Open an interactive chat with an agent (as the current member's human agent)")
    .option("--server <url>", "First Tree server URL")
    .action(async (agentName: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const adminToken = await ensureFreshAccessToken();
        const headers = {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        };

        const targetAgent = await resolveAgent(serverUrl, adminToken, agentName);

        const dmRes = await cliFetch(`${serverUrl}/api/v1/agents/${targetAgent.uuid}/chats`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!dmRes.ok) {
          const body = await dmRes.text();
          fail("DM_ERROR", `Failed to create DM: ${dmRes.status} — ${body}`, 1);
        }
        const dm = (await dmRes.json()) as { id: string };

        // SEC-050: both the display name and the message bodies below are
        // server-provided. They are written to a terminal, so control bytes are
        // stripped before rendering; `chat history` keeps the exact JSON.
        const headerLabel = sanitizeTerminalText(targetAgent.displayName ?? targetAgent.name ?? targetAgent.uuid);
        // The message prefix has always fallen back to the literal "agent"
        // rather than the uuid; keep that split so the transcript stays stable.
        const senderLabel = sanitizeTerminalText(targetAgent.displayName ?? targetAgent.name ?? "agent");
        print.line(`\n  Chat with ${headerLabel}\n`);
        print.line(`  Chat ID: ${dm.id}\n`);
        print.line(`  Type a message and press Enter. Ctrl+C to exit.\n\n`);

        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: "  > " });

        let lastSeenAt: string | null = null;

        const pollMessages = async (): Promise<void> => {
          try {
            const qs = lastSeenAt ? `?limit=50` : `?limit=10`;
            const msgRes = await cliFetch(`${serverUrl}/api/v1/chats/${dm.id}/messages${qs}`, {
              headers,
              signal: AbortSignal.timeout(10_000),
            });
            if (!msgRes.ok) return;
            const msgData = (await msgRes.json()) as {
              items: Array<{
                id: string;
                senderId: string;
                content: unknown;
                createdAt: string;
              }>;
            };

            const cutoff = lastSeenAt;
            const newMessages = cutoff
              ? msgData.items.filter((m) => m.createdAt > cutoff && m.senderId === targetAgent.uuid).reverse()
              : [];

            for (const msg of newMessages) {
              const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
              const preview = sanitizeTerminalText(content.length > 500 ? `${content.slice(0, 500)}...` : content);
              print.line(`\r  [${senderLabel}] ${preview}\n`);
            }

            if (msgData.items.length > 0 && msgData.items[0]) {
              const newest = msgData.items[0].createdAt;
              if (!lastSeenAt || newest > lastSeenAt) {
                lastSeenAt = newest;
              }
            }
          } catch {
            // ignore polling errors
          }
        };

        await pollMessages();

        const pollTimer = setInterval(() => {
          pollMessages().then(() => rl.prompt());
        }, 2000);

        rl.prompt();

        rl.on("line", async (line: string) => {
          const text = line.trim();
          if (!text) {
            rl.prompt();
            return;
          }

          try {
            const sendRes = await cliFetch(`${serverUrl}/api/v1/chats/${dm.id}/messages`, {
              method: "POST",
              headers,
              body: JSON.stringify({ format: "text", content: text }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!sendRes.ok) {
              const body = await sendRes.text();
              print.line(`  [error] Failed to send: ${sendRes.status} — ${body}\n`);
            } else {
              const sent = (await sendRes.json()) as { createdAt: string };
              lastSeenAt = sent.createdAt;
            }
          } catch (err) {
            print.line(`  [error] ${err instanceof Error ? err.message : String(err)}\n`);
          }
          rl.prompt();
        });

        rl.on("close", () => {
          clearInterval(pollTimer);
          print.line("\n  Chat ended.\n");
          process.exit(0);
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("CHAT_ERROR", msg);
      }
    });
}
