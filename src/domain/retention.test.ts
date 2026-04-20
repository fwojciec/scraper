import { assertEquals } from "@std/assert";
import { isArtifactFile, selectDeletions } from "./retention.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

Deno.test("isArtifactFile matches sN.yaml and shotN.png only", () => {
  // artifacts
  assertEquals(isArtifactFile("s1.yaml"), true);
  assertEquals(isArtifactFile("s47.yaml"), true);
  assertEquals(isArtifactFile("shot1.png"), true);
  assertEquals(isArtifactFile("shot123.png"), true);

  // not artifacts — retention must NOT touch these
  assertEquals(isArtifactFile("refs.ABC123.json"), false);
  assertEquals(isArtifactFile("counter"), false);
  assertEquals(isArtifactFile("counter-refs"), false);

  // shape must be exact
  assertEquals(isArtifactFile("s.yaml"), false);
  assertEquals(isArtifactFile("shot.png"), false);
  assertEquals(isArtifactFile("s1.log"), false);
  assertEquals(isArtifactFile("s1.yaml.bak"), false);
  assertEquals(isArtifactFile("prefix-s1.yaml"), false);
  assertEquals(isArtifactFile(""), false);
});

Deno.test("selectDeletions returns nothing when under count and within age", () => {
  const entries = [
    { name: "s1.yaml", mtimeMs: NOW - HOUR },
    { name: "s2.yaml", mtimeMs: NOW - 2 * HOUR },
    { name: "shot1.png", mtimeMs: NOW },
  ];
  assertEquals(
    selectDeletions(entries, { maxCount: 20, maxAgeMs: 24 * HOUR, nowMs: NOW }),
    [],
  );
});

Deno.test("selectDeletions drops entries beyond maxCount, oldest first", () => {
  // 25 recent entries — 5 oldest should go so the newest 20 survive
  const entries = Array.from({ length: 25 }, (_, i) => ({
    name: `s${i + 1}.yaml`,
    mtimeMs: NOW - i * 1000, // s1 newest, s25 oldest
  }));
  const deleted = selectDeletions(entries, {
    maxCount: 20,
    maxAgeMs: 24 * HOUR,
    nowMs: NOW,
  });
  assertEquals(deleted.sort(), ["s21.yaml", "s22.yaml", "s23.yaml", "s24.yaml", "s25.yaml"].sort());
});

Deno.test("selectDeletions drops entries older than maxAgeMs even under maxCount", () => {
  const entries = [
    { name: "s1.yaml", mtimeMs: NOW - HOUR },
    { name: "s2.yaml", mtimeMs: NOW - 25 * HOUR }, // 25h old — too old
    { name: "s3.yaml", mtimeMs: NOW - 48 * HOUR }, // 48h old — too old
  ];
  const deleted = selectDeletions(entries, {
    maxCount: 20,
    maxAgeMs: 24 * HOUR,
    nowMs: NOW,
  });
  assertEquals(deleted.sort(), ["s2.yaml", "s3.yaml"].sort());
});

Deno.test("selectDeletions combines count and age rules", () => {
  // 22 entries: newest 20 are recent, oldest 2 are 48h old.
  // Count rule: drops ranks 21,22. Age rule: also drops them.
  // Net: 2 deletions (union, not duplicates).
  const entries = [
    ...Array.from({ length: 20 }, (_, i) => ({
      name: `s${i + 1}.yaml`,
      mtimeMs: NOW - i * 1000,
    })),
    { name: "sOld1.yaml", mtimeMs: NOW - 48 * HOUR },
    { name: "sOld2.yaml", mtimeMs: NOW - 49 * HOUR },
  ];
  const deleted = selectDeletions(entries, {
    maxCount: 20,
    maxAgeMs: 24 * HOUR,
    nowMs: NOW,
  });
  assertEquals(deleted.sort(), ["sOld1.yaml", "sOld2.yaml"].sort());
});

Deno.test("selectDeletions treats exact-age boundary as surviving", () => {
  // File modified exactly maxAgeMs ago is NOT older than the policy.
  // Strictly greater-than-age is the rule.
  const entries = [
    { name: "s1.yaml", mtimeMs: NOW - 24 * HOUR }, // exactly 24h → survives
    { name: "s2.yaml", mtimeMs: NOW - 24 * HOUR - 1 }, // 24h + 1ms → deleted
  ];
  const deleted = selectDeletions(entries, {
    maxCount: 20,
    maxAgeMs: 24 * HOUR,
    nowMs: NOW,
  });
  assertEquals(deleted, ["s2.yaml"]);
});

Deno.test("selectDeletions returns [] for empty entries", () => {
  assertEquals(
    selectDeletions([], { maxCount: 20, maxAgeMs: 24 * HOUR, nowMs: NOW }),
    [],
  );
});
