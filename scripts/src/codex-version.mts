export const codexNpmPackage = "@openai/codex";
export const minimumCodexVersion = "0.113.0";
export const maximumCodexVersionExclusive = "0.114.0";
export const codexInstallPackageSpec = `${codexNpmPackage}@${minimumCodexVersion}`;
export const codexVersionRequirementLabel = `>= ${minimumCodexVersion} < ${maximumCodexVersionExclusive}`;

type Semver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function extractSemver(value: string): string {
  const match = String(value ?? "").match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/);
  return String(match?.[0] ?? "").trim();
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    return 0;
  }

  if (a.major !== b.major) {
    return a.major > b.major ? 1 : -1;
  }
  if (a.minor !== b.minor) {
    return a.minor > b.minor ? 1 : -1;
  }
  if (a.patch !== b.patch) {
    return a.patch > b.patch ? 1 : -1;
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) {
    return 0;
  }
  if (a.prerelease.length === 0) {
    return 1;
  }
  if (b.prerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftValue = Number.parseInt(leftPart, 10);
      const rightValue = Number.parseInt(rightPart, 10);
      if (leftValue !== rightValue) {
        return leftValue > rightValue ? 1 : -1;
      }
      continue;
    }
    if (leftNumeric) {
      return -1;
    }
    if (rightNumeric) {
      return 1;
    }
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

export function isCodexVersionCompatible(version: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease.length > 0) {
    return false;
  }

  return (
    compareSemver(version, minimumCodexVersion) >= 0 &&
    compareSemver(version, maximumCodexVersionExclusive) < 0
  );
}

function parseSemver(value: string): Semver | null {
  const normalized = extractSemver(value);
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) {
    return null;
  }

  const prerelease = String(match[4] ?? "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    major: Number.parseInt(match[1] ?? "", 10),
    minor: Number.parseInt(match[2] ?? "", 10),
    patch: Number.parseInt(match[3] ?? "", 10),
    prerelease,
  };
}
