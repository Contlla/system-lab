require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const path = require('path');

require('./db');

const apiRoutes = require('./routes');

const app = express();
const PUBLIC_DIR = path.join(__dirname, '../public');
const PORT = process.env.PORT || 3000;
const HTTPS_ENABLED = String(process.env.HTTPS || '').toLowerCase() === 'true';

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use(apiRoutes);

if (HTTPS_ENABLED) {
  const sslKeyPath = process.env.SSL_KEY ? path.resolve(process.env.SSL_KEY) : '';
  const sslCertPath = process.env.SSL_CERT ? path.resolve(process.env.SSL_CERT) : '';

  if (!sslKeyPath || !sslCertPath) {
    console.error('FATAL: HTTPS=true requiere SSL_KEY y SSL_CERT en el archivo .env.');
    process.exit(1);
  }

  if (!fs.existsSync(sslKeyPath) || !fs.existsSync(sslCertPath)) {
    console.error('FATAL: No se encontraron los certificados HTTPS configurados.');
    console.error(`SSL_KEY: ${sslKeyPath}`);
    console.error(`SSL_CERT: ${sslCertPath}`);
    process.exit(1);
  }

  https.createServer({
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath),
  }, app).listen(PORT, () => {
    console.log(`Servidor corriendo en https://localhost:${PORT}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
}
