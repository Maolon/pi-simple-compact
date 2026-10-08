import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { CompactThinkingLevel, HistoryKind, PipelineOptions, PipelineRoute } from "./pipeline.ts";

export const CONFIG_FILE_NAME = "pi-simple-compact.json";
export const SESSION_PROFILE_ENTRY = "pi-simple-compact:profile";

export interface CompactProfile {
  /** Exact provider/modelId used for compaction only. */
  model?: string;
  /** Replacement prompt. When omitted, the native Pi prompt is retained. */
  prompt?: string;
  /** Compact-only summarizer thinking level; never changes the chat session's thinking setting. */
  thinkingLevel?: CompactThinkingLevel;
  /** An explicit native choice suppresses every inherited profile field. */
  mode?: "native";
  /** Configured failures fail compaction unless native fallback was explicitly requested. */
  failurePolicy?: "fail" | "native";
  /** Typed per-kind processing; mutually exclusive with the top-level whole-summary prompt. */
  pipeline?: PipelineOptions;
}

export interface ProfileConfigFile {
  default?: CompactProfile;
  models?: Record<string, CompactProfile>;
  profiles?: Record<string, CompactProfile>;
}

export interface LoadedProfileConfig {
  user: ProfileConfigFile;
  project: ProfileConfigFile;
}

export type SessionProfileEntry = {
  type: "custom";
  customType: string;
  data?: unknown;
};

type ProfileField = "model" | "prompt" | "thinkingLevel" | "mode" | "failurePolicy";
const PROFILE_FIELDS: readonly ProfileField[] = ["model", "prompt", "thinkingLevel", "mode", "failurePolicy"];
const COMPACT_THINKING_LEVELS: readonly CompactThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PIPELINE_FIELDS = ["model", "prompt", "routes", "maxInputChars", "maxOutputChars", "maxOutputTokens"] as const;
const PIPELINE_ROUTE_FIELDS = ["model", "prompt", "reducer"] as const;
const HISTORY_KINDS: readonly HistoryKind[] = [
  "user", "assistant", "thinking", "toolCall", "toolResult", "custom", "bashExecution", "branchSummary",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProfile(value: unknown, where: string): CompactProfile {
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!PROFILE_FIELDS.includes(key as ProfileField) && key !== "pipeline") {
      throw new Error(`${where} has unknown field ${JSON.stringify(key)}`);
    }
  }
  const profile: CompactProfile = {};
  if ("model" in value) {
    if (typeof value.model !== "string" || !value.model.trim()) {
      throw new Error(`${where}.model must be an exact provider/modelId string`);
    }
    const modelName = value.model.trim();
    const separator = modelName.indexOf("/");
    if (separator < 1 || separator === modelName.length - 1) {
      throw new Error(`${where}.model must be an exact provider/modelId string`);
    }
    profile.model = modelName;
  }
  if ("prompt" in value) {
    if (typeof value.prompt !== "string" || !value.prompt.trim()) {
      throw new Error(`${where}.prompt must be a non-empty string`);
    }
    profile.prompt = value.prompt;
  }
  if ("thinkingLevel" in value) {
    if (typeof value.thinkingLevel !== "string" || !COMPACT_THINKING_LEVELS.includes(value.thinkingLevel as CompactThinkingLevel)) {
      throw new Error(`${where}.thinkingLevel must be one of ${COMPACT_THINKING_LEVELS.map((level) => JSON.stringify(level)).join(", ")}`);
    }
    profile.thinkingLevel = value.thinkingLevel as CompactThinkingLevel;
  }
  if ("mode" in value) {
    if (value.mode !== "native") throw new Error(`${where}.mode must be "native" when present`);
    profile.mode = "native";
  }
  if ("failurePolicy" in value) {
    if (value.failurePolicy !== "fail" && value.failurePolicy !== "native") {
      throw new Error(`${where}.failurePolicy must be "fail" or "native"`);
    }
    profile.failurePolicy = value.failurePolicy;
  }
  if ("pipeline" in value) profile.pipeline = parsePipelineOptions(value.pipeline, `${where}.pipeline`);
  if (profile.prompt && profile.pipeline) {
    throw new Error(`${where} cannot combine the top-level replacement prompt with a nested pipeline`);
  }
  return profile;
}

