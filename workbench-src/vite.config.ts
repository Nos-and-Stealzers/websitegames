import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Built straight into the parent site as a subdirectory (../workbench), not deployed on its
// own — so every asset reference has to stay relative rather than root-absolute.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../workbench',
    emptyOutDir: true,
  },
})
