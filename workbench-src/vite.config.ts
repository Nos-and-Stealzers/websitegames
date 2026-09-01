import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Built straight into the parent site as a subdirectory (../workbench), not deployed on its
// own. Root-absolute, not relative: the parent site's vercel.json sets trailingSlash: false,
// which redirects /workbench/ -> /workbench, and a relative asset path resolves against
// whatever the current URL happens to be — after that redirect, against "/" instead of
// "/workbench/", so every asset 404s and the page renders blank. Absolute paths don't care
// what the URL bar shows.
export default defineConfig({
  plugins: [react()],
  base: '/workbench/',
  build: {
    outDir: '../workbench',
    emptyOutDir: true,
  },
})
