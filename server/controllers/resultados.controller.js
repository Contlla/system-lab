const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { DeleteObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const { s3Client } = require('../config/s3Client');
const { get, withTransaction } = require('../db');
const { agregarPaginaVerificacionPdf } = require('../services/pdfVerificationService');

const R2_BUCKET = process.env.R2_BUCKET || 'resultados';
const RESULTADO_VIEWER_BASE_URL = process.env.RESULTADO_VIEWER_BASE_URL || 'https://system-lab-mu.vercel.app/resultado/';
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || 'https://pub-0a2e3c7a919947f49c5ccb667d660d91.r2.dev';

const uploadResultadoPdf = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 20,
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Solo se permiten archivos PDF de resultados'));
    }
    cb(null, true);
  },
});

function uploadResultadoPdfMiddleware(req, res, next) {
  uploadResultadoPdf.array('archivos', 20)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'No se pudo procesar el PDF' });
    }
    next();
  });
}

function assertPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    const err = new Error('El archivo no parece ser un PDF valido');
    err.status = 400;
    throw err;
  }
}

function readIndexedField(body, field, index, fallback = '') {
  const value = body[field];
  if (Array.isArray(value)) return value[index] ?? fallback;
  if (value !== undefined && value !== null && index === 0) return value;
  return fallback;
}

function parseNullablePositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeDocumentoTipo(value) {
  return String(value || '').trim().toLowerCase() === 'adicional' ? 'adicional' : 'principal';
}

function buildViewerUrl(uuid) {
  return `${RESULTADO_VIEWER_BASE_URL.replace(/\/+$/, '')}/${uuid}`;
}

async function deleteR2ObjectQuietly(key) {
  if (!key) return;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (err) {
    console.warn(`No se pudo limpiar objeto R2 ${key}: ${err.message}`);
  }
}

async function getOrdenActiva(ordenId) {
  const orden = await get(`
    SELECT o.id, o.folio, o.estado, p.nombre AS paciente_nombre
    FROM ordenes o
    JOIN pacientes p ON p.id = o.paciente_id
    WHERE o.id = ?
  `, [ordenId]);

  if (!orden) {
    const error = new Error('Orden no encontrada');
    error.status = 404;
    throw error;
  }
  if (orden.estado === 'cancelado') {
    const error = new Error('No se pueden subir resultados a una orden cancelada');
    error.status = 400;
    throw error;
  }
  return orden;
}

async function getEstudioEnOrden(ordenId, estudioId, fileName) {
  if (!estudioId) return null;
  const estudio = await get(`
    SELECT e.id, e.nombre, e.categoria
    FROM orden_estudios oe
    JOIN estudios e ON e.id = oe.estudio_id
    WHERE oe.orden_id = ? AND oe.estudio_id = ?
  `, [ordenId, estudioId]);

  if (!estudio) {
    const error = new Error(`El estudio del archivo ${fileName} no pertenece a la orden indicada`);
    error.status = 404;
    throw error;
  }
  return estudio;
}

async function buildUploadRequests(req, ordenId, files) {
  const requests = [];
  const principalesEnLote = new Set();

  for (const [index, file] of files.entries()) {
    const estudioId = parseNullablePositiveInt(
      readIndexedField(req.body, 'estudio_ids', index, readIndexedField(req.body, 'estudio_id', index, ''))
    );
    const documentoTipo = normalizeDocumentoTipo(
      readIndexedField(req.body, 'documento_tipos', index, req.body.documento_tipo || 'principal')
    );
    const reemplazarId = parseNullablePositiveInt(
      readIndexedField(req.body, 'reemplazar_ids', index, req.body.reemplazar_id || '')
    );
    const estudio = await getEstudioEnOrden(ordenId, estudioId, file.originalname);

    if (documentoTipo === 'principal' && !reemplazarId) {
      const principalKey = `${ordenId}:${estudioId || 'orden'}`;
      if (principalesEnLote.has(principalKey)) {
        const error = new Error('Solo puede cargarse un PDF principal por estudio en la misma subida. Marca los demas como adicionales.');
        error.status = 409;
        throw error;
      }
      principalesEnLote.add(principalKey);
    }

    requests.push({ file, estudioId, estudio, documentoTipo, reemplazarId });
  }

  for (const request of requests) {
    if (request.reemplazarId) {
      const reemplazo = await get(
        `SELECT id, orden_id, estudio_id, documento_tipo, r2_key
         FROM resultado_archivos
         WHERE id = ? AND orden_id = ?`,
        [request.reemplazarId, ordenId]
      );
      if (!reemplazo) {
        const error = new Error('El archivo a reemplazar no existe en esta orden');
        error.status = 404;
        throw error;
      }
      request.reemplazo = reemplazo;
      request.estudioId = request.estudioId ?? reemplazo.estudio_id ?? null;
      request.documentoTipo = request.documentoTipo || reemplazo.documento_tipo || 'principal';
      if (!request.estudio && request.estudioId) {
        request.estudio = await getEstudioEnOrden(ordenId, request.estudioId, request.file.originalname);
      }
    }

    if (request.documentoTipo === 'principal' && !request.reemplazarId) {
      const existing = await get(
        `SELECT id
         FROM resultado_archivos
         WHERE orden_id = ?
           AND documento_tipo = 'principal'
           AND ((? IS NULL AND estudio_id IS NULL) OR estudio_id = ?)
         LIMIT 1`,
        [ordenId, request.estudioId, request.estudioId]
      );
      if (existing) {
        const error = new Error('Este estudio ya tiene un PDF principal. Usa Reemplazar o marca el archivo como adicional.');
        error.status = 409;
        throw error;
      }
    }
  }

  return requests;
}

