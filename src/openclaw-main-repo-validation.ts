import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

type CompatibilityReport = {
  repoPath: string;
  repoDetected: boolean;
  nativeContextEngineSlot: boolean;
  standardPluginHooks: boolean;
  pluginKindSupport: string[];
  packageDeclaresExtensionEntry: boolean;
  packagePeerDependency: string | null;
  manifestDeclaresConfigSchema: boolean;
  manifestUsesUnsupportedKind: boolean;
  recommendedMode: 'native-context-engine' | 'hook-bridge' | 'unsupported';
  notes: string[];
};

function main(): void {
  const repoPath = resolveOpenClawRepoPath(process.argv[2], process.env.OPENCLAW_MAIN_REPO);
  const report = validateOpenClawMainRepo(repoPath);
  console.log(JSON.stringify(report, null, 2));
}

export function validateOpenClawMainRepo(repoPath: string): CompatibilityReport {
  const normalizedRepoPath = resolve(repoPath);
  const pluginRoot = resolve(process.cwd());
  const typesPath = join(normalizedRepoPath, 'src', 'plugins', 'types.ts');
  const slotsPath = join(normalizedRepoPath, 'src', 'plugins', 'slots.ts');
  const registryPath = join(normalizedRepoPath, 'src', 'plugins', 'registry.ts');
  const packageJsonPath = join(pluginRoot, 'package.json');
  const manifestPath = join(pluginRoot, 'openclaw.plugin.json');
  const packageJson = existsSync(packageJsonPath)
    ? JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        openclaw?: { extensions?: string[] };
        peerDependencies?: Record<string, string>;
      }
    : undefined;
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        configSchema?: Record<string, unknown>;
        kind?: string;
      }
    : undefined;
  const packageDeclaresExtensionEntry = Array.isArray(packageJson?.openclaw?.extensions)
    && packageJson!.openclaw!.extensions.includes('./index.ts');
  const packagePeerDependency = packageJson?.peerDependencies?.openclaw ?? null;
  const manifestDeclaresConfigSchema = Boolean(manifest?.configSchema);
  const manifestUsesUnsupportedKind = typeof manifest?.kind === 'string' && manifest.kind !== 'memory';

  if (!existsSync(typesPath) || !existsSync(slotsPath) || !existsSync(registryPath)) {
    return {
      repoPath: normalizedRepoPath,
      repoDetected: false,
      nativeContextEngineSlot: false,
      standardPluginHooks: false,
      pluginKindSupport: [],
      packageDeclaresExtensionEntry,
      packagePeerDependency,
      manifestDeclaresConfigSchema,
      manifestUsesUnsupportedKind,
      recommendedMode: 'unsupported',
      notes: ['OpenClaw main repo not detected at expected src/plugins paths.'],
    };
  }

  const typesSource = readFileSync(typesPath, 'utf8');
  const slotsSource = readFileSync(slotsPath, 'utf8');
  const registrySource = readFileSync(registryPath, 'utf8');

  const pluginKindSupport = parsePluginKinds(typesSource);
  const nativeContextEngineSlot =
    /PluginKind\s*=\s*[^;]*context-engine/i.test(typesSource)
    || /contextEngine/i.test(slotsSource)
    || /registerContextEngine/i.test(registrySource);
  const standardPluginHooks = /type PluginHookName/.test(typesSource) && /\bon:\s*</.test(typesSource);

  const notes: string[] = [];
  if (!nativeContextEngineSlot) {
    notes.push('No native context-engine plugin slot detected in src/plugins. Use hook bridge mode.');
  }
  if (standardPluginHooks) {
    notes.push('Standard plugin hooks are available; before_agent_start/agent_end/before_compaction bridge can run.');
  } else {
    notes.push('Standard typed plugin hooks were not detected; hook bridge mode may be unavailable.');
  }
  if (!packageDeclaresExtensionEntry) {
    notes.push('package.json does not declare openclaw.extensions with ./index.ts; discovery may rely on directory index fallback only.');
  }
  if (!packagePeerDependency) {
    notes.push('package.json does not declare an openclaw peer dependency.');
  }
  if (!manifestDeclaresConfigSchema) {
    notes.push('openclaw.plugin.json is missing configSchema and will fail manifest validation.');
  }
  if (manifestUsesUnsupportedKind) {
    notes.push('openclaw.plugin.json declares a kind not supported by this OpenClaw main repo.');
  }

  return {
    repoPath: normalizedRepoPath,
    repoDetected: true,
    nativeContextEngineSlot,
    standardPluginHooks,
    pluginKindSupport,
    packageDeclaresExtensionEntry,
    packagePeerDependency,
    manifestDeclaresConfigSchema,
    manifestUsesUnsupportedKind,
    recommendedMode: nativeContextEngineSlot
      ? 'native-context-engine'
      : standardPluginHooks
        ? 'hook-bridge'
        : 'unsupported',
    notes,
  };
}

function parsePluginKinds(source: string): string[] {
  const unionMatch = source.match(/export type PluginKind\s*=\s*([^;]+);/);
  if (!unionMatch) {
    return [];
  }

  return unionMatch[1]
    .split('|')
    .map((entry) => entry.replace(/['"\s]/g, '').trim())
    .filter(Boolean);
}

function resolveOpenClawRepoPath(explicitPath?: string, envPath?: string): string {
  const candidates = [
    explicitPath,
    envPath,
    join(process.cwd(), '..', 'openclaw'),
    join(process.cwd(), '..', '..', 'openclaw'),
    join(homedir(), 'openclaw'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolvedCandidate = resolve(candidate);
    if (existsSync(join(resolvedCandidate, 'src', 'plugins'))) {
      return resolvedCandidate;
    }
  }

  return resolve(candidates[0] ?? join(homedir(), 'openclaw'));
}

main();
