import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ALL_PROVIDER_IDS,
  PROVIDER_SELECTION_SURFACES,
  isRoomResidentProvider,
  isSelectableProvider,
  isWorkflowWriterProvider,
  mentionedProviderId,
  modelListingProviderIds,
  parseProviderMentionTarget,
  providerExclusionReason,
  roomResidentProviderIds,
  selectableProviderIds,
} from "../src/providers/selection.ts";
import { providerBillingModel } from "../src/providers/billing.ts";
import type { ProviderId } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("every provider id is classified on every selection surface", () => {
  assert.ok(ALL_PROVIDER_IDS.includes("local"));
  for (const id of ["fake", "codex", "claude", "grok", "local"] as const) {
    assert.ok(ALL_PROVIDER_IDS.includes(id), id);
    // Cross-check against the other total table: the two must cover the same ids.
    assert.ok(providerBillingModel(id).length > 0);
  }
  for (const surface of PROVIDER_SELECTION_SURFACES) {
    for (const id of ALL_PROVIDER_IDS) {
      const selectable = selectableProviderIds(surface).includes(id);
      const reason = providerExclusionReason(surface, id);
      // Exactly one of "offered" / "withheld with a written reason" must hold.
      assert.equal(selectable, reason === undefined, `${surface}:${id}`);
      if (reason !== undefined) assert.ok(reason.length >= 20, `${surface}:${id}`);
    }
  }
});

test("the local endpoint is selectable for workflow agents but never for writing", () => {
  assert.ok(selectableProviderIds("workflowAgent").includes("local"));
  assert.ok(modelListingProviderIds().includes("local"));
  assert.equal(providerExclusionReason("workflowAgent", "local"), undefined);

  assert.equal(selectableProviderIds("workflowWriter").includes("local"), false);
  assert.equal(selectableProviderIds("roomResident").includes("local"), false);
  assert.equal(isWorkflowWriterProvider("local"), false);
  assert.equal(isRoomResidentProvider("local"), false);
  assert.match(String(providerExclusionReason("workflowWriter", "local")), /read-only|唯讀/u);
});

test("selection guards reject unknown, cased and non-string provider ids", () => {
  for (const surface of PROVIDER_SELECTION_SURFACES) {
    assert.equal(isSelectableProvider(surface, "Codex"), false);
    assert.equal(isSelectableProvider(surface, " codex"), false);
    assert.equal(isSelectableProvider(surface, "codex\n"), false);
    assert.equal(isSelectableProvider(surface, ""), false);
    assert.equal(isSelectableProvider(surface, undefined), false);
    assert.equal(isSelectableProvider(surface, 1), false);
    assert.equal(isSelectableProvider(surface, { toString: () => "codex" }), false);
    assert.equal(isSelectableProvider(surface, "__proto__"), false);
    assert.equal(isSelectableProvider(surface, "constructor"), false);
  }
  assert.equal(isRoomResidentProvider("fake"), false);
  assert.ok(isRoomResidentProvider("codex"));
  assert.ok(isWorkflowWriterProvider("fake"));
  assert.deepEqual([...roomResidentProviderIds()], ["codex", "claude", "grok"]);
});

test("room mention parsing only accepts providers offered on that surface", () => {
  assert.deepEqual(parseProviderMentionTarget("codex"), { provider: "codex" });
  assert.deepEqual(parseProviderMentionTarget("claude:claude-fable-5"), {
    provider: "claude",
    model: "claude-fable-5",
  });
  for (const value of [
    "local",
    "local:llama3",
    "Codex",
    "codex:",
    "codex:bad model",
    "codex:with space",
    "codex:nul\u0000byte",
    `codex:${"m".repeat(129)}`,
    "@codex",
    "",
    "codex codex",
    undefined,
    42,
  ]) {
    assert.equal(parseProviderMentionTarget(value), undefined, String(value));
  }
  assert.equal(mentionedProviderId("@codex please review"), "codex");
  assert.equal(mentionedProviderId("@local please review"), undefined);
  assert.equal(mentionedProviderId("@codex"), undefined);
  assert.equal(mentionedProviderId("hello @codex"), undefined);
  assert.equal(mentionedProviderId(undefined), undefined);
});

