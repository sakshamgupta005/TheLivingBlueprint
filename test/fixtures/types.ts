import type { GitHubCheckRun } from '../../src/domain/lifecycle/types.ts';
import type { GitTreeEntry } from '../../src/domain/github/types.ts';

export interface FixtureImportFact {
  from: string;
  to: string;
}

export interface FixtureRelationshipFact {
  source: string;
  target: string;
  type: string;
}

export interface FixtureKnownFacts {
  name: string;
  description: string;
  entryPoints: string[];
  routes: string[];
  imports: FixtureImportFact[];
  tests: string[];
  workflows: string[];
  expectedRelationships: FixtureRelationshipFact[];
  expectedRooms: string[];
  unsupportedOrUncertainFacts: string[];
}

export interface BenchmarkFixture {
  id: string;
  name: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  files: Record<string, string>;
  treeEntries?: GitTreeEntry[];
  treeTruncated?: boolean;
  commitSha?: string;
  checkRuns?: GitHubCheckRun[];
  knownFacts: FixtureKnownFacts;
}