async function prepareAndUploadFile({ request, orden, uploadedKeys }) {
  assertPdfBuffer(request.file.buffer);

  const uuid = crypto.randomUUID();
  const key = `resultado-${uuid}.pdf`;
  const viewerUrl = buildViewerUrl(uuid);
  const qrBase64 = await QRCode.toDataURL(viewerUrl, { errorCorrectionLevel: 'M', margin: 1, width: 512 });
  const finalPdfBuffer = await agregarPaginaVerificacionPdf(request.file.buffer, {
    qrBase64,
    viewerUrl,
    uuid,
    folio: orden.folio,
    paciente: orden.paciente_nombre,
    estudio: request.estudio?.nombre || '',
  });

  await s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: finalPdfBuffer,
    ContentType: 'application/pdf',
    Metadata: {
      resultado_uuid: uuid,
      orden_id: String(orden.id),
      documento_tipo: request.documentoTipo,
      ...(request.estudioId ? { estudio_id: String(request.estudioId) } : {}),
    },
  }));
  uploadedKeys.push(key);

  const r2Url = R2_PUBLIC_BASE_URL
    ? `${R2_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`
    : `r2://${R2_BUCKET}/${key}`;

  return {
    ...request,
    uuid,
    key,
    viewerUrl,
    qrBase64,
    r2Url,
    archivoUrl: `/api/resultados/ver/${uuid}`,
  };
}

async function uploadResultadosToR2(req, res) {
  const uploadedKeys = [];
  const oldKeysToDeleteAfterCommit = [];

  try {
    const ordenId = Number.parseInt(req.body.orden_id, 10);
    const files = Array.isArray(req.files) ? req.files : [];

    if (!ordenId || ordenId < 1) return res.status(400).json({ error: 'orden_id invalido' });
    if (!files.length) return res.status(400).json({ error: 'No se recibio ningun archivo PDF' });

    const orden = await getOrdenActiva(ordenId);
    const requests = await buildUploadRequests(req, ordenId, files);
    const prepared = [];

    for (const request of requests) {
      prepared.push(await prepareAndUploadFile({ request, orden, uploadedKeys }));
    }

    const archivos = await withTransaction(async (tx) => {
      const saved = [];

      for (const item of prepared) {
        if (item.reemplazo) {
          await tx.run(`DELETE FROM resultado_archivos WHERE id = ? AND orden_id = ?`, [item.reemplazo.id, ordenId]);
          if (item.reemplazo.r2_key) oldKeysToDeleteAfterCommit.push(item.reemplazo.r2_key);
        }

        const result = await tx.run(`
          INSERT INTO resultado_archivos (
            orden_id, estudio_id, archivo_url, archivo_path, archivo_nombre,
            resultado_uuid, r2_key, r2_url, qr_base64, documento_tipo, fecha
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `, [
          ordenId,
          item.estudioId,
          item.archivoUrl,
          item.key,
          item.file.originalname,
          item.uuid,
          item.key,
          item.r2Url,
          item.qrBase64,
          item.documentoTipo,
        ]);

        saved.push({
          id: result.lastID,
          orden_id: ordenId,
          estudio_id: item.estudioId,
          estudio_nombre: item.estudio?.nombre || null,
          estudio_categoria: item.estudio?.categoria || null,
          archivo_nombre: item.file.originalname,
          archivo_url: item.archivoUrl,
          resultado_uuid: item.uuid,
          r2_key: item.key,
          r2_url: item.r2Url,
          viewer_url: item.viewerUrl,
          qr_base64: item.qrBase64,
          documento_tipo: item.documentoTipo,
        });
      }

      await tx.run(`UPDATE ordenes SET estado = CASE WHEN estado = 'completado' THEN estado ELSE 'en_proceso' END WHERE id = ?`, [ordenId]);
      return saved;
    });

    for (const key of oldKeysToDeleteAfterCommit) {
      await deleteR2ObjectQuietly(key);
    }

    res.status(201).json({
      ok: true,
      archivos,
      estado: orden.estado === 'completado' ? 'completado' : 'en_proceso',
    });
  } catch (err) {
    await Promise.all(uploadedKeys.map(deleteR2ObjectQuietly));
    console.error('uploadResultadosToR2:', err);
    const status = err.status || (err.code === 'SQLITE_CONSTRAINT' ? 409 : 500);
    res.status(status).json({ error: err.message || 'Error al subir resultado a R2' });
  }
}

module.exports = {
  uploadResultadoPdf,
  uploadResultadoPdfMiddleware,
  uploadResultadosToR2,
};
