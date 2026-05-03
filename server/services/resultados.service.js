require('dotenv').config();

const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcrypt');
const multer   = require('multer');
const crypto   = require('crypto');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

const { run, get, all, withTransaction } = require('../db');
const { s3Client } = require('../config/s3Client');
const authMiddleware    = require('../middlewares/authMiddleware');
const ordenService = require('../services/ordenService');
const resultadoStorage = require('../services/resultadoStorageService');
const {
  ROLES,
  PERMISSIONS,
  isValidRole,
  normalizePermissions,
  resolveUserPermissions,
  serializePermissions,
  buildAuthUser,
  hasPermission,
} = require('../permissions');


/* =========================
   JWT SECRET
========================= */
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set.');
  process.exit(1);
}

const PUBLIC_DIR = path.join(__dirname, '../../public');
const R2_BUCKET = process.env.R2_BUCKET || 'resultados';
const EMPRESA_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPRESA_RUC_RE = /^[\d-]{5,20}$/;
const EMPRESA_RFC_RE = /^[A-Za-z0-9-]{5,20}$/;

function normalizeEmpresaPayload(body = {}) {
  const cleanText = (value) => String(value || '')
    .replace(/[\u0000-\u001F\u007F\uFEFF\u200B-\u200D]/g, ' ')
    .replace(/\uFFFD/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanPhone = (value) => cleanText(value).replace(/[^0-9+()\-. ext]/gi, '').trim();

  return {
    nombre: cleanText(body.nombre),
    direccion: cleanText(body.direccion),
    ruc: cleanText(body.ruc),
    rfc: cleanText(body.rfc),
    telefono: cleanPhone(body.telefono),
    correo: cleanText(body.correo),
    logo: body.logo || null,
    version: typeof body.version === 'string' ? body.version.trim() : '',
  };
}

function validarEmpresaPayload(data) {
  if (!data.nombre) return 'El nombre de la empresa es requerido';
  if (data.nombre.length > 120) return 'El nombre no puede superar 120 caracteres';
  if (data.correo && !EMPRESA_EMAIL_RE.test(data.correo)) return 'El correo electronico no es valido';
  if (data.ruc && !EMPRESA_RUC_RE.test(data.ruc)) return 'El RUC solo debe contener numeros y guiones (5-20 caracteres)';
  if (data.rfc && !EMPRESA_RFC_RE.test(data.rfc)) return 'El RFC no es valido (5-20 caracteres alfanumericos)';

  if (data.logo && typeof data.logo === 'string') {
    if (!/^data:image\/(jpeg|png|webp|svg\+xml);base64,/.test(data.logo)) {
      return 'Formato de logo invalido';
    }
    if (data.logo.length > 3_600_000) {
      return 'El logo supera el tamano maximo permitido';
    }
  }

  return null;
}

function signUserToken(user) {
  return jwt.sign(buildAuthUser(user), SECRET, { expiresIn: '8h' });
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user, permission)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    next();
  };
}

function cleanupUploadedFiles(files = []) {
  resultadoStorage.cleanupUploadedFiles(files);
}

function parseUserPayload(body = {}, { requirePassword = true } = {}) {
  const usuario = String(body.usuario || '').trim();
  const password = typeof body.password === 'string' ? body.password : '';
  const role = String(body.role || '').trim();
  const permissions = normalizePermissions(body.permissions);

  if (!usuario) return { error: 'Usuario requerido' };
  if (!isValidRole(role)) return { error: `Rol inválido. Válidos: ${ROLES.join(', ')}` };
  if (requirePassword && (!password || password.length < 10)) {
    return { error: 'Contraseña mínimo 10 caracteres' };
  }
  if (!requirePassword && password && password.length < 10) {
    return { error: 'Contraseña mínimo 10 caracteres' };
  }

  return {
    usuario,
    password,
    role,
    permissions,
    permissionsSerialized: serializePermissions(permissions),
  };
}

function authUploadsMiddleware(req, res, next) {
  const headerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.split(' ')[1]
    : null;
  const token = headerToken || req.query.token;

  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}


