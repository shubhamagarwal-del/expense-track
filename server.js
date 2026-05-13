import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
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
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
