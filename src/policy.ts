import type { UpdateStatus } from "./types.js";
import { formatAge, parseDuration } from "./util.js";
import { versionCompare, versionsEqual } from "./version.js";

export interface DecisionInput {
  installed: string;
  latest: string | null;
  publishedAt: string | null;
  now: number;
  minAge: string | null;
  pin: string | null;
}

export interface Decision {
  status: UpdateStatus;
  reasons: string[];
}

export function decideUpdate(input: DecisionInput): Decision {
  const reasons: string[] = [];
  const minAgeMs = input.minAge ? parseDuration(input.minAge) : null;
  const pinnedElsewhere = input.pin !== null && !versionsEqual(input.installed, input.pin);

  if (!input.latest) {
    if (pinnedElsewhere && input.pin) {
      return { status: "held", reasons: [`pinned to ${input.pin}`, "latest version was not found on a registry"] };
    }
    return { status: "unknown", reasons: ["latest version was not found on a registry"] };
  }

  const sameAsLatest = versionsEqual(input.installed, input.latest);
  if (input.pin && !versionsEqual(input.pin, input.latest)) {
    reasons.push(`pinned to ${input.pin}`);
  } else if (pinnedElsewhere && input.pin && sameAsLatest) {
    reasons.push(`pinned to ${input.pin}; installed ${input.installed} does not match the pin`);
  }

  if (!sameAsLatest && versionCompare(input.latest, input.installed) > 0) {
    const age = ageOf(input.publishedAt, input.now);
    if (minAgeMs !== null && minAgeMs > 0) {
      if (age === null) {
        reasons.push(`cooldown ${input.minAge}: publish time is unknown, so the update stays held`);
      } else if (age < minAgeMs) {
        reasons.push(`cooldown ${input.minAge}: published ${formatAge(age)} ago`);
      }
    }
  } else if (!sameAsLatest && versionCompare(input.latest, input.installed) < 0) {
    reasons.push(`installed ${input.installed} is newer than registry ${input.latest}`);
  }

  if (sameAsLatest && reasons.length === 0) return { status: "up-to-date", reasons: [] };
  if (reasons.length > 0) return { status: "held", reasons };
  if (sameAsLatest) return { status: "up-to-date", reasons: [] };
  const age = ageOf(input.publishedAt, input.now);
  const ageNote = age === null ? "publish time unknown" : `published ${formatAge(age)} ago`;
  return { status: "allowed", reasons: [ageNote] };
}

function ageOf(publishedAt: string | null, now: number): number | null {
  if (!publishedAt) return null;
  const time = Date.parse(publishedAt);
  if (Number.isNaN(time)) return null;
  return Math.max(0, now - time);
}
