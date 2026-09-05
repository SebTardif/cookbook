import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { OpenClaw, type OpenClawEvent, type Run, type RunResult } from "@openclaw/sdk";
import { runCodingAgentCli } from "../sdk/coding-agent-cli/src/index.js";

class HangingRun {
  readonly id = "hanging-run";
  private cancelled = false;
  private holdWaiters: Array<() => void> = [];

  async *events(): AsyncIterable<OpenClawEvent> {
    yield {
      version: 1,
      id: "start",
      ts: Date.now(),
      type: "run.started",
      runId: this.id,
      data: {},
    };
    if (!this.cancelled) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 400);
        this.holdWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    yield {
      version: 1,
      id: this.cancelled ? "cancelled" : "end",
      ts: Date.now(),
      type: this.cancelled ? "run.cancelled" : "run.completed",
      runId: this.id,
      data: {},
    };
  }

  async wait(): Promise<RunResult> {
    return {
      runId: this.id,
      status: this.cancelled ? "cancelled" : "completed",
      endedAt: 456,
    };
  }

  async cancel(): Promise<unknown> {
    this.cancelled = true;
    for (const wake of this.holdWaiters) {
      wake();
    }
    this.holdWaiters = [];
    return { ok: true, status: "aborted", abortedRunId: this.id };
  }
}

function hangingClient(): OpenClaw {
  const run = new HangingRun();
  const oc = new OpenClaw();
  oc.runs.create = async () => run as unknown as Run;
  return oc;
}

async function waitFor(
  read: () => string,
  match: string | ((text: string) => boolean),
  timeoutMs = 2000,
): Promise<string> {
  const start = Date.now();
  const hit = typeof match === "string" ? (text: string) => text.includes(match) : match;
  for (;;) {
    const text = read();
    if (hit(text)) {
      return text;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for output.\n${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("coding-agent-cli", () => {
  it("cancels the active run when /cancel is typed during sendPrompt", async () => {
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new PassThrough();
    output.on("data", (chunk: Buffer | string) => {
      chunks.push(String(chunk));
    });
    const read = () => chunks.join("");

    const done = runCodingAgentCli({ argv: [], input, output, client: hangingClient() });
    try {
      await waitFor(read, "openclaw>");
      input.write("keep working\n");
      await waitFor(read, "[run.started]");
      input.write("/cancel\n");
      const text = await waitFor(
        read,
        (current) => current.includes("aborted") || current.includes("No active run."),
      );
      expect(text).toContain("aborted");
      expect(text).not.toContain("No active run.");
    } finally {
      input.write("/exit\n");
      input.end();
      await done;
    }
  });
});

function drive(client: OpenClaw, terminal = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  Object.assign(output, { isTTY: terminal });
  let text = "";
  output.on("data", (chunk) => (text += String(chunk)));
  const done = runCodingAgentCli({ argv: [], input, output, client });
  return { input, done, read: () => text };
}

describe("coding-agent-cli lifecycle", () => {
  it.each(["/cancel", "/exit"])("retains %s during run creation", async (command) => {
    const run = new HangingRun();
    let finishCreate!: (run: Run) => void;
    let closed = false;
    const client = new OpenClaw();
    client.runs.create = () => new Promise((resolve) => (finishCreate = resolve));
    client.close = async () => {
      closed = true;
    };
    const cli = drive(client);
    try {
      await waitFor(cli.read, "openclaw>");
      cli.input.write("keep working\n");
      await waitFor(() => String(Boolean(finishCreate)), "true");
      cli.input.write(`${command}\n`);
      await new Promise((resolve) => setImmediate(resolve));
      expect(cli.read()).not.toContain("No active run.");
      finishCreate(run as unknown as Run);
      await waitFor(cli.read, '"status": "cancelled"');
      if (command === "/cancel") cli.input.write("/exit\n");
      await cli.done;
      expect(closed).toBe(true);
    } finally {
      cli.input.end();
      await cli.done;
    }
  });

  it.each(["/cancel", "/exit"])("keeps the terminal usable after failed %s", async (command) => {
    const run = new HangingRun();
    const cancel = run.cancel.bind(run);
    let attempts = 0;
    run.cancel = async () => {
      if (++attempts === 1) throw new Error("synthetic abort failure");
      return cancel();
    };
    const client = new OpenClaw();
    client.runs.create = async () => run as unknown as Run;
    const cli = drive(client);
    try {
      await waitFor(cli.read, "openclaw>");
      cli.input.write("keep working\n");
      await waitFor(cli.read, "[run.started]");
      cli.input.write(`${command}\n`);
      await waitFor(cli.read, "Cancellation failed:");
      cli.input.write("/cancel\n");
      await waitFor(cli.read, '"status": "cancelled"');
      expect(attempts).toBe(2);
    } finally {
      cli.input.write("/exit\n");
      cli.input.end();
      await cli.done;
    }
  });

  it("closes the client when input ends while idle", async () => {
    const client = new OpenClaw();
    let closed = false;
    client.close = async () => {
      closed = true;
    };
    const cli = drive(client);
    await waitFor(cli.read, "openclaw>");
    cli.input.end();
    await cli.done;
    expect(closed).toBe(true);
  });

  it("cancels active work before closing at EOF", async () => {
    const run = new HangingRun();
    const client = new OpenClaw();
    client.runs.create = async () => run as unknown as Run;
    const cli = drive(client);
    await waitFor(cli.read, "openclaw>");
    cli.input.write("keep working\n");
    await waitFor(cli.read, "[run.started]");
    cli.input.end();
    await cli.done;
    expect((await run.wait()).status).toBe("cancelled");
  });
});

describe("coding-agent-cli terminal signals", () => {
  it("settles idle Ctrl+C and closes the client", async () => {
    const client = new OpenClaw();
    let closed = false;
    client.close = async () => {
      closed = true;
    };
    const cli = drive(client, true);
    await waitFor(cli.read, "openclaw>");
    cli.input.write("\x03");
    await cli.done;
    expect(closed).toBe(true);
    cli.input.end();
  });

  it("handles a failed Ctrl+C cancellation and allows retry", async () => {
    const run = new HangingRun();
    const cancel = run.cancel.bind(run);
    let attempts = 0;
    run.cancel = async () => {
      if (++attempts === 1) throw new Error("synthetic abort failure");
      return cancel();
    };
    const client = new OpenClaw();
    client.runs.create = async () => run as unknown as Run;
    const cli = drive(client, true);
    try {
      await waitFor(cli.read, "openclaw>");
      cli.input.write("keep working\n");
      await waitFor(cli.read, "[run.started]");
      cli.input.write("\x03");
      await waitFor(cli.read, "Cancellation failed:");
      cli.input.write("/cancel\n");
      await waitFor(cli.read, '"status": "cancelled"');
      expect(attempts).toBe(2);
    } finally {
      cli.input.end();
      await cli.done;
    }
  });
});

it("runs the CLI entrypoint through a symlink", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cookbook-cli-entry-"));
  try {
    const entry = join(scratch, "cli.ts");
    await symlink(
      fileURLToPath(new URL("../sdk/coding-agent-cli/src/index.ts", import.meta.url)),
      entry,
    );
    const { stdout } = await promisify(execFile)(
      "pnpm",
      ["exec", "tsx", entry, "Synthetic smoke"],
      { timeout: 10_000 },
    );
    expect(stdout).toContain("[run.completed]");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
