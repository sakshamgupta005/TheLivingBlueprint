import type {
  ArchitectureLensResult,
  ConfigConsumer,
  ConfigWiringModel,
  DetectedConfigKey,
} from './types.ts';

export interface ConfigAnalyzerInput {
  files: Record<string, string>; // path -> content
}

const SECRET_KEY_REGEX = /(?:API_KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE_KEY|AUTH|CERT|SIGNING)/i;

/**
 * Connects observed environment-variable reads and configuration sources to the modules that consume them.
 * NEVER exposes secret values.
 */
export function analyzeConfigWiring(
  input: ConfigAnalyzerInput
): ArchitectureLensResult<ConfigWiringModel> {
  const configMap = new Map<string, DetectedConfigKey>();

  // 1. Scan for configuration definitions in .env, .env.example, etc.
  for (const [filePath, content] of Object.entries(input.files)) {
    if (/(?:\.env|\.env\.example|\.env\.sample|\.env\.test)$/i.test(filePath)) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          const rawKey = line.slice(0, eqIdx).trim();
          const rawVal = line.slice(eqIdx + 1).trim();
          const isSecret = SECRET_KEY_REGEX.test(rawKey);

          // REDACT sensitive value immediately
          const safeDefault = isSecret
            ? undefined
            : rawVal ? rawVal.replace(/['"]/g, '') : undefined;

          if (!configMap.has(rawKey)) {
            configMap.set(rawKey, {
              key: rawKey,
              isSecret,
              defaultValue: safeDefault,
              sources: [`${filePath}:${i + 1}`],
              consumers: [],
            });
          } else {
            const entry = configMap.get(rawKey)!;
            entry.sources.push(`${filePath}:${i + 1}`);
            if (!entry.defaultValue && safeDefault) {
              entry.defaultValue = safeDefault;
            }
          }
        }
      }
    }
  }

  // 2. Scan code files for environment-variable reads:
  // process.env.KEY, process.env['KEY'], import.meta.env.KEY, os.environ.get('KEY')
  const nodeEnvDot = /process\.env\.([A-Za-z0-9_]+)(?:\s*\|\|\s*['"]?([A-Za-z0-9_./:-]+)['"]?)?/g;
  const nodeEnvBracket = /process\.env\[['"]([A-Za-z0-9_]+)['"]\](?:\s*\|\|\s*['"]?([A-Za-z0-9_./:-]+)['"]?)?/g;
  const viteEnv = /import\.meta\.env\.([A-Za-z0-9_]+)(?:\s*\|\|\s*['"]?([A-Za-z0-9_./:-]+)['"]?)?/g;
  const pythonEnv = /(?:os\.environ\.get|os\.getenv)\s*\(\s*['"]([A-Za-z0-9_]+)['"](?:\s*,\s*['"]?([^'")]+)['"]?)?\s*\)/g;

  for (const [filePath, content] of Object.entries(input.files)) {
    // Skip .env files when scanning consumer code
    if (/(?:\.env|\.env\.example|\.env\.sample|\.env\.test)$/i.test(filePath)) continue;

    const lines = content.split('\n');

    // Helper to register read
    const registerConsumer = (key: string, lineNum: number, fallback?: string) => {
      const isSecret = SECRET_KEY_REGEX.test(key);
      const safeDefault = isSecret
        ? undefined
        : fallback ? fallback.replace(/['"]/g, '') : undefined;

      if (!configMap.has(key)) {
        configMap.set(key, {
          key,
          isSecret,
          defaultValue: safeDefault,
          sources: [],
          consumers: [],
        });
      }

      const entry = configMap.get(key)!;
      if (!entry.defaultValue && safeDefault) {
        entry.defaultValue = safeDefault;
      }

      // Check enclosing function if detectable
      const prevLines = lines.slice(Math.max(0, lineNum - 15), lineNum).join('\n');
      const funcMatch = prevLines.match(/(?:function|const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/) ||
        prevLines.match(/function\s+([A-Za-z0-9_$]+)\s*\(/);
      const functionName = funcMatch ? funcMatch[1] : undefined;

      const consumer: ConfigConsumer = {
        filePath,
        functionName,
        line: lineNum,
        expression: lines[lineNum - 1]?.trim() || `Read in ${filePath}`,
      };

      entry.consumers.push(consumer);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check nodeEnvDot
      let m: RegExpExecArray | null;
      nodeEnvDot.lastIndex = 0;
      while ((m = nodeEnvDot.exec(line)) !== null) {
        registerConsumer(m[1], lineNum, m[2]);
      }

      // Check nodeEnvBracket
      nodeEnvBracket.lastIndex = 0;
      while ((m = nodeEnvBracket.exec(line)) !== null) {
        registerConsumer(m[1], lineNum, m[2]);
      }

      // Check viteEnv
      viteEnv.lastIndex = 0;
      while ((m = viteEnv.exec(line)) !== null) {
        registerConsumer(m[1], lineNum, m[2]);
      }

      // Check pythonEnv
      pythonEnv.lastIndex = 0;
      while ((m = pythonEnv.exec(line)) !== null) {
        registerConsumer(m[1], lineNum, m[2]);
      }
    }
  }

  const configs = Array.from(configMap.values()).sort((a, b) => a.key.localeCompare(b.key));
  const secretKeysCount = configs.filter((c) => c.isSecret).length;
  const totalReads = configs.reduce((acc, c) => acc + c.consumers.length, 0);

  const hasSufficientEvidence = configs.length > 0;

  return {
    viewMode: 'config_wiring',
    title: 'Configuration & Environment Wiring View',
    hasSufficientEvidence,
    reasonIfUnsupported: hasSufficientEvidence
      ? undefined
      : 'No environment variable accesses (process.env / os.getenv) or configuration files detected in inspected code.',
    model: hasSufficientEvidence
      ? {
          configs,
          totalKeys: configs.length,
          secretKeysCount,
          totalReads,
        }
      : null,
    stats: {
      totalKeys: configs.length,
      secretKeysCount,
      totalReads,
    },
  };
}
