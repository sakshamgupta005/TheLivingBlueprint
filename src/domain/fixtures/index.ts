export * from './types.ts';
export * from './mockFetch.ts';
export { jsApiFixture } from './jsApiFixture.ts';
export { tsFrontendFixture } from './tsFrontendFixture.ts';
export { pyBackendFixture } from './pyBackendFixture.ts';
export { monorepoFixture } from './monorepoFixture.ts';
export { docHeavyFixture } from './docHeavyFixture.ts';
export { unsupportedFixture } from './unsupportedFixture.ts';
export { velocityFixture } from './velocityFixture.ts';

import { jsApiFixture } from './jsApiFixture.ts';
import { tsFrontendFixture } from './tsFrontendFixture.ts';
import { pyBackendFixture } from './pyBackendFixture.ts';
import { monorepoFixture } from './monorepoFixture.ts';
import { docHeavyFixture } from './docHeavyFixture.ts';
import { unsupportedFixture } from './unsupportedFixture.ts';
import { velocityFixture } from './velocityFixture.ts';
import type { BenchmarkFixture } from './types.ts';

export const allBenchmarkFixtures: BenchmarkFixture[] = [
  jsApiFixture,
  tsFrontendFixture,
  pyBackendFixture,
  monorepoFixture,
  docHeavyFixture,
  unsupportedFixture,
  velocityFixture,
];

export function findBenchmarkFixture(owner: string, repo: string): BenchmarkFixture | undefined {
  const normOwner = owner.toLowerCase().trim();
  const normRepo = repo.toLowerCase().trim();

  return allBenchmarkFixtures.find(
    (f) => f.owner.toLowerCase() === normOwner && f.repo.toLowerCase() === normRepo
  );
}
