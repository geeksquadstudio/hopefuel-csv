import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
    plugins: [react()],
    base: '/csvHopeFuel', // <- important for GitHub Pages
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            '@/components': fileURLToPath(new URL('./components', import.meta.url)),
        }
    }
});
