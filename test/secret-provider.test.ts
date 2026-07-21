import test from "node:test";
import assert from "node:assert/strict";
import { apiKeychainService, loadApiSecret } from "../src/security/secret-provider.ts";

test("API secret provider accepts only fixed secret identities", async (t) => {
  const original = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });
  process.env.OPENAI_API_KEY = "synthetic-not-real-secret";
  assert.equal(await loadApiSecret("OPENAI_API_KEY"), "synthetic-not-real-secret");
  await assert.rejects(loadApiSecret("ATTACKER_KEY"), /UNKNOWN_API_SECRET_ID/u);
  assert.equal(apiKeychainService("OPENAI_API_KEY"), "orchestratory.openai-api-key");
  assert.throws(() => apiKeychainService("ATTACKER_KEY"), /UNKNOWN_API_SECRET_ID/u);
});
