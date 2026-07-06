import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import livereload from 'livereload';
import configController from './api/config.js';
import createUserController from './api/create-user.js';
import approveExpenseController from './api/approve-expense.js';
import receiptUrlController from './api/receipt-url.js';
import resolveLoginController from './api/resolve-login.js';
import listUsersController from './api/list-users.js';
import updatePasswordController from './api/update-password.js';
import updateUserController from './api/update-user.js';
import listCompaniesController from './api/list-companies.js';
import createCompanyController from './api/create-company.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json({ limit: '12mb' })); // base64-encoded payment PDFs ride in the JSON body

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Local-dev only: auto-refresh the browser on file changes ──
// Vercel never runs this file (it uses /api/*.js as serverless functions
// directly), so this is safe to leave unguarded — but skip it explicitly
// if VERCEL is set, just in case this script is ever invoked there.
// (connect-livereload doesn't play well with express.static's sendFile
// streaming, so HTML files are served manually below with the client
// script injected directly instead.)
const LIVERELOAD_ENABLED = !process.env.VERCEL;
if (LIVERELOAD_ENABLED) {
  const lrPort = parseInt(process.env.LR_PORT || '35730', 10);
  const lrServer = livereload.createServer({
    port: lrPort,
    exts: ['html', 'css', 'js'],
    delay: 100,
    exclusions: [/node_modules/, /[\\/]public[\\/]/, /[\\/]\.vercel[\\/]/, /[\\/]\.git[\\/]/],
  });
  lrServer.watch(__dirname);
}
const LIVERELOAD_SNIPPET = `<script src="http://localhost:${process.env.LR_PORT || '35730'}/livereload.js?snipver=1"></script>`;

function serveHtmlWithLivereload(filePath, res, next) {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return next();
    const withSnippet = html.includes('</body>')
      ? html.replace('</body>', `${LIVERELOAD_SNIPPET}</body>`)
      : html + LIVERELOAD_SNIPPET;
    res.type('html').send(withSnippet);
  });
}

if (LIVERELOAD_ENABLED) {
  app.get(/\.html$/, (req, res, next) => {
    serveHtmlWithLivereload(path.join(__dirname, decodeURIComponent(req.path)), res, next);
  });
  app.get('/', (req, res, next) => {
    serveHtmlWithLivereload(path.join(__dirname, 'index.html'), res, next);
  });
}

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// Map the API routes
app.get('/api/config', (req, res) => configController(req, res));

app.post('/api/approve-expense', async (req, res) => {
  try {
    await approveExpenseController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.post('/api/create-user', async (req, res) => {
  try {
    await createUserController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.post('/api/resolve-login', async (req, res) => {
  try {
    await resolveLoginController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/list-users', async (req, res) => {
  try {
    await listUsersController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.post('/api/update-user', async (req, res) => {
  try {
    await updateUserController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.post('/api/update-password', async (req, res) => {
  try {
    await updatePasswordController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/list-companies', async (req, res) => {
  try {
    await listCompaniesController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.post('/api/create-company', async (req, res) => {
  try {
    await createCompanyController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/receipt-url', async (req, res) => {
  try {
    await receiptUrlController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.post('/api/receipt-url', async (req, res) => {
  try {
    await receiptUrlController(req, res);
  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Serve static files from current directory
app.use(express.static(__dirname));



import os from 'os';

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let localIp = 'localhost';
  
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address;
      }
    }
  }

  console.log(`\x1b[32m%s\x1b[0m`, `🚀 Server is LIVE!`);
  console.log(`💻 Local:   http://localhost:${PORT}`);
  console.log(`📱 Mobile:  http://${localIp}:${PORT}`);
  console.log(`\n\x1b[33m%s\x1b[0m`, `Tip: Ensure your mobile and PC are on the same Wi-Fi.`);
});
