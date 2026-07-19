import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object" || lock.packages === null) {
  throw new Error("UNSUPPORTED_PACKAGE_LOCK");
}

function packageName(path, value) {
  if (typeof value.name === "string") return value.name;
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) throw new Error("LOCK_PACKAGE_NAME_MISSING");
  return path.slice(index + marker.length);
}

function purl(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function integrityHash(value) {
  if (typeof value !== "string" || !value.startsWith("sha512-")) {
    throw new Error("DEPENDENCY_INTEGRITY_NOT_SHA512");
  }
  return Buffer.from(value.slice(7), "base64").toString("hex").toUpperCase();
}

const entries = Object.entries(lock.packages).filter(([path]) => path !== "");
if (entries.length > 200) throw new Error("DEPENDENCY_COUNT_POLICY_EXCEEDED");
const components = entries.map(([path, value]) => {
  const name = packageName(path, value);
  const version = value.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
    throw new Error("DEPENDENCY_VERSION_NOT_EXACT");
  }
  if (
    typeof value.resolved !== "string" ||
    !value.resolved.startsWith("https://registry.npmjs.org/")
  ) {
    throw new Error("DEPENDENCY_REGISTRY_NOT_ALLOWED");
  }
  if (value.license !== "MIT" && value.license !== "Apache-2.0") {
    throw new Error("DEPENDENCY_LICENSE_NOT_ALLOWED");
  }
  const ref = purl(name, version);
  return {
    type: "library",
    "bom-ref": ref,
    name,
    version,
    scope: value.dev ? "excluded" : "required",
    hashes: [{ alg: "SHA-512", content: integrityHash(value.integrity) }],
    licenses: [{ license: { id: value.license } }],
    purl: ref,
    properties: [{ name: "orchestratory:npm:development", value: String(Boolean(value.dev)) }],
  };
}).sort((left, right) => left.purl.localeCompare(right.purl));

const rootRef = purl(packageJson.name, packageJson.version);
const dependencies = [{
  ref: rootRef,
  dependsOn: Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
    .map((name) => {
      const match = components.find((component) => component.name === name);
      if (!match) throw new Error("DIRECT_DEPENDENCY_MISSING_FROM_LOCK");
      return match.purl;
    })
    .sort(),
}];
for (const [path, value] of entries) {
  const name = packageName(path, value);
  const component = components.find((candidate) => candidate.name === name && candidate.version === value.version);
  if (!component) throw new Error("SBOM_COMPONENT_MISSING");
  dependencies.push({
    ref: component.purl,
    dependsOn: Object.entries(value.dependencies ?? {}).map(([dependencyName]) => {
      const dependency = components.find((candidate) => candidate.name === dependencyName);
      if (!dependency) throw new Error("TRANSITIVE_DEPENDENCY_MISSING_FROM_LOCK");
      return dependency.purl;
    }).sort(),
  });
}

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: {
      type: "application",
      "bom-ref": rootRef,
      name: packageJson.name,
      version: packageJson.version,
      purl: rootRef,
    },
  },
  components,
  dependencies: dependencies.sort((left, right) => left.ref.localeCompare(right.ref)),
};
const serialized = `${JSON.stringify(bom, null, 2)}\n`;
const output = resolve(root, "sbom.cdx.json");
if (process.argv.includes("--write")) {
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
} else if (process.argv.includes("--check")) {
  const existing = await readFile(output, "utf8");
  if (existing !== serialized) throw new Error("SBOM_OUT_OF_DATE");
}
const digest = createHash("sha256").update(serialized).digest("hex");
process.stdout.write(`CycloneDX SBOM ${process.argv.includes("--write") ? "written" : "verified"}: ${components.length} components, sha256 ${digest}\n`);
