import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allBenchmarkFixtures } from './index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseTreesDir = path.join(__dirname, 'trees');

for (const fixture of allBenchmarkFixtures) {
  const fixtureDir = path.join(baseTreesDir, fixture.id.replace('fixture-', ''));
  fs.mkdirSync(fixtureDir, { recursive: true });

  for (const [relPath, content] of Object.entries(fixture.files)) {
    const fullPath = path.join(fixtureDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  // Write known facts file in each fixture directory
  fs.writeFileSync(
    path.join(fixtureDir, 'KNOWN_FACTS.json'),
    JSON.stringify(fixture.knownFacts, null, 2),
    'utf8'
  );
}

console.log(`Materialized ${allBenchmarkFixtures.length} fixture trees in ${baseTreesDir}`);
