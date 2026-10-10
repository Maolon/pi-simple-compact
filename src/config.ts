import { access, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
  /** Compact an idle session after its prompt cache went cold. `false` is `{ enabled: false }`. */
  idleCompact?: IdleCompactConfig;
}

/** One layer's idle-compaction fields; merged per field with the same precedence as the profile. */
export interface IdleCompactConfig {
  /** Defaults to true once any layer configures idle compaction. */
  enabled?: boolean;
  /** Minutes without activity after a run ends; set this to the chat provider's cache retention. */
  afterIdleMinutes?: number;
  /** Skip idle compaction below this many context tokens. */
  minContextTokens?: number;
}

/** Resolved, enabled idle-compaction policy. */
export interface IdleCompactOptions {
  afterIdleMinutes: number;
  minContextTokens: number;
}

export const DEFAULT_IDLE_AFTER_MINUTES = 60;
/** Below this a cold-cache resend is cheaper than a summary call. */
export const DEFAULT_IDLE_MIN_CONTEXT_TOKENS = 50_000;
const IDLE_FIELDS = ["enabled", "afterIdleMinutes", "minContextTokens"] as const;

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
const PROMPT_PLACEHOLDERS: readonly string[] = ["conversation", "previousSummary", "turnPrefix", "customInstructions"];
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
    if (!PROFILE_FIELDS.includes(key as ProfileField) && key !== "pipeline" && key !== "idleCompact") {
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
    for (const match of value.prompt.matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (!PROMPT_PLACEHOLDERS.includes(match[1]!)) {
        throw new Error(`${where}.prompt has unsupported placeholder {{${match[1]}}}; use ${PROMPT_PLACEHOLDERS.map((key) => `{{${key}}}`).join(", ")}`);
      }
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
  if ("idleCompact" in value) profile.idleCompact = parseIdleCompact(value.idleCompact, `${where}.idleCompact`);
  if (profile.prompt && profile.pipeline) {
    throw new Error(`${where} cannot combine the top-level replacement prompt with a nested pipeline`);
  }
  return profile;
}

function parseIdleCompact(value: unknown, where: string): IdleCompactConfig {
  if (value === false) return { enabled: false };
  if (!isObject(value)) throw new Error(`${where} must be an object or false`);
  for (const key of Object.keys(value)) {
    if (!IDLE_FIELDS.includes(key as (typeof IDLE_FIELDS)[number])) throw new Error(`${where} has unknown field ${JSON.stringify(key)}`);
  }
  const options: IdleCompactConfig = {};
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") throw new Error(`${where}.enabled must be true or false`);
    options.enabled = value.enabled;
  }
  if ("afterIdleMinutes" in value) {
    const minutes = value.afterIdleMinutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      throw new Error(`${where}.afterIdleMinutes must be a number of minutes from 1 to 1440`);
    }
    options.afterIdleMinutes = minutes;
  }
  if ("minContextTokens" in value) {
    if (!Number.isSafeInteger(value.minContextTokens) || (value.minContextTokens as number) < 1) {
      throw new Error(`${where}.minContextTokens must be a positive integer`);
    }
    options.minContextTokens = value.minContextTokens as number;
  }
  return options;
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

/**
 * Changes only `default.idleCompact` in the user config file, keeping every other field. The
 * result is validated before it is written, so a command can never leave a broken file; an
 * existing invalid file is reported, never overwritten. The write is atomic and keeps the mode.
 */
export async function updateUserIdleDefault(
  agentDir: string,
  update: (current: IdleCompactConfig | undefined) => IdleCompactConfig,
): Promise<IdleCompactConfig> {
  const path = join(agentDir, CONFIG_FILE_NAME);
  let raw: Record<string, unknown> = {};
  let mode = 0o600;
  try {
    const text = await readFile(path, "utf8");
    const parsed = parseConfigFile(text, path);
    raw = JSON.parse(text) as Record<string, unknown>;
    mode = (await stat(path)).mode & 0o777;
    const next = update(parsed.default?.idleCompact);
    raw.default = { ...(isObject(raw.default) ? raw.default : {}), idleCompact: next };
  } catch (error) {
    if (!(isObject(error) && error.code === "ENOENT")) throw error;
    raw = { default: { idleCompact: update(undefined) } };
  }
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  const written = parseConfigFile(text, path).default!.idleCompact!;
  await mkdir(agentDir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
  return written;
}

/** Where the effective idle setting for a session comes from, for status reports. */
export function describeIdleSource(
  config: LoadedProfileConfig,
  activeChatModel: string | undefined,
  sessionProfile: string | undefined,
): string | undefined {
  if (sessionProfile === "native") return "session profile native";
  if (sessionProfile !== undefined) {
    if (config.project.profiles?.[sessionProfile]?.idleCompact !== undefined || config.user.profiles?.[sessionProfile]?.idleCompact !== undefined) {
      return `session profile ${sessionProfile}`;
    }
  }
  const layers: Array<[string, CompactProfile | undefined]> = [
    [`project models.${activeChatModel}`, activeChatModel ? config.project.models?.[activeChatModel] : undefined],
    [`models.${activeChatModel}`, activeChatModel ? config.user.models?.[activeChatModel] : undefined],
    ["project default", config.project.default],
  ];
  for (const [name, layer] of layers) {
    if (layer?.idleCompact !== undefined) return name;
    if (layer?.mode === "native") return `${name} (mode native)`;
  }
  return undefined;
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

/**
 * Idle policy for the active chat model, with the same layers and precedence as `resolveProfile`
 * (session > project model > user model > project default > user default). Fields merge one by
 * one. It is resolved apart from the summarizer fields because it is a trigger, not a summarizer
 * choice: a profile with only `idleCompact` keeps Pi's native summarizer. A `native` layer means
 * Pi's own behavior, which has no idle compaction: when nothing above configured idle compaction,
 * it ends inheritance, exactly as it does for summarizer fields; a session `native` override
 * always turns it off.
 */
export function resolveIdleCompact(
  config: LoadedProfileConfig,
  activeChatModel: string | undefined,
  sessionProfile: string | undefined,
): IdleCompactOptions | undefined {
  if (sessionProfile === "native") return undefined;
  const named: Array<CompactProfile | undefined> = [];
  if (sessionProfile !== undefined) {
    named.push(config.project.profiles?.[sessionProfile], config.user.profiles?.[sessionProfile]);
    if (!named[0] && !named[1]) throw new Error(`Unknown compaction profile ${JSON.stringify(sessionProfile)}`);
  }
  const layers = [
    ...named,
    activeChatModel ? config.project.models?.[activeChatModel] : undefined,
    activeChatModel ? config.user.models?.[activeChatModel] : undefined,
    config.project.default,
    config.user.default,
  ];
  const merged: IdleCompactConfig = {};
  let configured = false;
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.mode === "native" && !configured && layer.idleCompact === undefined) break;
    if (layer.idleCompact === undefined) continue;
    configured = true;
    for (const field of IDLE_FIELDS) {
      if (merged[field] === undefined && layer.idleCompact[field] !== undefined) {
        Object.assign(merged, { [field]: layer.idleCompact[field] });
      }
    }
  }
  if (!configured || merged.enabled === false) return undefined;
  return {
    afterIdleMinutes: merged.afterIdleMinutes ?? DEFAULT_IDLE_AFTER_MINUTES,
    minContextTokens: merged.minContextTokens ?? DEFAULT_IDLE_MIN_CONTEXT_TOKENS,
  };
}
