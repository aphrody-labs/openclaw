#!/usr/bin/env bun
// pnpm -> bun migration for the OpenClaw monorepo (aphrody-labs fork).
// 1. pnpm-workspace.yaml -> package.json: workspaces, overrides (top-level names; nested a>b kept when b is unique,
//    else dropped with a report), patchedDependencies, trustedDependencies (allowBuilds=true).
// 2. Packages that depend on the root ("openclaw": "workspace:*") get "link:<rel root>" because the root is not a bun
//    workspace (bun pm migrate fails with NonExistentWorkspaceDependency otherwise).
// 3. pnpm 12 writes a two-document pnpm-lock.yaml (pnpm's own env lock first); keep only the project document.
// 4. bun pm migrate -> bun.lock with the exact pnpm-resolved versions. No install, no network.
import { relative } from "node:path";

const root = process.cwd();
const ws = Bun.YAML.parse(await Bun.file("pnpm-workspace.yaml").text()) as any;
const pkg = await Bun.file("package.json").json();

pkg.workspaces = (ws.packages as string[]).filter((p) => p !== ".");
const overrides: Record<string, string> = {};
const dropped: string[] = [];
const seen = new Map<string, string[]>();
for (const [k, v] of Object.entries<string>(ws.overrides ?? {})) {
  // bun overrides are global by name: a nested pnpm override (parent>child) must not pin the child everywhere.
  if (k.includes(">")) {
    dropped.push(`${k}=${v}`);
    continue;
  }
  const name = k.replace(/(.)@[^@/]+$/, "$1");
  seen.set(name, [...(seen.get(name) ?? []), String(v)]);
}
for (const [name, vals] of seen) {
  const uniq = [...new Set(vals)];
  if (uniq.length === 1 && uniq[0] !== "-") overrides[name] = uniq[0]!;
  else dropped.push(`${name}=${uniq.join("|")}`);
}
pkg.overrides = { ...(pkg.overrides ?? {}), ...overrides };
pkg.patchedDependencies = { ...(pkg.patchedDependencies ?? {}), ...(ws.patchedDependencies ?? {}) };
pkg.trustedDependencies = Object.entries<boolean>(ws.allowBuilds ?? {})
  .filter(([, v]) => v)
  .map(([k]) => k);
delete pkg.packageManager;
await Bun.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

let relinked = 0;
for (const pattern of pkg.workspaces as string[]) {
  for (const f of new Bun.Glob(`${pattern}/package.json`).scanSync({
    cwd: root,
    onlyFiles: true,
  })) {
    const p = await Bun.file(f).json();
    let changed = false;
    for (const sec of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      if (p[sec]?.openclaw?.startsWith("workspace:")) {
        p[sec].openclaw =
          `file:${relative(f.replace(/[\\/]package\.json$/, ""), ".").replaceAll("\\", "/") || "."}`;
        changed = true;
      }
    }
    if (changed) {
      await Bun.write(f, `${JSON.stringify(p, null, 2)}\n`);
      relinked++;
    }
  }
}

const lock = await Bun.file("pnpm-lock.yaml").text();
const docs = lock.split(/^---$/m).filter((d) => d.trim());
if (docs.length > 1)
  await Bun.write(
    "pnpm-lock.yaml",
    docs
      .find((d) => /^importers:\s*\n\s+\.:\s*\n\s+dependencies:/m.test(d) || /^settings:/m.test(d))!
      .trimStart(),
  );

const r = Bun.spawnSync(["bun", "pm", "migrate"], { stdout: "inherit", stderr: "inherit" });
console.log(
  `workspaces=${pkg.workspaces.length} overrides=${Object.keys(overrides).length} relinked=${relinked} dropped=${dropped.join(",") || "none"}`,
);
if (r.exitCode === 0) process.exit(0);

// Fallback (bun pm migrate still rejects this graph, oven-sh/bun#23026): pin every package that pnpm resolved to a
// single version as an override, so a fresh `bun install` reproduces pnpm's versions for those (multi-version
// packages keep their semver ranges and resolve per range).
const y = Bun.YAML.parse(await Bun.file("pnpm-lock.yaml").text()) as any;
const versions = new Map<string, Set<string>>();
for (const k of Object.keys(y.packages ?? {})) {
  const m = k.match(/^(@?[^@]+)@([^(]+)/);
  if (m) versions.set(m[1]!, new Set([...(versions.get(m[1]!) ?? []), m[2]!]));
}
const workspaceNames = new Set<string>();
for (const pattern of pkg.workspaces as string[])
  for (const f of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root, onlyFiles: true }))
    workspaceNames.add((await Bun.file(f).json()).name);
let pinned = 0;
for (const [name, set] of versions) {
  if (set.size !== 1 || workspaceNames.has(name) || name in pkg.overrides) continue;
  const v = [...set][0]!;
  if (!/^\d/.test(v)) continue; // skip links, tarballs, git refs
  pkg.overrides[name] = v;
  pinned++;
}
await Bun.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  `migrate failed; pinned ${pinned} single-version packages as overrides; run: bun install`,
);
process.exit(2);