/* =========================
   HELPER: Fecha/hora local (zona horaria del servidor)
   Devuelve "YYYY-MM-DD HH:MM:SS" en hora local,
   evitando el desfase UTC de datetime('now') en SQLite.
========================= */
function ahoraLocal() {
  const TZ = process.env.TZ_OFFSET !== undefined
    ? parseInt(process.env.TZ_OFFSET)
    : null;

  const now = new Date();

  // Si se definiÃ³ TZ_OFFSET en .env (ej: TZ_OFFSET=-6 para MÃ©xico Centro),
  // calculamos manualmente. Si no, usamos la hora local del sistema operativo.
  let fechaRef;
  if (TZ !== null && !isNaN(TZ)) {
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    fechaRef  = new Date(utc + TZ * 3600000);
  } else {
    fechaRef = now;
  }

  const pad = n => String(n).padStart(2, '0');
  return `${fechaRef.getFullYear()}-${pad(fechaRef.getMonth()+1)}-${pad(fechaRef.getDate())} ` +
         `${pad(fechaRef.getHours())}:${pad(fechaRef.getMinutes())}:${pad(fechaRef.getSeconds())}`;
}

const ESTADOS_ORDEN = Object.freeze({
  PENDIENTE: 'pendiente',
  EN_PROCESO: 'en_proceso',
  COMPLETADO: 'completado',
  CANCELADO: 'cancelado',
});

const ESTADOS_PAGO = Object.freeze({
  PENDIENTE: 'pendiente',
  PARCIAL: 'parcial',
  PAGADO: 'pagado',
});

const CATEGORIAS_ESTUDIO_VALIDAS = [
  'BIOQU\u00cdMICA',
  'BIOLOG\u00cdA MOLECULAR',
  'ENDOCRINOLOG\u00cdA',
  'GENERAL',
  'HEMATOLOG\u00cdA',
  'INMUNOLOG\u00cdA',
  'MARCADORES TUMORALES',
  'MICROBIOLOG\u00cdA',
  'PATOLOG\u00cdA',
  'PERFILES',
  'QU\u00cdMICA ESPECIAL',
  'TOXICOLOG\u00cdA',
  'UROAN\u00c1LISIS',
  'OTROS',
];

const CATEGORIAS_ESTUDIO_POR_CLAVE = Object.freeze(
  CATEGORIAS_ESTUDIO_VALIDAS.reduce((acc, categoria) => {
    acc[canonicalizarTexto(categoria)] = categoria;
    return acc;
  }, {})
);

