import { compare, coerce, eq, prerelease, valid } from "semver";

function normalized(version: string): string | null {
  return valid(version) ?? coerce(version)?.version ?? null;
}

/** semver.compare semantics: positive when `a` is newer than `b`. */
export function versionCompare(a: string, b: string): number {
  const left = normalized(a);
  const right = normalized(b);
  if (left && right) return compare(left, right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function versionsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const left = valid(a);
  const right = valid(b);
  if (left && right) return eq(left, right);
  return false;
}

export function isPreRelease(version: string, flagged = false): boolean {
  if (flagged) return true;
  const direct = valid(version);
  if (direct && prerelease(direct)) return true;
  return false;
}

export const VERSION_ALIASES = new Set(["latest", "pre-release", "prerelease", "preview"]);
