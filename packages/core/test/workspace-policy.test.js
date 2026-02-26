import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertWorkspaceAllowed,
  createWorkspaceBoundaryPolicy,
  isPathInside,
  normalizeAbsolutePath,
  parseWorkspaceAllowedRoots,
} from "../dist/workspace-policy.js";

test("parseWorkspaceAllowedRoots resolves relative, absolute, home and de-duplicates", () => {
  const cwd = path.resolve(os.tmpdir(), "copilot-hub", "workspace-policy");
  const absoluteRoot = path.resolve(cwd, "absolute-root");
  const result = parseWorkspaceAllowedRoots(`./root-a,${absoluteRoot},~/root-b,./root-a`, { cwd });

  assert.deepEqual(result, [
    path.resolve(cwd, "root-a"),
    absoluteRoot,
    path.resolve(os.homedir(), "root-b"),
  ]);
});

test("createWorkspaceBoundaryPolicy normalizes and de-duplicates allowed roots", () => {
  const kernelRootPath = path.resolve(os.tmpdir(), "kernel");
  const defaultWorkspaceRoot = path.resolve(os.tmpdir(), "workspaces", "default");
  const projectsBaseDir = path.resolve(os.tmpdir(), "workspaces");

  const policy = createWorkspaceBoundaryPolicy({
    kernelRootPath,
    defaultWorkspaceRoot,
    projectsBaseDir,
    additionalAllowedRoots: [
      defaultWorkspaceRoot,
      path.resolve(os.tmpdir(), "workspaces", "extra"),
    ],
  });

  assert.equal(policy.strictMode, true);
  assert.deepEqual(policy.allowedRoots, [
    defaultWorkspaceRoot,
    projectsBaseDir,
    path.resolve(os.tmpdir(), "workspaces", "extra"),
  ]);
});

test("assertWorkspaceAllowed rejects workspace inside kernel root", () => {
  const kernelRootPath = path.resolve(os.tmpdir(), "kernel-root");
  const policy = createWorkspaceBoundaryPolicy({
    kernelRootPath,
    defaultWorkspaceRoot: path.resolve(os.tmpdir(), "workspaces", "default"),
    projectsBaseDir: path.resolve(os.tmpdir(), "workspaces"),
    strictMode: false,
  });

  assert.throws(
    () =>
      assertWorkspaceAllowed({
        workspaceRoot: path.join(kernelRootPath, "project-a"),
        policy,
      }),
    /must be outside kernel directory/,
  );
});

test("assertWorkspaceAllowed enforces strict allowed roots when strict mode is enabled", () => {
  const policy = createWorkspaceBoundaryPolicy({
    kernelRootPath: path.resolve(os.tmpdir(), "kernel"),
    defaultWorkspaceRoot: path.resolve(os.tmpdir(), "workspaces", "default"),
    projectsBaseDir: path.resolve(os.tmpdir(), "workspaces", "projects"),
    strictMode: true,
  });

  const allowed = assertWorkspaceAllowed({
    workspaceRoot: path.resolve(os.tmpdir(), "workspaces", "projects", "project-a"),
    policy,
  });
  assert.equal(allowed, path.resolve(os.tmpdir(), "workspaces", "projects", "project-a"));

  assert.throws(
    () =>
      assertWorkspaceAllowed({
        workspaceRoot: path.resolve(os.tmpdir(), "outside-workspaces"),
        policy,
      }),
    /outside allowed workspace roots/,
  );
});

test("assertWorkspaceAllowed allows outside roots when strict mode is disabled", () => {
  const policy = createWorkspaceBoundaryPolicy({
    kernelRootPath: path.resolve(os.tmpdir(), "kernel"),
    defaultWorkspaceRoot: path.resolve(os.tmpdir(), "workspaces", "default"),
    projectsBaseDir: path.resolve(os.tmpdir(), "workspaces"),
    strictMode: false,
  });

  const accepted = assertWorkspaceAllowed({
    workspaceRoot: path.resolve(os.tmpdir(), "another-root", "project-a"),
    policy,
  });

  assert.equal(accepted, path.resolve(os.tmpdir(), "another-root", "project-a"));
});

test("isPathInside handles equal paths and nested paths", () => {
  const parent = path.resolve(os.tmpdir(), "workspace-parent");
  const child = path.join(parent, "child");
  const outside = path.resolve(os.tmpdir(), "outside");

  assert.equal(isPathInside(parent, parent), false);
  assert.equal(isPathInside(parent, parent, { includeEqual: true }), true);
  assert.equal(isPathInside(parent, child), true);
  assert.equal(isPathInside(parent, outside), false);
});

test("normalizeAbsolutePath resolves paths and rejects empty values", () => {
  assert.equal(normalizeAbsolutePath("./local-path"), path.resolve("./local-path"));
  assert.throws(() => normalizeAbsolutePath("   "), /Path cannot be empty/);
});
