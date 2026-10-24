/**
 * credentials.ts — AI provider credentials backed by injected SecretStorage (P2-07).
 *
 * - SecretStorage is the only default source. Environment variables are used
 *   only when the injected policy says `allowEnvCredentials: true` AND the caller
 *   injects an env object; this module never reads process.env itself.
 * - `getStatus()` returns booleans only and is safe to post to the webview.
 * - `buildProviderEnv()` returns an explicit object for executeAiWithFallback /
 *   executeAiChat / executeRoomInvestigation. Always pass it: those functions
 *   default to process.env when the argument is omitted or `undefined`.
 *   The object hides its values from JSON.stringify and console/util.inspect.
 *
 * Pure TypeScript: no vscode import. Pass `context.secrets` as the store.
 * Secret key names match the existing ones in extension.ts so stored keys survive.
 */

/** Structural subset of vscode.SecretStorage. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

export type CredentialId =
  | 'gemini'
  | 'groq'
  | 'cloudflareToken'
  | 'cloudflareAccount'
  | 'omnirouteModel'
  | 'omnirouteBaseUrl'
  | 'omnirouteKey';

export const SECRET_KEYS: Readonly<Record<CredentialId, string>> = {
  gemini: 'livingBlueprint.geminiApiKey',
  groq: 'livingBlueprint.groqApiKey',
  cloudflareToken: 'livingBlueprint.cloudflareToken',
  cloudflareAccount: 'livingBlueprint.cloudflareAccount',
  // Optional OmniRoute gateway: enabled only when a model is set.
  omnirouteModel: 'livingBlueprint.omnirouteModel',
  omnirouteBaseUrl: 'livingBlueprint.omnirouteBaseUrl',
  omnirouteKey: 'livingBlueprint.omnirouteApiKey',
};

const ENV_NAMES: Readonly<Record<CredentialId, readonly string[]>> = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cloudflareToken: ['CLOUDFLARE_API_TOKEN'],
  cloudflareAccount: ['CLOUDFLARE_ACCOUNT_ID'],
  omnirouteModel: ['OMNIROUTE_MODEL'],
  omnirouteBaseUrl: ['OMNIROUTE_BASE_URL'],
  omnirouteKey: ['OMNIROUTE_API_KEY'],
};

const IDS = Object.keys(SECRET_KEYS) as CredentialId[];
const MAX_CREDENTIAL_LENGTH = 512;

export interface CredentialPolicy {
  /** Default false. Mirrors the future `livingBlueprint.allowEnvCredentials` setting. */
  allowEnvCredentials: boolean;
}

export interface CredentialStatus {
  gemini: boolean;
  groq: boolean;
  /** True only when both the Cloudflare token and account id are present. */
  cloudflare: boolean;
  /** True when an OmniRoute model is set (base URL defaults to localhost; key optional). */
  omniroute: boolean;
  anyConfigured: boolean;
  /** True when at least one value came from the environment (show this in the status bar). */
  usingEnvironment: boolean;
}

/** Only the credential variable names aiProviderRunner reads; nothing else from the environment. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export interface CredentialServiceOptions {
  secrets: SecretStore;
  /** Read on every call so a settings change applies immediately. Defaults to env disabled. */
  getPolicy?: () => CredentialPolicy;
  /** Only consulted when the policy allows it. Inject process.env explicitly if wanted. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface CredentialService {
  getStatus(): Promise<CredentialStatus>;
  buildProviderEnv(): Promise<ProviderEnv>;
  /** All resolved secret values, for redactSensitiveInfo(text, values). Never log the array. */
  getSecretValues(): Promise<string[]>;
  setCredential(id: CredentialId, value: string): Promise<void>;
  clearAll(): Promise<void>;
}

export class InvalidCredentialError extends Error {
  constructor(reason: string) {
    super(`Invalid credential: ${reason}`);
    this.name = 'InvalidCredentialError';
  }
}

function hideValues<T extends object>(obj: T): T {
  const label = '[credentials hidden]';
  Object.defineProperty(obj, 'toJSON', { value: () => label, enumerable: false });
  Object.defineProperty(obj, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => label,
    enumerable: false,
  });
  return obj;
}

export function createCredentialService(options: CredentialServiceOptions): CredentialService {
  const getPolicy = options.getPolicy ?? (() => ({ allowEnvCredentials: false }));

  async function resolve(): Promise<{ values: Partial<Record<CredentialId, string>>; fromEnv: boolean }> {
    const allowEnv = getPolicy().allowEnvCredentials === true && options.env !== undefined;
    const values: Partial<Record<CredentialId, string>> = {};
    let fromEnv = false;

    for (const id of IDS) {
      const stored = (await options.secrets.get(SECRET_KEYS[id]))?.trim();
      if (stored) {
        values[id] = stored;
        continue;
      }
      if (allowEnv) {
        const envValue = ENV_NAMES[id].map((name) => options.env?.[name]?.trim()).find(Boolean);
        if (envValue) {
          values[id] = envValue;
          fromEnv = true;
        }
      }
    }
    return { values, fromEnv };
  }

  return {
    async getStatus() {
      const { values, fromEnv } = await resolve();
      const gemini = Boolean(values.gemini);
      const groq = Boolean(values.groq);
      const cloudflare = Boolean(values.cloudflareToken && values.cloudflareAccount);
      const omniroute = Boolean(values.omnirouteModel);
      return {
        gemini,
        groq,
        cloudflare,
        omniroute,
        anyConfigured: gemini || groq || cloudflare || omniroute,
        usingEnvironment: fromEnv,
      };
    },

    async buildProviderEnv() {
      const { values } = await resolve();
      return hideValues({
        GEMINI_API_KEY: values.gemini,
        GROQ_API_KEY: values.groq,
        CLOUDFLARE_API_TOKEN: values.cloudflareToken,
        CLOUDFLARE_ACCOUNT_ID: values.cloudflareAccount,
        OMNIROUTE_MODEL: values.omnirouteModel,
        OMNIROUTE_BASE_URL: values.omnirouteBaseUrl,
        OMNIROUTE_API_KEY: values.omnirouteKey,
      });
    },

    async getSecretValues() {
      const { values } = await resolve();
      return Object.values(values).filter((v): v is string => Boolean(v));
    },

    async setCredential(id, value) {
      if (!Object.prototype.hasOwnProperty.call(SECRET_KEYS, id)) {
        throw new InvalidCredentialError('unknown provider');
      }
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!trimmed) throw new InvalidCredentialError('empty value');
      if (trimmed.length > MAX_CREDENTIAL_LENGTH) throw new InvalidCredentialError('value too long');
      if (/\s/.test(trimmed)) throw new InvalidCredentialError('value contains whitespace');
      if (id === 'omnirouteBaseUrl' && !/^https?:\/\/[^/\s]+/i.test(trimmed)) {
        throw new InvalidCredentialError('base URL must start with http:// or https://');
      }
      await options.secrets.store(SECRET_KEYS[id], trimmed);
    },

    async clearAll() {
      for (const id of IDS) {
        await options.secrets.delete(SECRET_KEYS[id]);
      }
    },
  };
}
