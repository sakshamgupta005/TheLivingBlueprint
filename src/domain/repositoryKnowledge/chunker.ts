/**
 * Repository content chunker and secrets sanitizer.
 * Chunks markdown (preserving headings), manifests, configs, and source code.
 */

import type { FileCategory, KnowledgeChunk } from './types.ts';

const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|token|password|auth|bearer|credential)s?\s*[:=]\s*['"]?([A-Za-z0-9_\-.~+/]{16,})['"]?/gi,
  /\bAIza[0-9A-Za-z-_]{35}\b/g,
  /\bghp_[0-9A-Za-z]{36}\b/g,
  /\bgho_[0-9A-Za-z]{36}\b/g,
  /\bsk_[0-9A-Za-z]{24,}\b/g,
  /\bgsk_[0-9A-Za-z]{24,}\b/g,
];

/**
 * Redacts secrets from repository content before indexing or sending to AI models.
 */
export function sanitizeAndRedactSecrets(text: string): string {
  if (!text) return '';
  let sanitized = text;

  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, captured) => {
      if (captured) {
        return match.replace(captured, '<configured secret>');
      }
      return '<configured secret>';
    });
  }

  // Redact .env variable assignments with actual values
  sanitized = sanitized.replace(
    /^([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASS|AUTH|CREDENTIAL)[A-Z0-9_]*\s*=\s*)([^\s#\r\n]+)/gim,
    '$1<configured secret>'
  );

  return sanitized;
}

/**
 * Extracts normalized searchable keywords from text and headings.
 */
export function extractKeywords(text: string): string[] {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\.\/]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return Array.from(new Set(words)).slice(0, 30);
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'were',
  'which', 'been', 'there', 'what', 'when', 'where', 'will', 'your',
  'about', 'into', 'some', 'could', 'them', 'than', 'then', 'also',
]);

/**
 * Chunks markdown files (README, documentation) by headings, preserving context.
 */
