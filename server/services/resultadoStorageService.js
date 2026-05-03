const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RESULTADOS_STORAGE_BASE = path.resolve(__dirname, '../../storage/resultados');
const RESULTADOS_TMP_DIR = path.join(RESULTADOS_STORAGE_BASE, 'tmp');

function ensureResultadoDirs() {
  fs.mkdirSync(RESULTADOS_TMP_DIR, { recursive: true });
}

function resultadoFilename(prefix, ext) {
  return `${prefix}-${crypto.randomUUID()}${String(ext || '').toLowerCase()}`;
}

function cleanupUploadedFiles(files = []) {
  for (const file of files || []) {
    if (file?.path) fs.unlink(file.path, () => {});
  }
}

module.exports = {
  RESULTADOS_STORAGE_BASE,
  RESULTADOS_TMP_DIR,
  ensureResultadoDirs,
  resultadoFilename,
  cleanupUploadedFiles,
};
