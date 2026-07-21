import { stderr } from "node:process";
import { safeSummary } from "./security/redact.ts";

export async function runCli(
  operation: () => Promise<void>,
  writeError: (value: string) => void = (value) => stderr.write(value),
): Promise<number> {
  try {
    await operation();
    return 0;
  } catch (error) {
    writeError(`Error: ${safeSummary(error instanceof Error ? error.message : "UNKNOWN_ERROR", 500)}\n`);
    return 1;
  }
}
