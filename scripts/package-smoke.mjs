// Package smoke test: pack the tarball, check its contents for leaks, install it into a clean
// temp project next to the host-provided Pi packages, then load the compiled extension with
// plain Node and check that it registers only its compaction hooks and command, and that a
// zero-config compaction yields to Pi.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(".");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "psc-pack-"));
const fail = (message) => {
  console.error(`package smoke FAILED: ${message}`);
  process.exitCode = 1;
};
// When run from `npm publish` (prepublishOnly), npm passes publish-only config such as
// npm_config_dry_run down to lifecycle scripts; nested `npm pack`/`npm install` must not inherit it.
const childEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^npm_config_(dry_run|provenance|access|tag|otp|workspaces?)$/i.test(key)));

try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8", env: childEnv }));
  const files = packed[0].files.map((file) => file.path);
  const tgz = join(work, packed[0].filename);

  // 1) contents: compiled output and docs only
  const bad = files.filter((file) => /^(src|tests|scripts|e2e-artifacts)\//.test(file) || /\.map$/.test(file) || /(^|\/)\.(env|pi)/.test(file));
  if (bad.length) fail(`unexpected files in tarball: ${bad.join(", ")}`);
  for (const need of ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE", "CHANGELOG.md", "package.json"]) {
    if (!files.includes(need)) fail(`missing ${need}`);
  }

  // 2) no local paths, personal data or keys in shipped text
  const extract = join(work, "extract");
  mkdirSync(extract);
  execFileSync("tar", ["-xzf", tgz, "-C", extract]);
  // Generic markers only; maintainers can add private ones locally via PSC_LEAK_MARKERS
  // (comma-separated literals) without committing them.
  const extra = (process.env.PSC_LEAK_MARKERS ?? "").split(",").map((marker) => marker.trim()).filter(Boolean)
    .map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const leak = new RegExp(["\\/Users\\/", "\\/home\\/[a-z]", "sk-[A-Za-z0-9]{32,}", "AIza[0-9A-Za-z_-]{30,}", ...extra].join("|"));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
  for (const file of walk(join(extract, "package"))) {
    const match = readFileSync(file, "utf8").match(leak);
    if (match) fail(`leak marker "${match[0]}" in ${file.slice(extract.length + 1)}`);
  }

  // 3) install into a clean project with the Pi host packages and load the extension with plain Node
  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  const host = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]
    .map((name) => `${name}@${pkg.devDependencies[name]}`);
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tgz, ...host], { cwd: app, stdio: "inherit", env: childEnv });

  // An empty agent directory: the smoke test never reads the maintainer's Pi configuration.
  const agentDir = join(work, "agent");
  mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const entry = join(app, "node_modules", ...pkg.name.split("/"), pkg.pi.extensions[0]);
  const mod = await import(pathToFileURL(entry).href);
  const handlers = new Map();
  const commands = [];
  mod.default({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name) => commands.push(name),
    appendEntry: () => fail("appendEntry called during load"),
  });
  const events = [...handlers.keys()].sort();
  const expected = ["session_before_compact", "session_compact", "session_compact_failed", "session_shutdown"];
  if (JSON.stringify(events) !== JSON.stringify(expected)) fail(`unexpected event handlers: ${events.join(", ")}`);
  if (JSON.stringify(commands) !== JSON.stringify(["compact-profile"])) fail(`unexpected commands: ${commands.join(", ")}`);

  // 4) zero-config yields to Pi without touching a model
  const untouched = () => fail("zero-config compaction touched the model registry or UI");
  const result = await handlers.get("session_before_compact")(
    { reason: "manual", signal: new AbortController().signal, preparation: {}, branchEntries: [] },
    {
      cwd: work,
      mode: "print",
      hasUI: false,
      model: { provider: "smoke", id: "chat" },
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: untouched, streamSimple: untouched, complete: untouched },
      ui: { setStatus: untouched, notify: untouched },
    },
  );
  if (result !== undefined) fail(`zero-config compaction returned ${JSON.stringify(result)} instead of undefined`);

  if (!process.exitCode) console.log(`package smoke OK: ${packed[0].filename} (${files.length} files, ${packed[0].size} bytes)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
