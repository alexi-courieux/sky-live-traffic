import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// adsb.fi sends no CORS headers, so the browser talks to it through this proxy
// (dev server and `vite preview`). Production needs its own proxy, see README.
const adsbProxy = {
  '/api/adsb': {
    target: 'https://opendata.adsb.fi',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/adsb/, '/api').replace(/\?cache=long$/, ''), // the hint is only for the caching worker
  },
}

// https://vite.dev/config/
export default defineConfig({
  base: '/pixijs-react/',
  plugins: [react()],
  server: { proxy: adsbProxy },
  preview: { proxy: adsbProxy },
})