async function existeAlgunUsuario(executor = { get }) {
  const row = await executor.get(`SELECT COUNT(*) AS total FROM usuarios`);
  return Number(row?.total || 0) > 0;
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveMoney(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
}

async function getSesionCajaActiva(executor = { get }) {
  return executor.get(`
    SELECT *
    FROM sesiones_caja
    WHERE estado = 'abierta'
    ORDER BY id DESC
    LIMIT 1
  `);
}

async function requireSesionCajaActiva(executor = { get }) {
  const sesion = await getSesionCajaActiva(executor);
  if (!sesion) {
    const error = new Error('No hay una sesion de caja abierta');
    error.status = 409;
    throw error;
  }
  return sesion;
}

function canonicalizarTexto(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\uFFFD/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarCategoria(categoria) {
  const key = canonicalizarTexto(categoria);
  return CATEGORIAS_ESTUDIO_POR_CLAVE[key] || null;
}

function calcularEdadDesdeFecha(fechaNacimiento) {
  if (!fechaNacimiento) return null;
  const match = String(fechaNacimiento).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const birth = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(birth.getTime())) return null;
  if (birth.getUTCFullYear() !== year || birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day) return null;
  const now = new Date();
  let edad = now.getUTCFullYear() - year;
  const currentMonth = now.getUTCMonth() + 1;
  const currentDay = now.getUTCDate();
  if (currentMonth < month || (currentMonth === month && currentDay < day)) edad -= 1;
  if (edad < 0 || edad > 149) return null;
  return edad;
}

async function sincronizarEstadoPagoOrden(ordenId, executor = { get, run }) {
  const orden = await executor.get(`SELECT id, total, pagado, saldo, estado_pago FROM ordenes WHERE id = ?`, [ordenId]);
  if (!orden) return null;

  let estadoPago = ESTADOS_PAGO.PENDIENTE;
  if (Number(orden.saldo) <= 0 && Number(orden.total) > 0) estadoPago = ESTADOS_PAGO.PAGADO;
  else if (Number(orden.pagado) > 0) estadoPago = ESTADOS_PAGO.PARCIAL;

  if (estadoPago !== orden.estado_pago) {
    await executor.run(`UPDATE ordenes SET estado_pago = ? WHERE id = ?`, [estadoPago, ordenId]);
  }

  return estadoPago;
}

async function generarFolioEnTx(executor, sucursal) {
  const year = new Date().getFullYear();
  const folioPrefix = `LAB-${sucursal}-${year}-`;
  const row = await executor.get(
    `SELECT MAX(CAST(SUBSTR(folio, LENGTH(?)+1) AS INTEGER)) AS ultimo
     FROM ordenes WHERE folio LIKE ?`,
    [folioPrefix, `${folioPrefix}%`]
  );
  const siguiente = (row?.ultimo ?? 0) + 1;
  return `${folioPrefix}${String(siguiente).padStart(6, '0')}`;
}

function normalizarCampoEtiqueta(value, fallback = '') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean || fallback;
}

function firmaTubosCompartidos(estudio = {}) {
  return [
    normalizarCampoEtiqueta(estudio.tipo_muestra, 'SIN_MUESTRA').toUpperCase(),
    normalizarCampoEtiqueta(estudio.tipo_tubo, 'SIN_TUBO').toUpperCase(),
    normalizarCampoEtiqueta(estudio.color_tapa, 'SIN_COLOR').toUpperCase(),
    normalizarCampoEtiqueta(estudio.area_proceso, 'SIN_AREA').toUpperCase(),
  ].join('|');
}

