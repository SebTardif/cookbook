import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { pathToFileURL } from "node:url";
import { OpenClaw, type Run } from "@openclaw/sdk";
import { redactSensitiveOutput } from "./redact-sensitive-output.js";

type CliState = {
  agentId: string;
  sessionKey: string;
  model?: string;
};

export type CodingAgentCliOptions = {
  argv?: string[];
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  client?: OpenClaw;
};

function help(): string {
  return [
    "Commands:",
    "  /help             Show commands",
    "  /model <model>    Set model override",
    "  /session <key>    Switch session key",
    "  /status           Print model/auth status",
    "  /cancel           Cancel the active run",
    "  /exit             Exit",
  ].join("\n");
}

function isDirectRun(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry ? metaUrl === pathToFileURL(realpathSync(entry)).href : false;
}

export async function runCodingAgentCli(options: CodingAgentCliOptions = {}): Promise<void> {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const argv = options.argv ?? process.argv.slice(2);

  const oc =
    options.client ??
    new OpenClaw({
      gateway: process.env.OPENCLAW_GATEWAY ?? "auto",
      token: process.env.OPENCLAW_TOKEN,
      password: process.env.OPENCLAW_PASSWORD,
    });

  const state: CliState = {
    agentId: process.env.OPENCLAW_AGENT_ID ?? "main",
    sessionKey: process.env.OPENCLAW_SESSION_KEY ?? "cli",
    model: process.env.OPENCLAW_MODEL,
  };

  let runCreated: Promise<Run> | null = null;
  let inFlight: Promise<void> | null = null;
  let cancellation: Promise<boolean> | null = null;

  async function cancelActiveRun(announceIdle = true): Promise<boolean> {
    const created = runCreated;
    if (!created) {
      if (announceIdle) output.write("No active run.\n");
      return true;
    }
    if (!cancellation) {
      // Await the handle so cancellation requested during startup is retained.
      cancellation = (async () => {
        const run = await created;
        output.write(`${JSON.stringify(redactSensitiveOutput(await run.cancel()), null, 2)}\n`);
        return true;
      })().catch((error: unknown) => {
        if (runCreated === created) cancellation = null;
        const message = error instanceof Error ? error.message : String(error);
        output.write(`Cancellation failed: ${message}. Try /cancel again.\n`);
        return false;
      });
    }
    return cancellation;
  }

  async function sendPrompt(prompt: string): Promise<void> {
    try {
      runCreated = oc.runs.create({
        input: prompt,
        agentId: state.agentId,
        sessionKey: state.sessionKey,
        timeoutMs: 300_000,
        ...(state.model ? { model: state.model } : {}),
      });
      const run = await runCreated;
      for await (const event of run.events()) {
        if (event.type === "assistant.delta") {
          const delta = (event.data as { delta?: unknown }).delta;
          if (typeof delta === "string") {
            output.write(delta);
          }
        }
        if (event.type.startsWith("run.")) {
          output.write(`\n[${event.type}]`);
        }
        if (
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled" ||
          event.type === "run.timed_out"
        ) {
          break;
        }
      }
      const result = await run.wait({ timeoutMs: 120_000 });
      output.write(`\n${JSON.stringify(redactSensitiveOutput(result), null, 2)}\n`);
    } finally {
      runCreated = null;
      cancellation = null;
    }
  }

  async function runCommand(line: string): Promise<boolean> {
    const [command, ...rest] = line.trim().split(/\s+/);
    switch (command) {
      case "/help":
        output.write(`${help()}\n`);
        return true;
      case "/model":
        state.model = rest.join(" ") || undefined;
        output.write(`model=${state.model ?? "default"}\n`);
        return true;
      case "/session":
        state.sessionKey = rest.join(" ") || "cli";
        output.write(`session=${state.sessionKey}\n`);
        return true;
      case "/status":
        output.write(
          `${JSON.stringify(redactSensitiveOutput(await oc.models.status({ probe: false })), null, 2)}\n`,
        );
        return true;
      case "/cancel":
        await cancelActiveRun();
        return true;
      case "/exit":
      case "/quit":
        return !(await cancelActiveRun(false));
      default:
        output.write("Unknown command. Type /help.\n");
        return true;
    }
  }

  try {
    const prompt = argv.join(" ");
    if (prompt) {
      await sendPrompt(prompt);
    } else {
      output.write(`${help()}\n\n`);
      const rl = createInterface({ input, output });
      rl.setPrompt("openclaw> ");
      rl.on("SIGINT", () => {
        if (inFlight) {
          void cancelActiveRun();
        } else {
          rl.close();
        }
      });
      try {
        rl.prompt();
        // The iterator settles on EOF and idle Ctrl+C, unlike a pending question().
        for await (const line of rl) {
          const trimmed = line.trim();
          if (trimmed.startsWith("/")) {
            try {
              if (!(await runCommand(trimmed))) break;
            } catch (error) {
              output.write(`${error instanceof Error ? error.message : String(error)}\n`);
            }
          } else if (trimmed) {
            if (inFlight) {
              output.write("A run is already active. Type /cancel to stop it.\n");
            } else {
              inFlight = sendPrompt(trimmed)
                .catch((error: unknown) => {
                  const message = error instanceof Error ? error.message : String(error);
                  output.write(`\n${message}\n`);
                })
                .finally(() => {
                  inFlight = null;
                });
            }
          }
          rl.prompt();
        }
      } finally {
        rl.close();
        if (inFlight && (await cancelActiveRun(false))) await inFlight;
      }
    }
  } finally {
    await oc.close();
  }
}

if (isDirectRun(import.meta.url)) {
  await runCodingAgentCli();
}
