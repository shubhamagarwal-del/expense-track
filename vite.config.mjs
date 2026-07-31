// Vite build for the React pages. Each page lives in react-src/<page>/ and is
// built separately (PAGE env var) into ONE self-contained HTML file under
// dist-react/<page>/index.html, which build.js publishes into public/ as:
//   checkin → checkin-react.html   (employee Site Check-in)
//   admin   → checkins-react.html  (HR/admin Site Check-ins view)
// External links (/style.css, /app.js, CDNs) stay external so the pages share
// the app's session, helpers, and design exactly like the vanilla pages.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const page = process.env.PAGE || 'checkin';

export default defineConfig({
  root: `react-src/${page}`,
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: `../../dist-react/${page}`,
    emptyOutDir: true,
  },
});