function parsePipelineOptions(value: unknown, where: string): PipelineOptions {
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!PIPELINE_FIELDS.includes(key as (typeof PIPELINE_FIELDS)[number])) {
      throw new Error(`${where} has unknown field ${JSON.stringify(key)}`);
    }
  }
  const options: PipelineOptions = {};
  if ("model" in value) {
    options.model = parseModelSelector(value.model, `${where}.model`);
  }
  if ("prompt" in value) {
    if (typeof value.prompt !== "string" || !value.prompt.trim()) {
      throw new Error(`${where}.prompt must be a non-empty string`);
    }
    options.prompt = value.prompt;
  }
  if ("routes" in value) {
    if (!isObject(value.routes)) throw new Error(`${where}.routes must be an object`);
    const routes: Partial<Record<HistoryKind, PipelineRoute>> = {};
    for (const [kind, rawRoute] of Object.entries(value.routes)) {
      if (!HISTORY_KINDS.includes(kind as HistoryKind)) throw new Error(`${where}.routes has unsupported history kind ${JSON.stringify(kind)}`);
      if (!isObject(rawRoute)) throw new Error(`${where}.routes.${kind} must be an object`);
      for (const field of Object.keys(rawRoute)) {
        if (!PIPELINE_ROUTE_FIELDS.includes(field as (typeof PIPELINE_ROUTE_FIELDS)[number])) {
          throw new Error(`${where}.routes.${kind} has unknown field ${JSON.stringify(field)}`);
        }
      }
      const route: PipelineRoute = {};
      if ("model" in rawRoute) route.model = parseModelSelector(rawRoute.model, `${where}.routes.${kind}.model`);
      if ("prompt" in rawRoute) {
        if (typeof rawRoute.prompt !== "string" || !rawRoute.prompt.trim()) {
          throw new Error(`${where}.routes.${kind}.prompt must be a non-empty string`);
        }
        route.prompt = rawRoute.prompt;
      }
      if ("reducer" in rawRoute) {
        if (typeof rawRoute.reducer !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rawRoute.reducer)) {
          throw new Error(`${where}.routes.${kind}.reducer must be a registered reducer name`);
        }
        route.reducer = rawRoute.reducer;
      }
      routes[kind as HistoryKind] = route;
    }
    options.routes = routes;
  }
  for (const field of ["maxInputChars", "maxOutputChars", "maxOutputTokens"] as const) {
    if (field in value) {
      const minimum = field === "maxOutputChars" ? 128 : 1;
      const limit = value[field];
      if (!Number.isSafeInteger(limit) || (limit as number) < minimum) {
        throw new Error(`${where}.${field} must be an integer of at least ${minimum}`);
      }
      options[field] = limit as number;
    }
  }
  return options;
}

