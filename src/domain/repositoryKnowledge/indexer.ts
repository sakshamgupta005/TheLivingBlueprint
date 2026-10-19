/**
 * Repository Knowledge Base Builder and Indexer.
 */

import { chunkFile } from './chunker.ts';
import type {
  KnowledgeChunk,
  KnowledgeIndexStats,
  RepositoryKnowledgeBase,
} from './types.ts';

export interface BuildKnowledgeBaseOptions {
  repository?: string;
  commitSha?: string;
  inspectedFiles: Array<{
    path: string;
    category: string;
    contentExcerpt?: string;
    sizeBytes?: number;
  }>;
  discoveredFilePaths?: string[];
  skippedFilesCount?: number;
  detectedTechnologies?: string[];
  metadata?: {
    description?: string | null;
    stargazersCount?: number;
    openIssuesCount?: number;
  };
}

export function buildRepositoryKnowledgeBase(
  options: BuildKnowledgeBaseOptions
): RepositoryKnowledgeBase {
  const repository = options.repository || 'unknown/repository';
  const commitSha = options.commitSha || 'unknown';
  const inspectedFiles = options.inspectedFiles || [];
  const discoveredFilePaths = options.discoveredFilePaths || inspectedFiles.map((f) => f.path);
  const detectedTechnologies = options.detectedTechnologies || [];

  const allChunks: KnowledgeChunk[] = [];
  const readmeFiles: string[] = [];
  const docFiles: string[] = [];
  const manifestFiles: string[] = [];
  const sourceFiles: string[] = [];

  let filesIndexed = 0;
  let filesFailed = 0;

  for (const file of inspectedFiles) {
    if (!file || !file.path) continue;
    const content = file.contentExcerpt || '';
    if (!content.trim()) continue;

    try {
      const chunks = chunkFile(file.path, content, file.category);
      if (chunks.length > 0) {
        allChunks.push(...chunks);
        filesIndexed++;

        const cat = file.category.toLowerCase();
        if (cat === 'readme') readmeFiles.push(file.path);
        else if (cat === 'documentation') docFiles.push(file.path);
        else if (cat === 'manifest') manifestFiles.push(file.path);
        else sourceFiles.push(file.path);
      }
    } catch {
      filesFailed++;
    }
  }

  // Build directory and structure summary from discoveredFilePaths
  const dirSet = new Set<string>();
  const topLevelFiles: string[] = [];

  for (const p of discoveredFilePaths) {
    if (typeof p !== 'string') continue;
    const parts = p.split('/');
    if (parts.length > 1) {
      dirSet.add(parts[0] + '/');
      if (parts.length > 2) {
        dirSet.add(parts.slice(0, 2).join('/') + '/');
      }
    } else {
      topLevelFiles.push(p);
    }
  }

  const directories = Array.from(dirSet).sort();
  const totalFilesDiscovered = Math.max(discoveredFilePaths.length, inspectedFiles.length);
  const filesSkipped = options.skippedFilesCount ?? Math.max(0, totalFilesDiscovered - filesIndexed);

  let status: KnowledgeIndexStats['status'] = 'ready';
  if (filesFailed > 0 && filesIndexed === 0) {
    status = 'failed';
  } else if (filesSkipped > 0 || filesFailed > 0) {
    status = 'partial';
  }

  const stats: KnowledgeIndexStats = {
    totalFilesDiscovered,
    filesIndexed,
    filesSkipped,
    filesFailed,
    status,
  };

  // Add structural summary chunk for architecture questions
  const structureContent = `Repository Directory Structure & Key Folders:
Discovered Root Folders: ${directories.slice(0, 15).join(', ') || 'Root only'}
Top-level Files: ${topLevelFiles.slice(0, 15).join(', ') || 'None'}
Total Discovered Files: ${totalFilesDiscovered}
Inspected Core Files: ${inspectedFiles.map((f) => f.path).slice(0, 20).join(', ')}`;

  allChunks.push({
    id: '__structural_directory_summary__',
    filePath: 'DIRECTORY_STRUCTURE',
    category: 'config',
    heading: 'Repository Directory Structure',
    content: structureContent,
    keywords: ['directory', 'structure', 'folders', 'architecture', 'layout', 'tree', ...directories.map((d) => d.replace('/', ''))],
  });

  return {
    repository,
    commitSha,
    stats,
    chunks: allChunks,
    readmeFiles,
    docFiles,
    manifestFiles,
    sourceFiles,
    technologies: detectedTechnologies,
    treeSummary: {
      directories,
      topLevelFiles,
      totalCount: totalFilesDiscovered,
    },
  };
}