async function regenerarEtiquetasOrden(ordenId, executor = { get, all, run }) {
  const orden = await executor.get(`
    SELECT
      o.id,
      o.folio,
      o.sucursal,
      o.fecha,
      o.paciente_id,
      p.nombre AS paciente_nombre
    FROM ordenes o
    JOIN pacientes p ON p.id = o.paciente_id
    WHERE o.id = ?
  `, [ordenId]);

  if (!orden) {
    throw new Error('Orden no encontrada para generar etiquetas');
  }

  const estudios = await executor.all(`
    SELECT
      oe.id AS orden_estudio_id,
      oe.estudio_id,
      oe.precio,
      e.nombre,
      e.tipo_muestra,
      e.tipo_tubo,
      e.color_tapa,
      e.tubos_requeridos,
      e.area_proceso,
      e.comparte_tubo
    FROM orden_estudios oe
    JOIN estudios e ON e.id = oe.estudio_id
    WHERE oe.orden_id = ?
    ORDER BY e.nombre ASC
  `, [ordenId]);

  await executor.run(`DELETE FROM orden_tubos WHERE orden_id = ?`, [ordenId]);

  if (!estudios.length) return [];

  const etiquetas = [];
  const compartidos = new Map();
  let correlativo = 0;

  const pushEtiqueta = async ({
    ordenEstudioId = null,
    estudioId = null,
    grupoClave = null,
    tipoMuestra = '',
    tipoTubo = '',
    colorTapa = '',
    areaProceso = '',
    estudiosResumen = '',
    indiceTubo = 1,
    totalTubosGrupo = 1,
    comparteTubo = 0,
  }) => {
    correlativo += 1;
    const etiquetaUid = `${orden.folio}-TB${String(correlativo).padStart(2, '0')}`;

    await executor.run(`
      INSERT INTO orden_tubos (
        orden_id, folio_orden, paciente_id, orden_estudio_id, estudio_id,
        grupo_clave, etiqueta_uid, tipo_muestra, tipo_tubo, color_tapa,
        area_proceso, estudios_resumen, indice_tubo, total_tubos_grupo,
        comparte_tubo, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      orden.id,
      orden.folio,
      orden.paciente_id,
      ordenEstudioId,
      estudioId,
      grupoClave,
      etiquetaUid,
      normalizarCampoEtiqueta(tipoMuestra),
      normalizarCampoEtiqueta(tipoTubo),
      normalizarCampoEtiqueta(colorTapa),
      normalizarCampoEtiqueta(areaProceso),
      estudiosResumen,
      indiceTubo,
      totalTubosGrupo,
      comparteTubo ? 1 : 0,
      ahoraLocal(),
    ]);
  };

  for (const estudio of estudios) {
    const tubosRequeridos = Math.max(1, Number(estudio.tubos_requeridos || 1));
    if (Number(estudio.comparte_tubo) === 1) {
      const key = firmaTubosCompartidos(estudio);
      if (!compartidos.has(key)) {
        compartidos.set(key, []);
      }
      compartidos.get(key).push({ ...estudio, tubosRequeridos });
      continue;
    }

    for (let i = 1; i <= tubosRequeridos; i += 1) {
      await pushEtiqueta({
        ordenEstudioId: estudio.orden_estudio_id,
        estudioId: estudio.estudio_id,
        grupoClave: `IND-${estudio.orden_estudio_id}`,
        tipoMuestra: estudio.tipo_muestra,
        tipoTubo: estudio.tipo_tubo,
        colorTapa: estudio.color_tapa,
        areaProceso: estudio.area_proceso,
        estudiosResumen: normalizarCampoEtiqueta(estudio.nombre, 'Estudio sin nombre'),
        indiceTubo: i,
        totalTubosGrupo: tubosRequeridos,
        comparteTubo: 0,
      });
    }
  }

  for (const [grupoClave, items] of compartidos.entries()) {
    const cantidadGrupo = items.reduce((maximo, item) => Math.max(maximo, item.tubosRequeridos), 1);
    const nombres = [...new Set(items.map((item) => normalizarCampoEtiqueta(item.nombre)).filter(Boolean))];
    const resumen = nombres.join(', ');
    const base = items[0];

    for (let i = 1; i <= cantidadGrupo; i += 1) {
      await pushEtiqueta({
        estudioId: base.estudio_id,
        grupoClave,
        tipoMuestra: base.tipo_muestra,
        tipoTubo: base.tipo_tubo,
        colorTapa: base.color_tapa,
        areaProceso: base.area_proceso,
        estudiosResumen: resumen || 'Grupo compartido',
        indiceTubo: i,
        totalTubosGrupo: cantidadGrupo,
        comparteTubo: 1,
      });
    }
  }

  return executor.all(`
    SELECT *
    FROM orden_tubos
    WHERE orden_id = ?
    ORDER BY id ASC
  `, [orden.id]);
}

async function sincronizarEstadoOrdenPorResultados(ordenId) {
  const orden = await get(`SELECT id, estado FROM ordenes WHERE id = ?`, [ordenId]);
  if (!orden) return null;
  if (orden.estado === ESTADOS_ORDEN.CANCELADO) return orden.estado;

  const conArchivo = await get(`SELECT COUNT(*) AS total FROM resultado_archivos WHERE orden_id = ?`, [ordenId]);

  const cargados = Number(conArchivo?.total || 0);

  let estadoNuevo = ESTADOS_ORDEN.PENDIENTE;
  if (cargados > 0) {
    estadoNuevo = orden.estado === ESTADOS_ORDEN.COMPLETADO
      ? ESTADOS_ORDEN.COMPLETADO
      : ESTADOS_ORDEN.EN_PROCESO;
  }

  if (estadoNuevo !== orden.estado) {
    await run(`UPDATE ordenes SET estado = ? WHERE id = ?`, [estadoNuevo, ordenId]);
  }

  return estadoNuevo;
}

/* =========================
   MULTER â€” storage corregido
   Usa /tmp primero, luego mueve al destino correcto
========================= */
const RESULTADOS_STORAGE_BASE = resultadoStorage.RESULTADOS_STORAGE_BASE;
const RESULTADOS_TMP_DIR = resultadoStorage.RESULTADOS_TMP_DIR;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Guardar temporalmente, se mueve despuÃ©s con los datos del body
    fs.mkdirSync(RESULTADOS_TMP_DIR, { recursive: true });
    cb(null, RESULTADOS_TMP_DIR);
  },
  filename: (req, file, cb) => {
    const ext   = path.extname(file.originalname).toLowerCase();
    cb(null, `tmp-${crypto.randomUUID()}${ext}`);
  }
});

const MIMES_VALIDOS = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/bmp'
];

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (MIMES_VALIDOS.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido. Solo PDF e imÃ¡genes.'));
  }
});

/* =========================
   LOGIN
========================= */


const get_resultados_pendientes = async (req, res) => {
  try {
    const buscar = req.query.buscar ? `%${req.query.buscar}%` : '%';
    const limit  = Math.min(parseInt(req.query.limit)||60, 200);

    const ordenes = await all(`
      SELECT o.id, o.folio, o.estado, o.sucursal, o.medico, o.fecha, o.total,
             p.nombre AS paciente_nombre, p.celular AS paciente_celular
      FROM ordenes o
      JOIN pacientes p ON p.id = o.paciente_id
      WHERE o.estado IN ('pendiente', 'en_proceso')
        AND (p.nombre LIKE ? OR o.folio LIKE ? OR p.celular LIKE ?)
      ORDER BY o.id DESC
      LIMIT ?
    `, [buscar, buscar, buscar, limit]);

    res.json(ordenes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_resultados_completados = async (req, res) => {
  try {
    const buscar = req.query.buscar ? `%${req.query.buscar}%` : '%';
    const limit  = Math.min(parseInt(req.query.limit) || 100, 500);

    const ordenes = await all(`
      SELECT o.id, o.folio, o.estado, o.sucursal, o.medico, o.fecha, o.total,
             p.nombre AS paciente_nombre, p.celular AS paciente_celular
      FROM ordenes o
      JOIN pacientes p ON p.id = o.paciente_id
      WHERE o.estado = 'completado'
        AND (p.nombre LIKE ? OR o.folio LIKE ? OR p.celular LIKE ?)
      ORDER BY o.id DESC
      LIMIT ?
    `, [buscar, buscar, buscar, limit]);

    res.json(ordenes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_resultados_orden_by_folio = async (req, res) => {
  try {
    const { folio } = req.params;

    const orden = await get(`
      SELECT o.*, p.nombre AS paciente_nombre,
             p.celular AS paciente_celular, p.fecha_nacimiento AS paciente_fecha_nacimiento, p.edad AS paciente_edad, p.sexo AS paciente_sexo
      FROM ordenes o
      JOIN pacientes p ON p.id = o.paciente_id
      WHERE o.folio = ?
    `, [folio]);

    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

    const estudios = await all(`
      SELECT oe.estudio_id, oe.precio, e.nombre, e.categoria
      FROM orden_estudios oe
      JOIN estudios e ON e.id = oe.estudio_id
      WHERE oe.orden_id = ?
      ORDER BY e.categoria, e.nombre
    `, [orden.id]);

    const archivosRows = await all(`
      SELECT ra.id,
             ra.orden_id,
             ra.estudio_id,
             ra.archivo_url,
             ra.archivo_path,
             ra.archivo_nombre,
             ra.resultado_uuid,
             ra.r2_key,
             ra.r2_url,
             ra.qr_base64,
             ra.fecha,
             e.nombre    AS estudio_nombre,
             e.categoria AS estudio_categoria
      FROM resultado_archivos ra
      LEFT JOIN estudios e ON e.id = ra.estudio_id
      WHERE ra.orden_id = ?
      ORDER BY datetime(ra.fecha) DESC, ra.id DESC
    `, [orden.id]);
    const archivos = archivosRows.map((archivo) => {
      const current = String(archivo.archivo_url || '');
      const filename = path.basename(current || archivo.archivo_path || '');
      return {
        ...archivo,
        archivo_url: current.startsWith('/api/resultados/ver/')
          ? current
          : `/api/resultados/ver/${filename}`,
      };
    });

    res.json({ orden, estudios, archivos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_resultados_ver_by_filename = async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    if (!filename || filename !== req.params.filename) {
      return res.status(400).json({ error: 'Nombre de archivo invalido' });
    }
    const uuidOrName = filename.replace(/\.pdf$/i, '');

    const archivo = await get(`
      SELECT *
      FROM resultado_archivos
      WHERE archivo_url = ?
         OR archivo_url LIKE ?
         OR archivo_path LIKE ?
         OR resultado_uuid = ?
         OR r2_key LIKE ?
      LIMIT 1
    `, [
      `/api/resultados/ver/${filename}`,
      `%/${filename}`,
      `%${path.sep}${filename}`,
      uuidOrName,
      `%/${uuidOrName}.pdf`,
    ]);

    if (!archivo) return res.status(404).json({ error: 'Archivo no encontrado' });

    if (archivo.r2_key) {
      const object = await s3Client.send(new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: archivo.r2_key,
      }));
      res.setHeader('Content-Type', object.ContentType || 'application/pdf');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (object.ContentLength) res.setHeader('Content-Length', String(object.ContentLength));
      return object.Body.pipe(res);
    }

    const storedPath = archivo.archivo_path
      ? path.resolve(archivo.archivo_path)
      : path.resolve(PUBLIC_DIR, String(archivo.archivo_url || '').replace(/^\//, ''));
    const privateBase = path.resolve(RESULTADOS_STORAGE_BASE);
    const legacyBase = path.resolve(PUBLIC_DIR, 'uploads/resultados');
    const allowed = storedPath.startsWith(privateBase + path.sep) || storedPath.startsWith(legacyBase + path.sep);
    if (!allowed) return res.status(403).json({ error: 'Ruta de archivo no permitida' });
    if (!fs.existsSync(storedPath)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(storedPath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_resultados_subir = async (req, res) => {
  const movedFiles = [];
  try {
    const ordenId = parsePositiveInt(req.body.orden_id);
    const estudioId = req.body.estudio_id ? parsePositiveInt(req.body.estudio_id) : null;

    if (!Array.isArray(req.files) || !req.files.length) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ error: 'No se recibio ningun archivo' });
    }
    if (!ordenId) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ error: 'orden_id invalido' });
    }

    const orden = await get(`SELECT * FROM ordenes WHERE id = ?`, [ordenId]);
    if (!orden) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    if (orden.estado === ESTADOS_ORDEN.CANCELADO) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ error: 'No se pueden subir resultados a una orden cancelada' });
    }

    if (estudioId) {
      const estudioEnOrden = await get(
        `SELECT 1 FROM orden_estudios WHERE orden_id = ? AND estudio_id = ?`,
        [ordenId, estudioId]
      );
      if (!estudioEnOrden) {
        cleanupUploadedFiles(req.files);
        return res.status(404).json({ error: 'El estudio no pertenece a la orden indicada' });
      }
    }

    const destDir = path.join(RESULTADOS_STORAGE_BASE, String(ordenId));
    fs.mkdirSync(destDir, { recursive: true });

    const archivos = [];
    for (const [index, file] of req.files.entries()) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!isValidUploadedResultFile(file.path, file.mimetype)) {
        const error = new Error('El contenido del archivo no coincide con el tipo permitido');
        error.status = 400;
        throw error;
      }
      const stamp = crypto.randomUUID();
      const newName = estudioId
        ? `estudio-${estudioId}-${stamp}${ext}`
        : `resultado-${stamp}${ext}`;
      const destPath = path.join(destDir, newName);
      fs.renameSync(file.path, destPath);
      movedFiles.push(destPath);

      const archivoUrl = `/api/resultados/ver/${newName}`;
      const result = await run(`
        INSERT INTO resultado_archivos (orden_id, estudio_id, archivo_url, archivo_path, archivo_nombre, fecha)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `, [ordenId, estudioId, archivoUrl, destPath, file.originalname]);

      archivos.push({
        id: result.lastID,
        orden_id: ordenId,
        estudio_id: estudioId,
        archivo_url: archivoUrl,
        archivo_nombre: file.originalname
      });
    }

    const estadoNuevo = await sincronizarEstadoOrdenPorResultados(ordenId);

    res.status(201).json({
      ok: true,
      archivos,
      estado: estadoNuevo
    });

  } catch (err) {
    cleanupUploadedFiles(req.files);
    for (const filePath of movedFiles) fs.unlink(filePath, () => {});
    console.error(err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.message?.includes('no permitido')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
};

const delete_resultados_archivo_by_id = async (req, res) => {
  try {
    const archivo = await get(`SELECT * FROM resultado_archivos WHERE id = ?`, [req.params.id]);
    if (!archivo) return res.status(404).json({ error: 'Archivo no encontrado' });

    const fullPath = archivo.archivo_path
      ? path.resolve(archivo.archivo_path)
      : path.join(__dirname, '../../public', archivo.archivo_url);
    fs.unlink(fullPath, () => {});

    await run(`DELETE FROM resultado_archivos WHERE id = ?`, [req.params.id]);

    const estado = await sincronizarEstadoOrdenPorResultados(archivo.orden_id);

    res.json({ ok: true, estado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_resultados_completar_by_ordenId = async (req, res) => {
  try {
    const ordenId = parsePositiveInt(req.params.ordenId);
    if (!ordenId) return res.status(400).json({ error: 'orden_id invalido' });

    const orden = await get(`SELECT id, estado FROM ordenes WHERE id = ?`, [ordenId]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (orden.estado === ESTADOS_ORDEN.CANCELADO) {
      return res.status(400).json({ error: 'No se puede completar una orden cancelada' });
    }

    const archivos = await get(`SELECT COUNT(*) AS total FROM resultado_archivos WHERE orden_id = ?`, [ordenId]);
    if (!Number(archivos?.total || 0)) {
      return res.status(400).json({ error: 'Carga al menos un archivo antes de completar la orden' });
    }

    await run(`UPDATE ordenes SET estado = ? WHERE id = ?`, [ESTADOS_ORDEN.COMPLETADO, ordenId]);
    res.json({ ok: true, estado: ESTADOS_ORDEN.COMPLETADO });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_resultados_reabrir_by_ordenId = async (req, res) => {
  try {
    const ordenId = parsePositiveInt(req.params.ordenId);
    if (!ordenId) return res.status(400).json({ error: 'orden_id invalido' });

    const orden = await get(`SELECT id, estado FROM ordenes WHERE id = ?`, [ordenId]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (orden.estado === ESTADOS_ORDEN.CANCELADO) {
      return res.status(400).json({ error: 'No se puede reabrir una orden cancelada' });
    }

    const archivos = await get(`SELECT COUNT(*) AS total FROM resultado_archivos WHERE orden_id = ?`, [ordenId]);
    const estadoNuevo = Number(archivos?.total || 0) > 0 ? ESTADOS_ORDEN.EN_PROCESO : ESTADOS_ORDEN.PENDIENTE;
    await run(`UPDATE ordenes SET estado = ? WHERE id = ?`, [estadoNuevo, ordenId]);

    res.json({ ok: true, estado: estadoNuevo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  upload,
  get_resultados_pendientes,
  get_resultados_completados,
  get_resultados_orden_by_folio,
  get_resultados_ver_by_filename,
  post_resultados_subir,
  delete_resultados_archivo_by_id,
  post_resultados_completar_by_ordenId,
  post_resultados_reabrir_by_ordenId,
};