function parseModelSelector(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be an exact provider/modelId string`);
  const modelName = value.trim();
  const separator = modelName.indexOf("/");
  if (separator < 1 || separator === modelName.length - 1) {
    throw new Error(`${where} must be an exact provider/modelId string`);
  }
  return modelName;
}

function parseProfileMap(value: unknown, where: string): Record<string, CompactProfile> {
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  const profiles: Record<string, CompactProfile> = {};
  for (const [name, profile] of Object.entries(value)) {
    if (!name.trim() || name.trim() !== name) throw new Error(`${where} contains an invalid key`);
    if (where.endsWith(".models")) {
      const separator = name.indexOf("/");
      if (separator < 1 || separator === name.length - 1) {
        throw new Error(`${where}.${name} must be an exact provider/modelId key`);
      }
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "native" || name === "reset") {
      throw new Error(`${where}.${name} is not a selectable profile name`);
    }
    profiles[name] = parseProfile(profile, `${where}.${name}`);
  }
  return profiles;
}

export function parseConfigFile(text: string, source: string): ProfileConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // Report only the location: JSON engine messages can quote parts of the file.
    const message = error instanceof Error ? error.message : "";
    const position = /\bposition (\d+)/.exec(message);
    const atEnd = /end of JSON input/i.test(message);
    let location = "";
    if (position || atEnd) {
      const offset = position ? Math.min(Number(position[1]), text.length) : text.length;
      const before = text.slice(0, offset).split("\n");
      location = ` (line ${before.length}, column ${before.at(-1)!.length + 1})`;
    }
    throw new Error(`${source} is not valid JSON${location}`);
  }
  if (!isObject(raw)) throw new Error(`${source} must contain a JSON object`);
  for (const key of Object.keys(raw)) {
    if (key !== "default" && key !== "models" && key !== "profiles") {
      throw new Error(`${source} has unknown field ${JSON.stringify(key)}`);
    }
  }
  const config: ProfileConfigFile = {};
  if ("default" in raw) config.default = parseProfile(raw.default, `${source}.default`);
  if ("models" in raw) config.models = parseProfileMap(raw.models, `${source}.models`);
  if ("profiles" in raw) config.profiles = parseProfileMap(raw.profiles, `${source}.profiles`);
  return config;
}

async function readConfig(path: string): Promise<ProfileConfigFile> {
  try {
    return parseConfigFile(await readFile(path, "utf8"), path);
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

async function hasPiTrustCompanion(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, ".pi", "settings.json"), constants.F_OK);
    return true;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function loadProfileConfig(agentDir: string, cwd: string, projectTrusted: boolean): Promise<LoadedProfileConfig> {
  // Both reads join one Promise.all immediately: a user-file rejection that settles while the
  // trust check is pending must never become an unhandled rejection (Pi exits on those).
  const [user, project] = await Promise.all([
    readConfig(join(agentDir, CONFIG_FILE_NAME)),
    (async (): Promise<ProfileConfigFile> => (
      projectTrusted && await hasPiTrustCompanion(cwd) ? readConfig(join(cwd, ".pi", CONFIG_FILE_NAME)) : {}
    ))(),
  ]);
  return { user, project };
}

export function getSessionProfile(entries: readonly SessionProfileEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== SESSION_PROFILE_ENTRY) continue;
    const data = entry.data;
    if (!isObject(data) || data.version !== 1) {
      throw new Error(`Invalid ${SESSION_PROFILE_ENTRY} session entry`);
    }
    if (data.profile === null) return undefined;
    if (typeof data.profile !== "string" || !data.profile.trim()) {
      throw new Error(`Invalid ${SESSION_PROFILE_ENTRY} profile name`);
    }
    return data.profile;
  }
  return undefined;
}

function mergePipelineLayers(layers: readonly (PipelineOptions | undefined)[]): PipelineOptions | undefined {
  const merged: PipelineOptions = {};
  const routes: Partial<Record<HistoryKind, PipelineRoute>> = {};
  let defined = false;
  for (const layer of layers) {
    if (!layer) continue;
    defined = true;
    for (const field of PIPELINE_FIELDS) {
      if (field === "routes") continue;
      if (merged[field] === undefined && layer[field] !== undefined) {
        Object.assign(merged, { [field]: layer[field] });
      }
    }
    for (const [kind, route] of Object.entries(layer.routes ?? {}) as Array<[HistoryKind, PipelineRoute]>) {
      const target = routes[kind] ?? {};
      for (const field of PIPELINE_ROUTE_FIELDS) {
        if (target[field] === undefined && route[field] !== undefined) {
          Object.assign(target, { [field]: route[field] });
        }
      }
      routes[kind] = target;
    }
  }
  if (!defined) return undefined;
  if (Object.keys(routes).length > 0) merged.routes = routes;
  return merged;
}

function mergeProfileLayers(layers: readonly (CompactProfile | undefined)[]): CompactProfile | undefined {
  const merged: CompactProfile = {};
  const pipelineLayers: PipelineOptions[] = [];
  let hasPipelineAbove = false;
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.mode === "native") {
      if (merged.model === undefined && merged.prompt === undefined && !hasPipelineAbove) return { mode: "native" };
      continue;
    }
    for (const field of PROFILE_FIELDS) {
      if (merged[field] === undefined && layer[field] !== undefined) {
        Object.assign(merged, { [field]: layer[field] });
      }
    }
    if (layer.pipeline) {
      pipelineLayers.push(layer.pipeline);
      hasPipelineAbove = true;
    }
  }
  merged.pipeline = mergePipelineLayers(pipelineLayers);
  if (merged.prompt && merged.pipeline) {
    throw new Error("Resolved compact profile cannot combine the top-level replacement prompt with a nested pipeline");
  }
  return PROFILE_FIELDS.some((field) => merged[field] !== undefined) || merged.pipeline !== undefined ? merged : undefined;
}

export function resolveProfile(
  config: LoadedProfileConfig,
  activeChatModel: string | undefined,
  sessionProfile: string | undefined,
): CompactProfile | undefined {
  let sessionLayer: CompactProfile | undefined;
  if (sessionProfile !== undefined) {
    if (sessionProfile === "native") return { mode: "native" };
    const projectNamed = config.project.profiles?.[sessionProfile];
    const userNamed = config.user.profiles?.[sessionProfile];
    if (!projectNamed && !userNamed) {
      throw new Error(
        `This session selected compaction profile ${JSON.stringify(sessionProfile)}, which is no longer configured. Run /compact-profile reset or choose another profile`,
      );
    }
    sessionLayer = mergeProfileLayers([projectNamed, userNamed]);
  }

  const layers = [
    sessionLayer,
    activeChatModel ? config.project.models?.[activeChatModel] : undefined,
    activeChatModel ? config.user.models?.[activeChatModel] : undefined,
    config.project.default,
    config.user.default,
  ];
  return mergeProfileLayers(layers);
}
