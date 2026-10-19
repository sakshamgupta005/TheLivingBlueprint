import type { CodeIndex } from '../codeIndex/types.ts';
import type {
  ArchitectureLensResult,
  ModuleCluster,
  ModuleHierarchyItem,
  ModuleHierarchyModel,
} from './types.ts';

export interface ModuleHierarchyInput {
  codeIndex: CodeIndex;
}

/**
 * Groups modules by directory and actual import relationships, with collapsible clusters
 * and circular-dependency highlighting.
 */
export function analyzeModuleHierarchy(
  input: ModuleHierarchyInput
): ArchitectureLensResult<ModuleHierarchyModel> {
  const { codeIndex } = input;
  const fileSummaries = Object.values(codeIndex.files || {});

  if (fileSummaries.length < 2) {
    return {
      viewMode: 'module_hierarchy',
      title: 'Module Hierarchy View',
      hasSufficientEvidence: false,
      reasonIfUnsupported: 'Insufficient modules: repository requires at least 2 indexed modules to construct a directory cluster hierarchy.',
      model: null,
      stats: {
        totalModules: fileSummaries.length,
        totalClusters: 0,
        circularModulesCount: 0,
      },
    };
  }

  // 1. Group modules into directory clusters
  const clusterMap = new Map<string, ModuleCluster>();

  function getClusterPath(filePath: string): { clusterId: string; clusterName: string; dirPath: string } {
    const parts = filePath.replace(/\\/g, '/').split('/');
    if (parts.length <= 1) {
      return { clusterId: 'root', clusterName: 'Root Directory', dirPath: '.' };
    }
    const dirParts = parts.slice(0, -1);
    const dirPath = dirParts.join('/');
    const clusterName = dirParts[dirParts.length - 1] || 'root';
    return { clusterId: `cluster-${dirPath.replace(/[^a-zA-Z0-9_-]/g, '_')}`, clusterName, dirPath };
  }

  for (const file of fileSummaries) {
    const { clusterId, clusterName, dirPath } = getClusterPath(file.path);
    if (!clusterMap.has(clusterId)) {
      clusterMap.set(clusterId, {
        id: clusterId,
        name: clusterName,
        directoryPath: dirPath,
        modulePaths: [],
      });
    }
    clusterMap.get(clusterId)!.modulePaths.push(file.path);
  }

  // 2. Identify circular dependencies
  const cycles = codeIndex.circularDependencies || [];
  const circularModuleSet = new Set<string>();
  for (const cycle of cycles) {
    for (const m of cycle) {
      circularModuleSet.add(m);
    }
  }

  // 3. Map imports and importedBy per module
  const importsMap = new Map<string, Set<string>>();
  const importedByMap = new Map<string, Set<string>>();

  for (const file of fileSummaries) {
    importsMap.set(file.path, new Set());
    importedByMap.set(file.path, new Set());
  }

  for (const rel of codeIndex.relationships || []) {
    if (rel.type === 'imports' && rel.confidence === 'confirmed') {
      const src = rel.source.path;
      const tgt = rel.target.path;
      if (importsMap.has(src)) importsMap.get(src)!.add(tgt);
      if (importedByMap.has(tgt)) importedByMap.get(tgt)!.add(src);
    }
  }

  // 4. Build hierarchy items
  const modules: ModuleHierarchyItem[] = fileSummaries.map((f) => {
    const { clusterId } = getClusterPath(f.path);
    const isPartOfCycle = circularModuleSet.has(f.path);
    const cycleParticipants = isPartOfCycle
      ? cycles.find((c) => c.includes(f.path))
      : undefined;

    return {
      id: `mod-${f.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      path: f.path,
      name: f.path.split('/').pop() || f.path,
      clusterId,
      imports: Array.from(importsMap.get(f.path) || []),
      importedBy: Array.from(importedByMap.get(f.path) || []),
      isPartOfCycle,
      cycleParticipants,
    };
  });

  const clusters = Array.from(clusterMap.values()).sort((a, b) => a.directoryPath.localeCompare(b.directoryPath));

  return {
    viewMode: 'module_hierarchy',
    title: 'Module Hierarchy & Import Clusters View',
    hasSufficientEvidence: true,
    model: {
      clusters,
      modules,
      circularDependencies: cycles,
      totalModules: modules.length,
      totalClusters: clusters.length,
      circularModulesCount: circularModuleSet.size,
    },
    stats: {
      totalModules: modules.length,
      totalClusters: clusters.length,
      circularModulesCount: circularModuleSet.size,
      circularChainsCount: cycles.length,
    },
  };
}
