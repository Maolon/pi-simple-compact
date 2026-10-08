import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getSessionProfile,
  loadProfileConfig,
  parseConfigFile,
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
});
