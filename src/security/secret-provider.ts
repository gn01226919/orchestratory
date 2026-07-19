import { minimalSubscriptionEnvironment, resolveExecutable, runProcess } from "../core/process-runner.ts";

const KEYCHAIN_SERVICES: Readonly<Record<string, string>> = Object.freeze({
  OPENAI_API_KEY: "orchestratory.openai-api-key",
  ANTHROPIC_API_KEY: "orchestratory.anthropic-api-key",
  XAI_API_KEY: "orchestratory.xai-api-key",
});

export async function loadApiSecret(environmentKey: string): Promise<string> {
  if (!(environmentKey in KEYCHAIN_SERVICES)) throw new Error("UNKNOWN_API_SECRET_ID");
  const fromEnvironment = process.env[environmentKey];
  if (typeof fromEnvironment === "string" && fromEnvironment.length >= 8) return fromEnvironment;
  if (process.platform !== "darwin") throw new Error("API_CREDENTIAL_NOT_CONFIGURED");

  try {
    const result = await runProcess({
      executable: await resolveExecutable("security"),
      args: [
        "find-generic-password",
        "-w",
        "-s",
        KEYCHAIN_SERVICES[environmentKey] ?? "",
        "-a",
        "orchestratory",
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      outputLimitBytes: 16_384,
      env: minimalSubscriptionEnvironment(),
    });
    const secret = result.stdout.trim();
    if (result.exitCode !== 0 || result.terminationReason || secret.length < 8) {
      throw new Error("API_CREDENTIAL_NOT_CONFIGURED");
    }
    return secret;
  } catch {
    throw new Error("API_CREDENTIAL_NOT_CONFIGURED");
  }
}

export function apiKeychainService(environmentKey: string): string {
  const service = KEYCHAIN_SERVICES[environmentKey];
  if (!service) throw new Error("UNKNOWN_API_SECRET_ID");
  return service;
}
