import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/task': 'http://localhost:6002',
      '/rss': 'http://localhost:6002',
      '/check': 'http://localhost:6002',
      '/webhook': 'http://localhost:6002'
    }
  }
})