test("the room browser bundle stays in sync with the selection table", async () => {
  const source = await readFile(join(repositoryRoot, "public", "room.js"), "utf8");
  const literal = (name: string): string[] => {
    const match = source.match(
      new RegExp(`const ${name} = Object\\.freeze\\((\\[[^\\]]*\\])\\)`, "u"),
    );
    assert.ok(match?.[1], `${name} literal not found in public/room.js`);
    return JSON.parse(match[1].replaceAll("'", '"')) as string[];
  };
  assert.deepEqual(literal("ROOM_RESIDENT_PROVIDER_IDS"), [...selectableProviderIds("roomResident")]);
  assert.deepEqual(literal("ROOM_MENTION_PROVIDER_IDS"), [...selectableProviderIds("roomMention")]);
  // The browser cannot import the TypeScript table, so the office list must be
  // derived from the mirrored constant rather than written out a third time.
  assert.match(source, /BASE_OFFICE_AGENTS = Object\.freeze\(\["you", \.\.\.ROOM_RESIDENT_PROVIDER_IDS\]\)/u);
  assert.equal(source.includes('["codex", "claude", "grok"].includes('), false);
  assert.equal(source.includes("(codex|claude|grok"), false);
});

/**
 * Negative case for the structural claim itself: a table that forgets a provider
 * must fail to compile. This runs the repository's own TypeScript against the
 * real `ProviderId`, so it proves the guarantee for this code base rather than
 * for a hand-made copy of the pattern.
 */
test("an exhaustive provider table stops compiling when a provider is forgotten", async (t) => {
  t.diagnostic("spawns tsc twice on generated fixtures");
  const directory = await mkdtemp(join(tmpdir(), "orchestratory-selection-"));
  try {
    const typesModule = JSON.stringify(join(repositoryRoot, "src", "types.ts"));
    const fixture = (ids: readonly string[]): string =>
      `import type { ProviderId } from ${typesModule};\n` +
      "export const table = {\n" +
      ids.map((id) => `  ${id}: true,\n`).join("") +
      "} as const satisfies Record<ProviderId, boolean>;\n";
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          allowImportingTsExtensions: true,
          noEmit: true,
          types: [],
        },
        include: ["complete.ts", "incomplete.ts"],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "complete.ts"),
      fixture(["fake", "codex", "claude", "grok", "local"]),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "incomplete.ts"),
      // Exactly the mistake the audit found: every provider but the local one.
      fixture(["fake", "codex", "claude", "grok"]),
      { mode: 0o600 },
    );
    const compiler = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
    const run = async (files: readonly string[]): Promise<{ code: number; output: string }> => {
      await writeFile(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            allowImportingTsExtensions: true,
            noEmit: true,
            types: [],
          },
          include: files,
        }),
        { mode: 0o600 },
      );
      try {
        const done = await execFileAsync(
          process.execPath,
          [compiler, "--project", join(directory, "tsconfig.json")],
          { cwd: directory, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
        );
        return { code: 0, output: done.stdout };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
      }
    };

    const complete = await run(["complete.ts"]);
    assert.equal(complete.code, 0, complete.output);

    const incomplete = await run(["incomplete.ts"]);
    assert.notEqual(incomplete.code, 0);
    assert.match(incomplete.output, /local/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selection surfaces expose stable, immutable lists", () => {
  const first = selectableProviderIds("workflowAgent");
  const second = selectableProviderIds("workflowAgent");
  assert.deepEqual([...first], [...second]);
  assert.throws(() => {
    (first as ProviderId[]).push("fake");
  }, /object is not extensible|read only|Cannot add property/u);
});
