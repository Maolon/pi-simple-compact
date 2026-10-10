// End-to-end tests: drive the real Pi TUI in tmux with this extension and deterministic offline
// providers (tests/e2e/fake-provider.ts). No credentials, network or user Pi configuration are
// used: every scenario runs in its own temporary agent directory, project and session directory,
// and only its own uniquely named tmux session is ever killed.
//
// Usage: npm run test:e2e [-- <scenario-name>...]
// Env:   PSC_E2E_ENTRY=dist   load the compiled dist/index.js instead of src/index.ts
//        PSC_E2E_KEEP=1       keep temp directories and write pane captures to e2e-artifacts/
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(".");
const piBin = join(root, "node_modules", ".bin", "pi");
const entry = process.env.PSC_E2E_ENTRY === "dist" ? join(root, "dist", "index.js") : join(root, "src", "index.ts");
const fakeProvider = join(root, "tests", "e2e", "fake-provider.ts");
const keep = process.env.PSC_E2E_KEEP === "1";
const artifacts = join(root, "e2e-artifacts");

function tmux(...args) {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

class PiSession {
  constructor(name, { settings = {}, model = "e2e-chat/chat" } = {}) {
    this.name = name;
    this.dir = mkdtempSync(join(tmpdir(), "psc-e2e-"));
    this.agentDir = join(this.dir, "agent");
    this.cwd = join(this.dir, "project");
    this.sessionDir = join(this.dir, "sessions");
    for (const dir of [this.agentDir, this.cwd, this.sessionDir]) mkdirSync(dir, { recursive: true });
    // A tiny retained tail so two short turns leave history to compact.
    writeFileSync(join(this.agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1, ...settings } }));
    this.model = model;
    this.tmuxName = `psc-e2e-${process.pid}-${name}`;
    this.captures = [];
    this.sawStatus = false;
  }

  writeConfig(config) {
    writeFileSync(join(this.agentDir, "pi-simple-compact.json"), typeof config === "string" ? config : JSON.stringify(config, null, 2));
  }

  async start({ continueSession = false } = {}) {
    const args = [
      "--no-extensions", "-e", entry, "-e", fakeProvider,
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-themes", "--no-tools",
      "--session-dir", this.sessionDir, "--model", this.model,
      ...(continueSession ? ["--continue"] : []),
    ];
    const env = [
      `PI_CODING_AGENT_DIR=${this.agentDir}`, "PI_OFFLINE=1", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0",
      "PSC_E2E_SUMMARY_DELAY_MS=2500",
    ];
    const quoted = [piBin, ...args].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
    tmux("new-session", "-d", "-s", this.tmuxName, "-x", "160", "-y", "50", "-c", this.cwd, `env ${env.join(" ")} ${quoted}`);
    const modelId = this.model.split("/")[1];
    await this.waitForPane((pane) => pane.includes(`(e2e-chat) ${modelId}`), "Pi startup");
  }

  pane() {
    const text = tmux("capture-pane", "-p", "-J", "-t", this.tmuxName);
    this.captures.push(text);
    this.sawStatus ||= /(Manual|Auto) compact \(/.test(text);
    this.sawAutoStatus ||= text.includes("Auto compact (summary)");
    this.sawIdleStatus ||= text.includes("Idle compact (summary)");
    if (this.captures.length > 50) this.captures.shift();
    return text;
  }

  async type(text) {
    tmux("send-keys", "-t", this.tmuxName, "-l", text);
    await delay(400);
    tmux("send-keys", "-t", this.tmuxName, "Enter");
  }

  async prompt(text) {
    const before = this.messages("assistant").length;
    await this.type(text);
    await this.waitFor(() => this.messages("assistant").length > before, `reply to "${text}"`);
  }

  async waitFor(check, what, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Snapshot the screen on every poll so transient UI (the running status) is observable.
      if (this.alive()) this.pane();
      const value = check();
      if (value) return value;
      await delay(200);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  waitForPane(check, what, timeoutMs) {
    return this.waitFor(() => (check(this.pane()) ? true : undefined), what, timeoutMs);
  }

  entries() {
    if (!existsSync(this.sessionDir)) return [];
    return readdirSync(this.sessionDir).filter((file) => file.endsWith(".jsonl")).sort()
      .flatMap((file) => readFileSync(join(this.sessionDir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  }

  messages(role) {
    return this.entries().filter((item) => item.type === "message" && item.message.role === role);
  }

  compactions() {
    return this.entries().filter((item) => item.type === "compaction");
  }

  async quit() {
    await this.type("/quit");
    await this.waitFor(() => !this.alive(), "Pi to exit");
  }

  alive() {
    return spawnSync("tmux", ["has-session", "-t", this.tmuxName]).status === 0;
  }

  close(failed) {
    if (this.alive()) spawnSync("tmux", ["kill-session", "-t", this.tmuxName]);
    if (failed || keep) {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, `${this.name}.pane.txt`), this.captures.slice(-5).join("\n=====\n"));
    }
    if (!keep) rmSync(this.dir, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function seed(pi) {
  await pi.prompt("first synthetic prompt alpha");
  await pi.prompt("second synthetic prompt beta");
}

async function compactAndWait(pi) {
  const before = pi.compactions().length;
  await pi.type("/compact");
  return pi.waitFor(() => pi.compactions()[before], "a compaction entry");
}

/** Scenario-specific Pi settings and chat model; the rest use the defaults. */
const scenarioOptions = {
  "threshold-auto-compaction": { model: "e2e-chat/small", settings: { reserveTokens: 5_000 } },
};

const scenarios = {
  async "zero-config-native"(pi) {
    await pi.start();
    await seed(pi);
    const compaction = await compactAndWait(pi);
    assert(compaction.fromHook === false, "zero-config compaction must be Pi's own (fromHook false)");
    assert(compaction.summary.includes("E2E-NATIVE-SUMMARY from e2e-chat/chat"), "native summary comes from the chat model");
    assert(!pi.sawStatus, "no extension status in zero-config mode");
  },

  async "model-only-alternate-summarizer"(pi) {
    pi.writeConfig({ default: { model: "e2e-summary/summary" } });
    await pi.start();
    await seed(pi);
    const before = pi.compactions().length;
    await pi.type("/compact");
    await pi.waitForPane((pane) => pane.includes("Manual compact (summary)"), "the running compact status");
    const compaction = await pi.waitFor(() => pi.compactions()[before], "a compaction entry");
    assert(compaction.fromHook === true, "configured compaction is the extension's result");
    assert(compaction.summary.includes("E2E-ALT-SUMMARY (summary) from e2e-summary/summary"), "summary comes from the alternate model");
    assert(compaction.details?.stages?.[0]?.provider === "e2e-summary", "details name the summarizer provider");
    if (compaction.summary.includes("**Turn Context (split turn):**")) {
      assert(compaction.summary.includes("[HISTORY]") && compaction.summary.includes("[TURN_PREFIX]"), "split-turn sections are labeled");
    }
    await pi.waitForPane((pane) => !pane.includes("Manual compact (summary)"), "the status to clear");
    await pi.prompt("third synthetic prompt gamma");
    const last = pi.messages("assistant").at(-1).message;
    assert(last.provider === "e2e-chat" && last.model === "chat", `chat continues on e2e-chat/chat (got ${last.provider}/${last.model})`);
  },

  async "configured-failure-fails-closed"(pi) {
    pi.writeConfig({ default: { model: "e2e-summary/broken" } });
    await pi.start();
    await seed(pi);
    await pi.type("/compact");
    await pi.waitForPane((pane) => pane.includes("Configured compaction could not produce a summary"), "the fail-closed notice");
    await delay(1_000);
    assert(pi.compactions().length === 0, "a failed configured compaction writes no entry and no native fallback");
  },

  async "broken-config-native-escape"(pi) {
    pi.writeConfig("{ \"default\": { \"model\": ");
    await pi.start();
    await seed(pi);
    await pi.type("/compact");
    // The TUI wraps long notices, so compare with whitespace collapsed.
    await pi.waitForPane(
      (pane) => /configuration is invalid: .*not valid JSON \(line \d+, column \d+\)/.test(pane.replace(/\s+/g, " ")),
      "the config diagnostic",
    );
    assert(pi.compactions().length === 0, "a broken config cancels compaction");
    await pi.type("/compact-profile native");
    await pi.waitForPane((pane) => pane.includes("compaction now uses Pi's native behavior"), "the native override notice");
    const compaction = await compactAndWait(pi);
    assert(compaction.fromHook === false, "the session native override reaches Pi's own compaction despite the broken file");
  },

  async "typed-pipeline-reducer-and-llm"(pi) {
    pi.writeConfig({
      default: { pipeline: { model: "e2e-summary/summary", routes: { user: { reducer: "deterministic-facts" } } } },
    });
    await pi.start();
    await seed(pi);
    const compaction = await compactAndWait(pi);
    assert(compaction.fromHook === true, "pipeline compaction is the extension's result");
    const stages = compaction.details?.pipeline?.stages ?? [];
    const user = stages.find((stage) => stage.kind === "user");
    const assistant = stages.find((stage) => stage.kind === "assistant");
    assert(user?.strategy === "reducer" && user.reducer === "deterministic-facts", "user history uses the trusted reducer");
    assert(assistant?.strategy === "llm" && assistant.provider === "e2e-summary", "assistant history uses the alternate model");
    assert(compaction.summary.includes("## User") && compaction.summary.includes("## Assistant"), "one composed summary");
  },

  async "threshold-auto-compaction"(pi) {
    pi.writeConfig({ default: { model: "e2e-summary/summary" } });
    await pi.start();
    let compaction;
    for (let turn = 1; turn <= 6 && !compaction; turn++) {
      await pi.prompt(`threshold synthetic prompt ${turn} ${"padding ".repeat(60)}`);
      compaction = await pi.waitFor(() => pi.compactions()[0], "an automatic compaction", 6_000).catch(() => undefined);
    }
    assert(compaction, "Pi's threshold scheduler triggered a compaction");
    assert(compaction.fromHook === true, "the automatic compaction used the configured summarizer");
    assert(compaction.summary.includes("from e2e-summary/summary"), "the alternate model wrote the automatic summary");
    assert(pi.sawAutoStatus, "the status says Auto compact while it runs");
  },

  async "idle-cold-cache-compaction"(pi) {
    // Off in the file; the command turns it on globally. The tiny e2e context needs a low floor.
    pi.writeConfig({ default: { model: "e2e-summary/summary", idleCompact: { enabled: false, minContextTokens: 1 } } });
    await pi.start();
    await pi.type("/compact-idle on 1");
    await pi.waitForPane((pane) => pane.includes("Idle compaction for all chats: on, after 1 min idle"), "the /compact-idle notice");
    const written = JSON.parse(readFileSync(join(pi.agentDir, "pi-simple-compact.json"), "utf8"));
    assert(written.default.model === "e2e-summary/summary", "the command keeps the other global settings");
    assert(written.default.idleCompact.enabled === true && written.default.idleCompact.afterIdleMinutes === 1, "the command writes the global idle setting");
    await seed(pi);
    assert(pi.compactions().length === 0, "nothing compacts while the cache is warm");
    const compaction = await pi.waitFor(() => pi.compactions()[0], "the idle compaction", 90_000);
    assert(compaction.fromHook === true, "idle compaction goes through the configured summarizer");
    assert(compaction.summary.includes("from e2e-summary/summary"), "the alternate model wrote the idle summary");
    assert(pi.sawIdleStatus, "the status says Idle compact while it runs");
    await pi.prompt("after idle compaction epsilon");
    const last = pi.messages("assistant").at(-1).message;
    assert(last.provider === "e2e-chat" && last.model === "chat", "chat continues on the chat model after idle compaction");
    assert(pi.compactions().length === 1, "one idle period compacts once");
  },

  async "session-profile-survives-restart"(pi) {
    pi.writeConfig({ profiles: { alt: { model: "e2e-summary/summary" } } });
    await pi.start();
    await seed(pi);
    await pi.type("/compact-profile alt");
    await pi.waitForPane((pane) => pane.includes("Compaction profile set for this session: alt"), "the profile notice");
    await pi.quit();
    await pi.start({ continueSession: true });
    await pi.prompt("after restart delta");
    const compaction = await compactAndWait(pi);
    assert(compaction.fromHook === true, "the restored session profile drives compaction after restart");
    assert(compaction.summary.includes("from e2e-summary/summary"), "the restored profile's model wrote the summary");
  },
};

function preflight() {
  if (spawnSync("tmux", ["-V"]).status !== 0) throw new Error("tmux is required for the e2e suite");
  if (!existsSync(piBin)) throw new Error("Pi CLI not found; run npm install");
  if (!existsSync(entry)) throw new Error(`extension entry ${entry} not found${entry.endsWith(".js") ? "; run npm run build" : ""}`);
}

preflight();
const selected = process.argv.slice(2);
const names = selected.length > 0 ? selected : Object.keys(scenarios);
let failures = 0;
for (const name of names) {
  if (!scenarios[name]) throw new Error(`unknown scenario ${name}`);
  const pi = new PiSession(name, scenarioOptions[name]);
  const started = Date.now();
  let failed = false;
  try {
    await scenarios[name](pi);
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed = true;
    failures++;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`     last pane capture kept in ${join("e2e-artifacts", `${name}.pane.txt`)}`);
  } finally {
    pi.close(failed);
  }
}
console.log(`${names.length - failures}/${names.length} e2e scenarios passed (entry: ${entry.slice(root.length + 1)})`);
if (failures > 0) process.exitCode = 1;
