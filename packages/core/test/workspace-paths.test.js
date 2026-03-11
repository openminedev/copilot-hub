import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  resolveExternalWorkspaceBasePath,
  resolveKernelRootPath,
} from "../dist/workspace-paths.js";

test("resolveKernelRootPath prefers explicit env override", () => {
  const expected = path.resolve("/tmp/custom/copilot-hub");
  const resolved = resolveKernelRootPath({
    env: {
      COPILOT_HUB_KERNEL_ROOT: expected,
    },
    moduleUrl: "file:///ignored/path.js",
    cwd: "/tmp/ignored",
  });

  assert.equal(resolved, expected);
});

test("resolveKernelRootPath falls back to the package root derived from module url", () => {
  const repoRoot = path.join(os.tmpdir(), "copilot-hub");
  const modulePath = path.join(repoRoot, "packages", "core", "dist", "workspace-paths.js");
  const resolved = resolveKernelRootPath({
    env: {},
    moduleUrl: pathToFileURL(modulePath).href,
    cwd: path.join(os.tmpdir(), "ignored"),
  });

  assert.equal(resolved, path.resolve(repoRoot));
});

test("resolveExternalWorkspaceBasePath avoids workspace roots inside the kernel directory", () => {
  const kernelRootPath = path.resolve("/tmp/Desktop");
  const resolved = resolveExternalWorkspaceBasePath({
    kernelRootPath,
    desktopCandidates: [path.resolve("/tmp/Desktop")],
    homeDir: path.resolve("/tmp/home"),
    tempDir: path.resolve(os.tmpdir()),
  });

  assert.equal(resolved, path.resolve("/tmp/home", "copilot_workspaces"));
});
