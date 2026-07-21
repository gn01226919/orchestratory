import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HARD_LIMITS,
  validateApiModelPolicies,
  validateHardLimits,
  validateRetentionPolicy,
  validateTesterProfiles,
  validateWorkspaceRootPolicies,
} from "../src/config.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { safeSummary, sanitizeTerminal } from "../src/security/redact.ts";
import { parseWorkflowRequest } from "../src/ui/request.ts";

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

test("deterministic fuzz smoke keeps parsers bounded and fail-closed", () => {
  const next = generator(0x5ec0_2026);
  const providers = new ProviderRegistry();
  const validators = [
    validateHardLimits,
    validateApiModelPolicies,
    validateTesterProfiles,
    validateWorkspaceRootPolicies,
    validateRetentionPolicy,
  ];
  const alphabet = "abcXYZ09_-/:. \n\r\t\0[]{}'\"$;`\\";
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const length = next() % 4_097;
    let value = "";
    for (let index = 0; index < length; index += 1) {
      value += alphabet[next() % alphabet.length];
    }
    assert.ok(Buffer.byteLength(safeSummary(value, 500), "utf8") <= 2_000);
    assert.doesNotMatch(sanitizeTerminal(value), /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u);
    const malformed: unknown = iteration % 4 === 0
      ? value
      : iteration % 4 === 1
        ? { [value.slice(0, 32)]: value }
        : iteration % 4 === 2
          ? [value]
          : next();
    for (const validate of validators) {
      try {
        validate(malformed as never);
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.length <= 200);
      }
    }
    try {
      parseWorkflowRequest(malformed, providers);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.length <= 200);
    }
  }
  assert.deepEqual(validateHardLimits({ ...DEFAULT_HARD_LIMITS }), DEFAULT_HARD_LIMITS);
});