export function chunkMarkdown(
  filePath: string,
  rawContent: string,
  category: FileCategory = 'readme'
): KnowledgeChunk[] {
  const sanitized = sanitizeAndRedactSecrets(rawContent);
  const lines = sanitized.split(/\r?\n/);
  const chunks: KnowledgeChunk[] = [];

  let currentHeading = 'Overview';
  let currentLines: string[] = [];
  let chunkStartLine = 1;

  function flushChunk(endLine: number) {
    const text = currentLines.join('\n').trim();
    if (text.length > 0) {
      // If chunk is excessively large, split by paragraphs while preserving heading
      if (text.length > 1800) {
        const paragraphs = text.split(/\n\s*\n/);
        let subText = '';
        let subIndex = 1;
        for (const p of paragraphs) {
          if ((subText + '\n\n' + p).length > 1500 && subText.trim().length > 0) {
            chunks.push({
              id: `${filePath}#${currentHeading.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${subIndex++}`,
              filePath,
              category,
              heading: currentHeading,
              content: subText.trim(),
              keywords: extractKeywords(`${currentHeading} ${subText}`),
            });
            subText = p;
          } else {
            subText = subText ? `${subText}\n\n${p}` : p;
          }
        }
        if (subText.trim().length > 0) {
          chunks.push({
            id: `${filePath}#${currentHeading.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${subIndex}`,
            filePath,
            category,
            heading: currentHeading,
            content: subText.trim(),
            keywords: extractKeywords(`${currentHeading} ${subText}`),
          });
        }
      } else {
        chunks.push({
          id: `${filePath}#${currentHeading.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
          filePath,
          category,
          heading: currentHeading,
          content: text,
          lineRange: { startLine: chunkStartLine, endLine },
          keywords: extractKeywords(`${currentHeading} ${text}`),
        });
      }
    }
    currentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);

    if (headingMatch) {
      flushChunk(i);
      currentHeading = headingMatch[2].trim();
      chunkStartLine = i + 1;
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }

  flushChunk(lines.length);

  // If no chunks were created (e.g. plain text or single short note), create a single chunk
  if (chunks.length === 0 && sanitized.trim().length > 0) {
    chunks.push({
      id: `${filePath}#full`,
      filePath,
      category,
      heading: 'Document Content',
      content: sanitized.trim(),
      keywords: extractKeywords(sanitized),
    });
  }

  return chunks;
}

/**
 * Chunks package manifests (e.g. package.json, requirements.txt) into readable structural chunks.
 */
export function chunkManifest(filePath: string, rawContent: string): KnowledgeChunk[] {
  const sanitized = sanitizeAndRedactSecrets(rawContent);
  const chunks: KnowledgeChunk[] = [];
  const lower = filePath.toLowerCase();

  if (lower.endsWith('package.json')) {
    try {
      const pkg = JSON.parse(sanitized);
      const metaLines: string[] = [];
      if (pkg.name) metaLines.push(`Project Name: ${pkg.name}`);
      if (pkg.version) metaLines.push(`Version: ${pkg.version}`);
      if (pkg.description) metaLines.push(`Description: ${pkg.description}`);
      if (pkg.author) metaLines.push(`Author: ${typeof pkg.author === 'object' ? JSON.stringify(pkg.author) : pkg.author}`);
      if (pkg.license) metaLines.push(`License: ${pkg.license}`);

      if (metaLines.length > 0) {
        chunks.push({
          id: `${filePath}#project-metadata`,
          filePath,
          category: 'manifest',
          heading: 'Project Metadata',
          content: metaLines.join('\n'),
          keywords: extractKeywords(metaLines.join(' ')),
        });
      }

      if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
        const deps = Object.entries(pkg.dependencies)
          .map(([k, v]) => `  - ${k}: ${v}`)
          .join('\n');
        chunks.push({
          id: `${filePath}#dependencies`,
          filePath,
          category: 'manifest',
          heading: 'Dependencies',
          content: `Production Dependencies:\n${deps}`,
          keywords: ['dependencies', 'packages', 'libraries', ...Object.keys(pkg.dependencies)],
        });
      }

      if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
        const devDeps = Object.entries(pkg.devDependencies)
          .map(([k, v]) => `  - ${k}: ${v}`)
          .join('\n');
        chunks.push({
          id: `${filePath}#dev-dependencies`,
          filePath,
          category: 'manifest',
          heading: 'Dev Dependencies',
          content: `Development Dependencies & Tools:\n${devDeps}`,
          keywords: ['devdependencies', 'tools', 'testing', ...Object.keys(pkg.devDependencies)],
        });
      }

      if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
        const scripts = Object.entries(pkg.scripts)
          .map(([k, v]) => `  - npm run ${k}: ${v}`)
          .join('\n');
        chunks.push({
          id: `${filePath}#scripts`,
          filePath,
          category: 'manifest',
          heading: 'NPM Scripts & Commands',
          content: `Available Scripts:\n${scripts}`,
          keywords: ['scripts', 'commands', 'build', 'test', 'dev', ...Object.keys(pkg.scripts)],
        });
      }
    } catch {
      // Fallback if malformed
      chunks.push({
        id: `${filePath}#raw`,
        filePath,
        category: 'manifest',
        heading: 'Manifest File',
        content: sanitized.slice(0, 1500),
        keywords: extractKeywords(sanitized),
      });
    }
  } else {
    // Other manifest types (requirements.txt, Cargo.toml, etc.)
    chunks.push({
      id: `${filePath}#manifest`,
      filePath,
      category: 'manifest',
      heading: 'Manifest & Dependencies',
      content: sanitized.slice(0, 2000),
      keywords: extractKeywords(`${filePath} ${sanitized}`),
    });
  }

  return chunks;
}

/**
 * Chunks source code, tests, and configuration files into logical blocks.
 */
export function chunkCodeFile(
  filePath: string,
  rawContent: string,
  category: FileCategory = 'source'
): KnowledgeChunk[] {
  const sanitized = sanitizeAndRedactSecrets(rawContent);
  const lines = sanitized.split(/\r?\n/);
  const chunks: KnowledgeChunk[] = [];

  // Group into blocks of 30-50 lines
  const blockSize = 40;
  for (let i = 0; i < lines.length; i += blockSize) {
    const blockLines = lines.slice(i, i + blockSize);
    const content = blockLines.join('\n').trim();
    if (!content) continue;

    // Detect first function, class, route, or export declaration in this block
    let heading = `Lines ${i + 1}-${Math.min(i + blockSize, lines.length)}`;
    for (const line of blockLines) {
      const match = line.match(/(?:export\s+)?(?:function|class|const|let|var|type|interface|describe|it|test)\s+([A-Za-z0-9_]+)/);
      if (match) {
        heading = `${match[1]} (${heading})`;
        break;
      }
    }

    chunks.push({
      id: `${filePath}#L${i + 1}`,
      filePath,
      category,
      heading,
      content,
      lineRange: { startLine: i + 1, endLine: Math.min(i + blockSize, lines.length) },
      keywords: extractKeywords(`${filePath} ${heading} ${content}`),
    });
  }

  return chunks;
}

/**
 * General file chunker routing based on category.
 */
export function chunkFile(filePath: string, content: string, category: string): KnowledgeChunk[] {
  const cat = category as FileCategory;
  if (cat === 'readme' || cat === 'documentation') {
    return chunkMarkdown(filePath, content, cat);
  }
  if (cat === 'manifest') {
    return chunkManifest(filePath, content);
  }
  return chunkCodeFile(filePath, content, cat);
}
