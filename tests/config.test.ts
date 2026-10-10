import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getSessionProfile,
  loadProfileConfig,
  parseConfigFile,
  resolveIdleCompact,
  resolveProfile,
  SESSION_PROFILE_ENTRY,
  type LoadedProfileConfig,
} from "../src/config.ts";

const emptyConfig: LoadedProfileConfig = { user: {}, project: {} };

describe("compact profile configuration", () => {
  it("leaves an absent profile native and applies exact per-field precedence", () => {
    expect(resolveProfile(emptyConfig, "chat/model", undefined)).toBeUndefined();

    const config: LoadedProfileConfig = {
      user: {
        default: { model: "user/default", prompt: "user prompt", failurePolicy: "fail" },
        models: { "chat/model": { model: "user/model", prompt: "user model prompt" } },
      },
      project: {
        default: { model: "project/default", prompt: "project prompt" },
        models: { "chat/model": { prompt: "project model prompt" } },
      },
    };
    expect(resolveProfile(config, "chat/model", undefined)).toEqual({
      model: "user/model",
      prompt: "project model prompt",
      failurePolicy: "fail",
    });
  });

  it("lets a higher-priority model profile override a lower-priority native default", () => {
    const config: LoadedProfileConfig = {
      user: { default: { mode: "native" } },
      project: { models: { "chat/model": { prompt: "project replacement" } } },
    };
    expect(resolveProfile(config, "chat/model", undefined)).toEqual({ prompt: "project replacement" });
  });

  it("gives a named session profile priority and native an explicit escape hatch", () => {
    const config: LoadedProfileConfig = {
      user: { default: { model: "user/default", prompt: "base" }, profiles: { fast: { model: "user/fast" } } },
      project: { profiles: { fast: { prompt: "fast prompt" } } },
    };
    expect(resolveProfile(config, "chat/model", "fast")).toEqual({
      model: "user/fast",
      prompt: "fast prompt",
    });
    expect(resolveProfile(config, "chat/model", "native")).toEqual({ mode: "native" });
  });

  it("merges nested pipeline route fields with the same profile precedence", () => {
    const config: LoadedProfileConfig = {
      user: {
        default: {
          pipeline: {
            model: "user/default-model",
            routes: {
              user: { model: "user/user-model", reducer: "deterministic-facts" },
              assistant: { prompt: "user assistant prompt" },
            },
          },
        },
        models: {
          "chat/model": {
            pipeline: { routes: { user: { prompt: "user model prompt" } } },
          },
        },
      },
      project: {
        default: { pipeline: { routes: { assistant: { model: "project/assistant-model" } } } },
        models: {
          "chat/model": {
            pipeline: { routes: { user: { prompt: "project model prompt" } } },
          },
        },
      },
    };
    expect(resolveProfile(config, "chat/model", undefined)).toEqual({
      pipeline: {
        model: "user/default-model",
        routes: {
          user: { prompt: "project model prompt", model: "user/user-model", reducer: "deterministic-facts" },
          assistant: { model: "project/assistant-model", prompt: "user assistant prompt" },
        },
      },
    });
  });

  it("allows a higher-priority session pipeline to override a lower native default", () => {
    const config: LoadedProfileConfig = {
      user: { default: { mode: "native" } },
      project: {
        profiles: {
          typed: {
            pipeline: { routes: { user: { reducer: "deterministic-facts" } } },
          },
        },
      },
    };
    expect(resolveProfile(config, "chat/model", "typed")).toEqual({
      pipeline: { routes: { user: { reducer: "deterministic-facts" } } },
    });
  });

  it("rejects ambiguous replacement-prompt and typed-pipeline combinations", () => {
    expect(() => parseConfigFile('{"default":{"prompt":"whole summary","pipeline":{}}}', "fixture"))
      .toThrow("cannot combine the top-level replacement prompt with a nested pipeline");
    expect(() => resolveProfile({
      user: { default: { prompt: "whole summary" } },
      project: { default: { pipeline: { routes: {} } } },
    }, undefined, undefined)).toThrow("cannot combine the top-level replacement prompt with a nested pipeline");
  });

  it("rejects invalid typed routes, reducer names, and pipeline budgets", () => {
    expect(() => parseConfigFile('{"default":{"pipeline":{"routes":{"unknown":{"model":"p/m"}}}}}', "fixture"))
      .toThrow("unsupported history kind");
    expect(() => parseConfigFile('{"default":{"pipeline":{"routes":{"user":{"reducer":"../unsafe"}}}}}', "fixture"))
      .toThrow("registered reducer name");
    expect(() => parseConfigFile('{"default":{"pipeline":{"maxOutputChars":12}}}', "fixture"))
      .toThrow("maxOutputChars must be an integer of at least 128");
  });

  it("restores inheritance after a branch-local reset entry", () => {
    const entries = [
      { type: "custom" as const, customType: SESSION_PROFILE_ENTRY, data: { version: 1, profile: "fast" } },
      { type: "custom" as const, customType: SESSION_PROFILE_ENTRY, data: { version: 1, profile: null } },
    ];
    expect(getSessionProfile(entries)).toBeUndefined();
    expect(getSessionProfile(entries.slice(0, 1))).toBe("fast");
  });

  it("rejects malformed, unknown, and non-native mode fields instead of silently using Pi defaults", () => {
    expect(() => parseConfigFile("{bad json", "fixture")).toThrow("not valid JSON");
    // Locations only: engine messages can quote file contents.
    expect(() => parseConfigFile('{\n  "default": oops-SECRET\n}', "fixture")).toThrow(/^fixture is not valid JSON( \(line 2, column \d+\))?$/);
    expect(() => parseConfigFile('{\n  "default": {', "fixture")).toThrow(/^fixture is not valid JSON \(line 2, column 15\)$/);
    expect(() => parseConfigFile('{"future":true}', "fixture")).toThrow("unknown field");
    expect(() => parseConfigFile('{"default":{"prompt":"Sum {{history}}"}}', "fixture"))
      .toThrow("fixture.default.prompt has unsupported placeholder {{history}}");
    expect(parseConfigFile('{"default":{"prompt":"Sum {{conversation}} {{turnPrefix}}"}}', "fixture").default?.prompt).toContain("{{turnPrefix}}");
    expect(() => parseConfigFile('{"default":{"model":"missing-slash"}}', "fixture")).toThrow("provider/modelId");
    expect(() => parseConfigFile('{"default":{"mode":"custom"}}', "fixture")).toThrow('must be "native"');
    expect(() => parseConfigFile('{"models":{"provider/":{"model":"other/model"}}}', "fixture")).toThrow("provider/modelId key");
    expect(() => parseConfigFile('{"profiles":{"native":{"model":"other/model"}}}', "fixture")).toThrow("not a selectable profile name");
  });

  it("accepts every Pi thinking level and resolves thinkingLevel per field like model", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(parseConfigFile(`{"default":{"model":"p/m","thinkingLevel":"${level}"}}`, "fixture").default)
        .toEqual({ model: "p/m", thinkingLevel: level });
    }

    const config: LoadedProfileConfig = {
      user: {
        default: { thinkingLevel: "low" },
        models: { "chat/model": { thinkingLevel: "high" } },
      },
      project: {
        default: { model: "project/default" },
        models: { "chat/model": {} },
      },
    };
    expect(resolveProfile(config, "chat/model", undefined)).toEqual({
      model: "project/default",
      thinkingLevel: "high",
    });
    expect(resolveProfile(config, "chat/other-model", undefined)).toEqual({
      model: "project/default",
      thinkingLevel: "low",
    });
  });

  it("rejects invalid, unknown, and mistyped thinking levels instead of ignoring them", () => {
    expect(() => parseConfigFile('{"default":{"thinkingLevel":"ultra"}}', "fixture"))
      .toThrow('thinkingLevel must be one of "off", "minimal", "low", "medium", "high", "xhigh", "max"');
    expect(() => parseConfigFile('{"default":{"thinkingLevel":"HIGH"}}', "fixture")).toThrow("thinkingLevel must be one of");
    expect(() => parseConfigFile('{"default":{"thinkingLevel":2}}', "fixture")).toThrow("thinkingLevel must be one of");
    expect(() => parseConfigFile('{"default":{"pipeline":{"thinkingLevel":"high"}}}', "fixture"))
      .toThrow('pipeline has unknown field "thinkingLevel"');
  });

  it("rejects a broken user file without an unhandled rejection while the project trust check runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "psc-config-"));
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      await mkdir(agentDir, { recursive: true });
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(join(agentDir, "pi-simple-compact.json"), "{ broken", "utf8");
      await writeFile(join(cwd, ".pi", "settings.json"), "{}", "utf8");
      for (let attempt = 0; attempt < 25; attempt++) {
        await expect(loadProfileConfig(agentDir, cwd, true)).rejects.toThrow("is not valid JSON");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves idle compaction per field across session, model and default layers", () => {
    const user = parseConfigFile(JSON.stringify({
      default: { idleCompact: { afterIdleMinutes: 45 } },
      models: {
        "openai-codex/gpt-6-astra": { model: "google/gemini-3.8-flash", idleCompact: { minContextTokens: 200000 } },
        "openai-codex/gpt-6-sol": { idleCompact: false },
      },
      profiles: { quiet: { idleCompact: false }, eager: { idleCompact: { enabled: true, afterIdleMinutes: 5 } } },
    }), "user.json");
    const project = parseConfigFile(JSON.stringify({ models: { "openai-codex/gpt-6-astra": { idleCompact: { afterIdleMinutes: 20 } } } }), "project.json");
    const config: LoadedProfileConfig = { user, project };
    // project model > user model > user default, one field at a time.
    expect(resolveIdleCompact(config, "openai-codex/gpt-6-astra", undefined)).toEqual({ afterIdleMinutes: 20, minContextTokens: 200000 });
    expect(resolveIdleCompact(config, "other/model", undefined)).toEqual({ afterIdleMinutes: 45, minContextTokens: 50000 });
    // false is enabled:false and wins over the default below it.
    expect(resolveIdleCompact(config, "openai-codex/gpt-6-sol", undefined)).toBeUndefined();
    // Session profiles sit on top: off for this session, or re-enabled over a model's false.
    expect(resolveIdleCompact(config, "openai-codex/gpt-6-astra", "quiet")).toBeUndefined();
    expect(resolveIdleCompact(config, "openai-codex/gpt-6-sol", "eager")).toEqual({ afterIdleMinutes: 5, minContextTokens: 50000 });
    // A session native override is Pi's own behavior, which has no idle compaction.
    expect(resolveIdleCompact(config, "openai-codex/gpt-6-astra", "native")).toBeUndefined();
    expect(() => resolveIdleCompact(config, "openai-codex/gpt-6-astra", "gone")).toThrow(/gone/);
    // A trigger-only profile is not a summarizer profile: compaction itself stays native.
    expect(resolveProfile(config, "other/model", undefined)).toBeUndefined();
    expect(resolveProfile(config, "openai-codex/gpt-6-astra", undefined)).toEqual({ model: "google/gemini-3.8-flash" });
  });

  it("treats idle compaction as off until configured, defaults its fields, and lets native end inheritance", () => {
    expect(resolveIdleCompact(emptyConfig, "a/b", undefined)).toBeUndefined();
    const user = parseConfigFile(JSON.stringify({
      default: { idleCompact: {} },
      models: { "a/native": { mode: "native" }, "a/native-idle": { mode: "native", idleCompact: { afterIdleMinutes: 30 } } },
      profiles: { on: { idleCompact: { minContextTokens: 1000 } } },
    }), "user.json");
    const config: LoadedProfileConfig = { user, project: {} };
    expect(resolveIdleCompact(config, "a/b", undefined)).toEqual({ afterIdleMinutes: 60, minContextTokens: 50000 });
    // A native model layer stops a lower default, like it does for summarizer fields...
    expect(resolveIdleCompact(config, "a/native", undefined)).toBeUndefined();
    // ...unless that layer or a higher one configures idle compaction itself.
    expect(resolveIdleCompact(config, "a/native-idle", undefined)).toEqual({ afterIdleMinutes: 30, minContextTokens: 50000 });
    expect(resolveIdleCompact(config, "a/native", "on")).toEqual({ afterIdleMinutes: 60, minContextTokens: 1000 });
  });

  it("rejects invalid idle compaction settings", () => {
    for (const idleCompact of [true, null, { enabled: "yes" }, { afterIdleMinutes: 0 }, { afterIdleMinutes: 2000 }, { afterIdleMinutes: "5" }, { afterIdleMinutes: 5, minContextTokens: 0 }, { afterIdleMinutes: 5, extra: 1 }]) {
      expect(() => parseConfigFile(JSON.stringify({ default: { idleCompact } }), "user.json"), JSON.stringify(idleCompact)).toThrow(/idleCompact/);
    }
  });
});
