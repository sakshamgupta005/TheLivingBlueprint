/**
 * Types for Repository Knowledge Base and Retrieval Layer.
 */

export type FileCategory =
  | 'manifest'
  | 'readme'
  | 'config'
  | 'test'
  | 'source'
  | 'documentation';

export interface KnowledgeChunk {
  id: string;
  filePath: string;
  category: FileCategory;
  heading?: string;
  content: string;
  lineRange?: { startLine: number; endLine: number };
  keywords: string[];
}

export interface KnowledgeIndexStats {
  totalFilesDiscovered: number;
  filesIndexed: number;
  filesSkipped: number;
  filesFailed: number;
  status: 'indexing' | 'ready' | 'partial' | 'failed';
}

export interface RepositoryKnowledgeBase {
  repository: string;
  commitSha: string;
  stats: KnowledgeIndexStats;
  chunks: KnowledgeChunk[];
  readmeFiles: string[];
  docFiles: string[];
  manifestFiles: string[];
  sourceFiles: string[];
  technologies: string[];
  treeSummary: {
    directories: string[];
    topLevelFiles: string[];
    totalCount: number;
  };
}

export type QuestionCategory =
  | 'team_or_project'
  | 'documentation'
  | 'technology_stack'
  | 'architecture'
  | 'code_debugging'
  | 'general';

export interface QuestionIntent {
  category: QuestionCategory;
  rawQuery: string;
  keywords: string[];
  targetFileHints: string[];
}

export interface RetrievedChunk {
  chunk: KnowledgeChunk;
  score: number;
  matchReason: string;
}

export interface RetrievedContext {
  intent: QuestionIntent;
  chunks: KnowledgeChunk[];
  retrievedFilePaths: string[];
  uninspectedMentionedFiles: string[];
  formattedText: string;
  debugInfo: {
    query: string;
    category: QuestionCategory;
    strategy: string;
    matchedFiles: string[];
    chunkCount: number;
    scores: Record<string, number>;
  };
}
