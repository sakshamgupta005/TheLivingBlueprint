import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { vitePluginAiChat } from './src/server/vitePluginAiChat.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  Object.assign(process.env, env);

  return {
    plugins: [react(), vitePluginAiChat(env)],
    server: {
      port: 3000,
      open: false,
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom'],
            'vendor-flow': ['reactflow'],
            'vendor-d3': ['d3'],
          },
        },
      },
    },
  };
});
// Reload vite config for companion chat updates
