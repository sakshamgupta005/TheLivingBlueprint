import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { vitePluginAiChat } from './src/server/vitePluginAiChat.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
  if (env.AI_MODEL) process.env.AI_MODEL = env.AI_MODEL;
  if (env.GROQ_API_KEY) process.env.GROQ_API_KEY = env.GROQ_API_KEY;
  if (env.GROQ_MODEL) process.env.GROQ_MODEL = env.GROQ_MODEL;
  if (env.CLOUDFLARE_ACCOUNT_ID) process.env.CLOUDFLARE_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
  if (env.CLOUDFLARE_API_TOKEN) process.env.CLOUDFLARE_API_TOKEN = env.CLOUDFLARE_API_TOKEN;
  if (env.CLOUDFLARE_AI_MODEL) process.env.CLOUDFLARE_AI_MODEL = env.CLOUDFLARE_AI_MODEL;

  return {
    plugins: [react(), vitePluginAiChat(env)],
    server: {
      port: 3000,
      open: false,
    },
  };
});
// Reload vite config for extension download

