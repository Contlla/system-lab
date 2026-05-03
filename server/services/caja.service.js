require('dotenv').config();

const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcrypt');
const multer   = require('multer');
const crypto   = require('crypto');

const { run, get, all, withTransaction } = require('../db');
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


const get_caja_orden_by_folio = async (req, res) => {
  try {
    const { folio } = req.params;

    const orden = await get(`
      SELECT o.*, p.nombre AS paciente_nombre
      FROM ordenes o
      JOIN pacientes p ON p.id = o.paciente_id
      WHERE o.folio = ?
    `, [folio]);

    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

    const estudios = await all(`
      SELECT oe.precio, e.nombre, e.indicaciones
      FROM orden_estudios oe
      JOIN estudios e ON e.id = oe.estudio_id
      WHERE oe.orden_id = ?
    `, [orden.id]);

    const pagos = await all(`
      SELECT * FROM pagos WHERE orden_id = ? ORDER BY id ASC
    `, [orden.id]);

    const empresa = await get(`SELECT * FROM empresa WHERE id = 1`);

    res.json({ orden, estudios, pagos, empresa });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_caja_sesion_activa = async (_req, res) => {
  try {
    const sesion = await getSesionCajaActiva();
    res.json({ sesion: sesion || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_caja_sesion_abrir = async (req, res) => {
  try {
    const saldoInicial = req.body?.saldo_inicial == null ? 0 : parsePositiveMoney(req.body.saldo_inicial);
    const observaciones = String(req.body?.observaciones || '').trim() || null;
    if (req.body?.saldo_inicial != null && saldoInicial == null) {
      return res.status(400).json({ error: 'Saldo inicial invalido' });
    }

    const sesion = await withTransaction(async (tx) => {
      const activa = await getSesionCajaActiva(tx);
      if (activa) {
        const error = new Error('Ya existe una sesion de caja abierta');
        error.status = 409;
        throw error;
      }

      const now = ahoraLocal();
      const created = await tx.run(`
        INSERT INTO sesiones_caja (
          estado, cajero_apertura, fecha_apertura, saldo_inicial,
          observaciones_apertura, created_at, updated_at
        ) VALUES ('abierta', ?, ?, ?, ?, ?, ?)
      `, [
        req.user.usuario,
        now,
        saldoInicial || 0,
        observaciones,
        now,
        now,
      ]);

      return tx.get(`SELECT * FROM sesiones_caja WHERE id = ?`, [created.lastID]);
    });

    res.status(201).json({ ok: true, sesion });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_caja_pago = async (req, res) => {
  try {
    const { folio, monto, metodo, referencia } = req.body;
    const METODOS = ['efectivo', 'tarjeta', 'transferencia'];
    const montoNumSeguro = parsePositiveMoney(monto);

    if (!folio) return res.status(400).json({ error: 'Folio requerido' });
    if (!montoNumSeguro) return res.status(400).json({ error: 'Monto invalido' });
    if (!METODOS.includes(metodo)) return res.status(400).json({ error: 'Metodo de pago invalido' });

    const resultadoSeguro = await registrarPagoSeguro({
      folio,
      monto: montoNumSeguro,
      metodo,
      referencia,
      cajero: req.user.usuario,
    });

    res.status(201).json(resultadoSeguro);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_caja_historial = async (req, res) => {
  try {
    const fecha = req.query.fecha || ahoraLocal().split(' ')[0];
    const sesion = await getSesionCajaActiva();

    if (!sesion) {
      return res.json({
        fecha,
        sesion_activa: null,
        pagos: [],
        totales: {
          total_general: 0,
          total_efectivo: 0,
          total_tarjeta: 0,
          total_transferencia: 0,
          num_pagos: 0,
        },
        desde_corte: null,
      });
    }

    const pagos = await all(`
      SELECT p.*, pac.nombre AS paciente_nombre
      FROM pagos p
      JOIN ordenes o ON o.id = p.orden_id
      JOIN pacientes pac ON pac.id = o.paciente_id
      WHERE p.sesion_caja_id = ?
      ORDER BY p.id DESC
    `, [sesion.id]);

    const totales = await get(`
      SELECT
        COALESCE(SUM(monto), 0)                                           AS total_general,
        COALESCE(SUM(CASE WHEN metodo='efectivo'      THEN monto END), 0) AS total_efectivo,
        COALESCE(SUM(CASE WHEN metodo='tarjeta'       THEN monto END), 0) AS total_tarjeta,
        COALESCE(SUM(CASE WHEN metodo='transferencia' THEN monto END), 0) AS total_transferencia,
        COUNT(*) AS num_pagos
      FROM pagos
      WHERE sesion_caja_id = ?
    `, [sesion.id]);

    res.json({
      fecha,
      sesion_activa: sesion,
      pagos,
      totales,
      desde_corte: sesion.fecha_apertura,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_caja_corte = async (req, res) => {
  try {
    const { observaciones } = req.body || {};

    const payload = await withTransaction(async (tx) => {
      const sesion = await requireSesionCajaActiva(tx);

      const totales = await tx.get(`
        SELECT
          COALESCE(SUM(monto), 0)                                           AS total_general,
          COALESCE(SUM(CASE WHEN metodo='efectivo'      THEN monto END), 0) AS total_efectivo,
          COALESCE(SUM(CASE WHEN metodo='tarjeta'       THEN monto END), 0) AS total_tarjeta,
          COALESCE(SUM(CASE WHEN metodo='transferencia' THEN monto END), 0) AS total_transferencia,
          COUNT(*) AS num_pagos
        FROM pagos
        WHERE sesion_caja_id = ?
      `, [sesion.id]);

      if (Number(totales?.num_pagos || 0) === 0) {
        const error = new Error('No hay pagos registrados en la sesion activa. La caja esta en ceros.');
        error.status = 400;
        throw error;
      }

      const fechaFin = ahoraLocal();
      const saldoCierre = Math.round((Number(sesion.saldo_inicial || 0) + Number(totales.total_efectivo || 0)) * 100) / 100;

      const corteResult = await tx.run(`
        INSERT INTO cortes
          (cajero, fecha_inicio, fecha_fin, total_efectivo, total_tarjeta,
           total_transferencia, total_general, num_pagos, observaciones, sesion_caja_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        req.user.usuario,
        sesion.fecha_apertura,
        fechaFin,
        totales.total_efectivo,
        totales.total_tarjeta,
        totales.total_transferencia,
        totales.total_general,
        totales.num_pagos,
        observaciones || null,
        sesion.id,
      ]);

      await tx.run(`
        UPDATE sesiones_caja
        SET estado = 'cerrada',
            cajero_cierre = ?,
            fecha_cierre = ?,
            saldo_cierre = ?,
            observaciones_cierre = ?,
            updated_at = ?
        WHERE id = ?
      `, [
        req.user.usuario,
        fechaFin,
        saldoCierre,
        observaciones || null,
        fechaFin,
        sesion.id,
      ]);

      const corte = await tx.get(`SELECT * FROM cortes WHERE id = ?`, [corteResult.lastID]);
      const pagos = await tx.all(`
        SELECT p.*, pac.nombre AS paciente_nombre
        FROM pagos p
        JOIN ordenes o ON o.id = p.orden_id
        JOIN pacientes pac ON pac.id = o.paciente_id
        WHERE p.sesion_caja_id = ?
        ORDER BY p.id ASC
      `, [sesion.id]);

      return {
        corte,
        sesion: await tx.get(`SELECT * FROM sesiones_caja WHERE id = ?`, [sesion.id]),
        totales,
        pagos,
      };
    });

    const empresa = await get(`SELECT * FROM empresa WHERE id = 1`);

    res.status(201).json({
      ok: true,
      corte_id: payload.corte.id,
      fecha: payload.corte.fecha_fin?.split(' ')[0] || ahoraLocal().split(' ')[0],
      cajero: payload.corte.cajero,
      totales: payload.totales,
      pagos: payload.pagos,
      empresa,
      corte: payload.corte,
      sesion: payload.sesion,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_caja_cortes = async (req, res) => {
  try {
    const { desde, hasta, limit: lim } = req.query;
    const limit = Math.min(parseInt(lim) || 60, 200);

    let sql = `
      SELECT c.*,
             s.cajero_apertura,
             s.cajero_cierre,
             s.fecha_apertura,
             s.fecha_cierre,
             s.saldo_inicial,
             s.saldo_cierre
      FROM cortes c
      LEFT JOIN sesiones_caja s ON s.id = c.sesion_caja_id
      WHERE 1=1
    `;
    const params = [];

    if (desde) { sql += ` AND substr(c.fecha_fin, 1, 10) >= ?`; params.push(desde); }
    if (hasta) { sql += ` AND substr(c.fecha_fin, 1, 10) <= ?`; params.push(hasta); }

    sql += ` ORDER BY c.id DESC LIMIT ?`;
    params.push(limit);

    const cortes = await all(sql, params);
    res.json(cortes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_caja_cortes_by_id = async (req, res) => {
  try {
    const corte = await get(`SELECT * FROM cortes WHERE id = ?`, [req.params.id]);
    if (!corte) return res.status(404).json({ error: 'Corte no encontrado' });

    const pagos = corte.sesion_caja_id
      ? await all(`
          SELECT p.*, pac.nombre AS paciente_nombre
          FROM pagos p
          JOIN ordenes o  ON o.id  = p.orden_id
          JOIN pacientes pac ON pac.id = o.paciente_id
          WHERE p.sesion_caja_id = ?
          ORDER BY p.id ASC
        `, [corte.sesion_caja_id])
      : await all(`
          SELECT p.*, pac.nombre AS paciente_nombre
          FROM pagos p
          JOIN ordenes o  ON o.id  = p.orden_id
          JOIN pacientes pac ON pac.id = o.paciente_id
          WHERE p.fecha >  ?
            AND p.fecha <= ?
          ORDER BY p.id ASC
        `, [corte.fecha_inicio, corte.fecha_fin]);

    const empresa = await get(`SELECT * FROM empresa WHERE id = 1`);
    const sesion = corte.sesion_caja_id
      ? await get(`SELECT * FROM sesiones_caja WHERE id = ?`, [corte.sesion_caja_id])
      : null;

    res.json({ corte, pagos, empresa, sesion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_caja_comparativa = async (req, res) => {
  try {
    const dias = Math.min(parseInt(req.query.dias) || 30, 90);

    // Calcular fecha de inicio en hora local (no UTC)
    const hoy       = new Date(ahoraLocal());
    const inicio    = new Date(hoy);
    inicio.setDate(inicio.getDate() - dias);
    const pad       = n => String(n).padStart(2, '0');
    const fechaIni  = `${inicio.getFullYear()}-${pad(inicio.getMonth()+1)}-${pad(inicio.getDate())}`;

    const rows = await all(`
      SELECT
        substr(fecha_fin, 1, 10)         AS fecha,
        SUM(total_general)               AS total_general,
        SUM(total_efectivo)              AS total_efectivo,
        SUM(total_tarjeta)               AS total_tarjeta,
        SUM(total_transferencia)         AS total_transferencia,
        SUM(num_pagos)                   AS num_pagos,
        COUNT(*)                         AS num_cortes
      FROM cortes
      WHERE substr(fecha_fin, 1, 10) >= ?
      GROUP BY substr(fecha_fin, 1, 10)
      ORDER BY fecha ASC
    `, [fechaIni]);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  get_caja_orden_by_folio,
  get_caja_sesion_activa,
  post_caja_sesion_abrir,
  post_caja_pago,
  get_caja_historial,
  post_caja_corte,
  get_caja_cortes,
  get_caja_cortes_by_id,
  get_caja_comparativa,
};
