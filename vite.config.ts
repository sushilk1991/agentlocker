import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  resolve: { alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) } },
  publicDir: false,
  plugins: [react(), tailwindcss(), {
    name: 'sonner-csp-nonce',
    transform(code, id) {
      if (!/sonner[/\\]dist[/\\]index\.mjs$/.test(id)) return;
      const marker = "style.type = 'text/css'";
      if (!code.includes(marker)) throw new Error('Review Sonner CSP integration after upgrading.');
      return code.replace(marker, marker + "; style.nonce = document.querySelector('meta[name=csp-nonce]')?.content || ''");
    },
  }],
  build: { outDir: '../dist-web', emptyOutDir: true },
});
