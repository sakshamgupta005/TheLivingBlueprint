import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_GROQ_MODEL, DEFAULT_CLOUDFLARE_MODEL } from './aiProviderRunner.ts';

export async function handleHealthApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Method not allowed. Use GET.' }));
    return;
  }

  const hasGemini = Boolean(
    (env.GEMINI_API_KEY || env.GOOGLE_GENAI_API_KEY || env.AI_API_KEY)?.trim()
  );
  const hasGroq = Boolean(env.GROQ_API_KEY?.trim());
  const hasCloudflare = Boolean(
    env.CLOUDFLARE_ACCOUNT_ID?.trim() && env.CLOUDFLARE_API_TOKEN?.trim()
  );
  const hasApiKey = hasGemini || hasGroq || hasCloudflare;
  const configuredModel = env.AI_MODEL || 'gemini-3.8-flash';
  const fallbackModel = env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
  const tertiaryModel = env.CLOUDFLARE_AI_MODEL || DEFAULT_CLOUDFLARE_MODEL;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      status: 'ok',
      service: 'The Living Blueprint API',
      timestamp: new Date().toISOString(),
      aiConfigured: hasApiKey,
      model: configuredModel,
      geminiConfigured: hasGemini,
      groqConfigured: hasGroq,
      cloudflareConfigured: hasCloudflare,
      fallbackModel,
      tertiaryModel,
    })
  );
}
