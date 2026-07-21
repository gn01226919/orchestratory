import { resolveExecutable } from "./core/process-runner.ts";
import { ProviderRegistry } from "./providers/registry.ts";

export interface DoctorItem {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [
    {
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 22,
      detail: process.versions.node,
    },
  ];
  try {
    items.push({ name: "git", ok: true, detail: await resolveExecutable("git") });
  } catch (error) {
    items.push({ name: "git", ok: false, detail: error instanceof Error ? error.message : "missing" });
  }

  const registry = new ProviderRegistry();
  for (const provider of registry.capabilities()) {
    if (provider.id === "fake") continue;
    const result = await registry.get(provider.id).doctor();
    items.push({
      name: provider.id,
      ok: result.ok,
      detail: result.version ?? result.reason ?? "unknown",
    });
  }
  items.push({
    name: "authentication",
    ok: true,
    detail: "Not probed: live auth checks could consume quota; verified only when a user starts a run.",
  });
  return items;
}
