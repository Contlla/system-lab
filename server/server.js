require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const https = require('https');
const path = require('path');

require('./db');

const apiRoutes = require('./routes');
const { errorMiddleware } = require('./middlewares/errorMiddleware');

const app = express();
const PUBLIC_DIR = path.join(__dirname, '../public');
const PORT = process.env.PORT || 3000;
const HTTPS_ENABLED = String(process.env.HTTPS || '').toLowerCase() === 'true';
const RESULTADO_VIEWER_BASE_URL = process.env.RESULTADO_VIEWER_BASE_URL || '';

function parseAllowedOrigins() {
  const configured = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const defaults = [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
  ];

  if (RESULTADO_VIEWER_BASE_URL) {
    try {
      defaults.push(new URL(RESULTADO_VIEWER_BASE_URL).origin);
    } catch {}
  }

  return new Set([...configured, ...defaults]);
}

const allowedOrigins = parseAllowedOrigins();

function originMatchesRequestHost(origin, req) {
  try {
    const parsedOrigin = new URL(origin);
    const requestHost = String(req.headers.host || '').toLowerCase();
    return Boolean(requestHost)
      && parsedOrigin.host.toLowerCase() === requestHost
      && ['http:', 'https:'].includes(parsedOrigin.protocol);
  } catch {
    return false;
  }
}

function corsOptionsDelegate(req, callback) {
  callback(null, {
    origin(origin, originCallback) {
      if (!origin || allowedOrigins.has(origin) || originMatchesRequestHost(origin, req)) {
        return originCallback(null, true);
      }
      const error = new Error('Origen no permitido por CORS');
      error.status = 403;
      return originCallback(error);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' },
});

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'connect-src': ["'self'", ...allowedOrigins],
      'frame-src': ["'self'", 'blob:', 'data:', 'https:'],
      'object-src': ["'none'"],
    },
  },
}));
app.use(cors(corsOptionsDelegate));
app.use(express.json({ limit: '4mb' }));
app.use(express.static(PUBLIC_DIR));
app.use(['/api/login', '/api/bootstrap-admin'], loginLimiter);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use(apiRoutes);
app.use(errorMiddleware);

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
