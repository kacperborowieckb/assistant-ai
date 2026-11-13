import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const repository = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

const readJson = (path) =>
  JSON.parse(readFileSync(nodePath.resolve(repository, path), "utf-8"));

const requireText = (value, label) => {
  assert.ok(
    typeof value === "string" && value.trim().length > 0,
    `${label} must be nonempty text`
  );
};

const requirePath = (value) => {
  requireText(value, "Path");
  assert.ok(
    !nodePath.isAbsolute(value) && !value.split("/").includes(".."),
    `Use a repository-relative path: ${value}`
  );
  const resolved = nodePath.resolve(repository, value);
  assert.ok(existsSync(resolved), `Missing path: ${value}`);
  const location = nodePath.relative(repository, realpathSync(resolved));
  assert.ok(
    location !== ".." && !location.startsWith(`..${nodePath.sep}`),
    `Path escapes repository: ${value}`
  );
};

const requireUnique = (values, label) => {
  assert.equal(new Set(values).size, values.length, `Duplicate ${label}`);
};

const workspacePaths = ["apps", "packages"].flatMap((parent) =>
  readdirSync(nodePath.resolve(repository, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
    .filter((path) =>
      existsSync(nodePath.resolve(repository, path, "package.json"))
    )
);

const { primitives } = readJson("docs/primitives/catalog.json");
assert.ok(Array.isArray(primitives), "Catalog must contain a primitives array");
requireUnique(
  primitives.map((primitive) => primitive.id),
  "primitive IDs"
);

for (const primitive of primitives) {
  requireText(primitive.id, "Primitive ID");
  requireText(primitive.purpose, `${primitive.id} purpose`);
  assert.ok(
    Array.isArray(primitive.roots) && primitive.roots.length > 0,
    `${primitive.id} needs code roots`
  );
  assert.ok(
    Array.isArray(primitive.adrs),
    `${primitive.id} needs an adrs array`
  );
  for (const path of primitive.roots) {
    requirePath(path);
    assert.ok(
      workspacePaths.some(
        (workspace) => path === workspace || path.startsWith(`${workspace}/`)
      ),
      `Code root must belong to a workspace: ${path}`
    );
  }
  for (const path of primitive.adrs) {
    requirePath(path);
    assert.ok(
      path.startsWith("docs/decisions/") && path.endsWith(".md"),
      `Invalid decision path: ${path}`
    );
    assert.match(
      readFileSync(nodePath.resolve(repository, path), "utf-8"),
      /^Status: accepted\s*$/mu,
      `Decision must be current and accepted: ${path}`
    );
  }
}

const { targets } = readJson("docs/verification/targets.json");
assert.ok(Array.isArray(targets), "Verification must contain a targets array");
requireUnique(
  targets.map((target) => target.workspace),
  "verification workspaces"
);

for (const target of targets) {
  assert.ok(
    workspacePaths.includes(target.workspace),
    `Unknown verification workspace: ${target.workspace}`
  );
  requirePath(target.guide);
  assert.ok(
    target.guide.endsWith(".md"),
    `Verification guide must be Markdown: ${target.guide}`
  );
  requireText(
    readFileSync(nodePath.resolve(repository, target.guide), "utf-8"),
    `${target.guide} content`
  );
}

for (const workspace of workspacePaths) {
  assert.ok(
    primitives.some((primitive) =>
      primitive.roots.some(
        (path) => path === workspace || path.startsWith(`${workspace}/`)
      )
    ),
    `Add a primitives catalog entry for ${workspace}`
  );
  assert.ok(
    targets.some((target) => target.workspace === workspace),
    `Add a verification target and guide for ${workspace}`
  );
  const manifest = readJson(`${workspace}/package.json`);
  requireText(manifest.scripts?.verify, `${workspace} verify script`);
}
