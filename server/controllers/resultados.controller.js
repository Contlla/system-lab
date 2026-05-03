const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

const { s3Client } = require('../config/s3Client');
const { get, run } = require('../db');

const R2_BUCKET = process.env.R2_BUCKET || 'resultados';
const RESULTADO_VIEWER_BASE_URL = process.env.RESULTADO_VIEWER_BASE_URL || 'https://mi-visor-lab.vercel.app/resultado/';
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || '';

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

async function uploadResultadosToR2(req, res) {
  try {
    const ordenId = Number.parseInt(req.body.orden_id, 10);
    const estudioId = req.body.estudio_id ? Number.parseInt(req.body.estudio_id, 10) : null;
    const files = Array.isArray(req.files) ? req.files : [];

    if (!ordenId || ordenId < 1) return res.status(400).json({ error: 'orden_id invalido' });
    if (!files.length) return res.status(400).json({ error: 'No se recibio ningun archivo PDF' });

    const orden = await get(`SELECT id, estado FROM ordenes WHERE id = ?`, [ordenId]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (orden.estado === 'cancelado') {
      return res.status(400).json({ error: 'No se pueden subir resultados a una orden cancelada' });
    }

    if (estudioId) {
      const estudioEnOrden = await get(
        `SELECT 1 FROM orden_estudios WHERE orden_id = ? AND estudio_id = ?`,
        [ordenId, estudioId]
      );
      if (!estudioEnOrden) {
        return res.status(404).json({ error: 'El estudio no pertenece a la orden indicada' });
      }
    }

    const archivos = [];
    for (const file of files) {
      assertPdfBuffer(file.buffer);

      const uuid = crypto.randomUUID();
      const key = `resultado-${uuid}.pdf`;
      const viewerUrl = `${RESULTADO_VIEWER_BASE_URL}${uuid}`;

      await s3Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: 'application/pdf',
        Metadata: {
          resultado_uuid: uuid,
          orden_id: String(ordenId),
          ...(estudioId ? { estudio_id: String(estudioId) } : {}),
        },
      }));

      const qrBase64 = await QRCode.toDataURL(viewerUrl);
      const r2Url = R2_PUBLIC_BASE_URL
        ? `${R2_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`
        : `r2://${R2_BUCKET}/${key}`;
      const archivoUrl = `/api/resultados/ver/${uuid}`;

      const result = await run(`
        INSERT INTO resultado_archivos (
          orden_id, estudio_id, archivo_url, archivo_path, archivo_nombre,
          resultado_uuid, r2_key, r2_url, qr_base64, fecha
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `, [
        ordenId,
        estudioId,
        archivoUrl,
        key,
        file.originalname,
        uuid,
        key,
        r2Url,
        qrBase64,
      ]);

      archivos.push({
        id: result.lastID,
        orden_id: ordenId,
        estudio_id: estudioId,
        archivo_nombre: file.originalname,
        archivo_url: archivoUrl,
        resultado_uuid: uuid,
        r2_key: key,
        r2_url: r2Url,
        viewer_url: viewerUrl,
        qr_base64: qrBase64,
      });
    }

    await run(`UPDATE ordenes SET estado = CASE WHEN estado = 'completado' THEN estado ELSE 'en_proceso' END WHERE id = ?`, [ordenId]);

    res.status(201).json({
      ok: true,
      archivos,
      estado: orden.estado === 'completado' ? 'completado' : 'en_proceso',
    });
  } catch (err) {
    console.error('uploadResultadosToR2:', err);
    res.status(err.status || 500).json({ error: err.message || 'Error al subir resultado a R2' });
  }
}

module.exports = {
  uploadResultadoPdf,
  uploadResultadoPdfMiddleware,
  uploadResultadosToR2,
};
