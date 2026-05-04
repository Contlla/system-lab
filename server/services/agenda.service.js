require('dotenv').config();

const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcrypt');
const multer   = require('multer');
const crypto   = require('crypto');

const { run, get, all, withTransaction } = require('../db');
const authMiddleware    = require('../middlewares/authMiddleware');
const { crearOrdenDesdeCitaSegura } = require('./ordenService');
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

const SUCURSALES_VALIDAS = ['CDC', 'NTE', 'SUR'];
const HORARIO_INICIO = '07:00';
const HORARIO_FIN = '20:00';
const ESTADOS_CITA = ['programada', 'confirmada', 'en_curso', 'completada', 'cancelada', 'no_asistio'];

function hhmm(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return NaN;
  return hours * 60 + minutes;
}

function solapan(inicioA, finA, inicioB, finB) {
  return hhmm(inicioA) < hhmm(finB) && hhmm(finA) > hhmm(inicioB);
}

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

function parseAgendaStudyIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const ids = [];
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function loadAgendaStudies(ids, executor = { all }) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await executor.all(
    `SELECT id, nombre, precio, categoria
     FROM estudios
     WHERE id IN (${placeholders})`,
    ids
  );
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    const error = new Error(`Estudio no encontrado: ${missing[0]}`);
    error.status = 400;
    throw error;
  }
  return ids.map((id) => byId.get(id));
}

function serializeAgendaStudyIds(studies = []) {
  return JSON.stringify(studies.map((study) => Number(study.id)));
}

function serializeAgendaStudyNames(studies = []) {
  return studies.map((study) => study.nombre).join(', ');
}

async function syncCitaEstudios(citaId, studies, executor = { run }) {
  await executor.run(`DELETE FROM cita_estudios WHERE cita_id = ?`, [citaId]);
  for (const study of studies) {
    await executor.run(
      `INSERT INTO cita_estudios (cita_id, estudio_id, nombre, precio, categoria)
       VALUES (?, ?, ?, ?, ?)`,
      [citaId, study.id, study.nombre, Number(study.precio || 0), study.categoria || null]
    );
  }
}

async function hydrateCitasWithStudies(citas = [], executor = { all }) {
  if (!citas.length) return citas;
  const ids = citas.map((cita) => Number(cita.id)).filter(Boolean);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await executor.all(
    `SELECT cita_id, estudio_id AS id, nombre, precio, categoria
     FROM cita_estudios
     WHERE cita_id IN (${placeholders})
     ORDER BY id ASC`,
    ids
  );
  const byCita = new Map();
  rows.forEach((row) => {
    const list = byCita.get(Number(row.cita_id)) || [];
    list.push({
      id: Number(row.id),
      nombre: row.nombre,
      precio: Number(row.precio || 0),
      categoria: row.categoria || null,
    });
    byCita.set(Number(row.cita_id), list);
  });
  return citas.map((cita) => {
    const estudios = byCita.get(Number(cita.id)) || [];
    if (!estudios.length) return cita;
    return {
      ...cita,
      estudios,
      estudios_ids: serializeAgendaStudyIds(estudios),
      estudios_nombres: serializeAgendaStudyNames(estudios),
    };
  });
}

function validateAgendaCitaPayload(body = {}, existing = null) {
  const sucursal = body.sucursal || existing?.sucursal;
  const tecnicoId = body.tecnico_id ? Number(body.tecnico_id) : null;
  const pacienteId = body.paciente_id ? Number(body.paciente_id) : null;
  const pacienteNombre = String(body.paciente_nombre || '').trim();
  const pacienteCelular = String(body.paciente_celular || '').trim() || null;
  const fecha = String(body.fecha || '').trim();
  const horaInicio = String(body.hora_inicio || '').trim();
  const horaFin = String(body.hora_fin || '').trim();
  const duracionMin = Number(body.duracion_min) || (hhmm(horaFin) - hhmm(horaInicio));
  const notas = String(body.notas || '').trim() || null;
  const estudiosIds = parseAgendaStudyIds(body.estudios_ids);

  if (!sucursal || !SUCURSALES_VALIDAS.includes(sucursal)) {
    return { error: 'Sucursal invalida' };
  }
  if (!pacienteNombre) return { error: 'Nombre del paciente requerido' };
  if (!fecha || !horaInicio || !horaFin) return { error: 'Fecha y horario requeridos' };
  if (hhmm(horaInicio) >= hhmm(horaFin)) return { error: 'Horario invalido: inicio debe ser antes del fin' };
  if (hhmm(horaInicio) < hhmm(HORARIO_INICIO) || hhmm(horaFin) > hhmm(HORARIO_FIN)) {
    return { error: `Horario fuera del rango permitido (${HORARIO_INICIO}-${HORARIO_FIN})` };
  }
  if (!Number.isInteger(duracionMin) || duracionMin < 15 || duracionMin > 480) {
    return { error: 'Duracion invalida' };
  }

  return {
    sucursal,
    tecnicoId: Number.isInteger(tecnicoId) && tecnicoId > 0 ? tecnicoId : null,
    pacienteId: Number.isInteger(pacienteId) && pacienteId > 0 ? pacienteId : null,
    pacienteNombre,
    pacienteCelular,
    fecha,
    horaInicio,
    horaFin,
    duracionMin,
    notas,
    estudiosIds,
  };
}

async function assertAgendaSlotDisponible({ fecha, sucursal, tecnicoId, horaInicio, horaFin, excludeCitaId = null }, executor = { all }) {
  let dupSql = `SELECT id, paciente_nombre, hora_inicio, hora_fin FROM citas
                WHERE fecha = ? AND sucursal = ? AND estado NOT IN ('cancelada','no_asistio')`;
  const dupParams = [fecha, sucursal];
  if (excludeCitaId) {
    dupSql += ` AND id != ?`;
    dupParams.push(Number(excludeCitaId));
  }
  if (tecnicoId) {
    dupSql += ` AND tecnico_id = ?`;
    dupParams.push(tecnicoId);
  }
  const existentes = await executor.all(dupSql, dupParams);
  const conflicto = existentes.find((cita) => solapan(horaInicio, horaFin, cita.hora_inicio, cita.hora_fin));
  if (conflicto) {
    const error = new Error(`Horario ocupado: "${conflicto.paciente_nombre}" ya tiene cita de ${conflicto.hora_inicio} a ${conflicto.hora_fin}`);
    error.status = 409;
    throw error;
  }

  let blqSql = `SELECT motivo, hora_inicio, hora_fin FROM agenda_bloqueos
                WHERE fecha = ? AND sucursal = ?`;
  const blqParams = [fecha, sucursal];
  if (tecnicoId) {
    blqSql += ` AND (tecnico_id IS NULL OR tecnico_id = ?)`;
    blqParams.push(tecnicoId);
  }
  const bloqueos = await executor.all(blqSql, blqParams);
  const bloqueo = bloqueos.find((item) => solapan(horaInicio, horaFin, item.hora_inicio, item.hora_fin));
  if (bloqueo) {
    const error = new Error(`Horario bloqueado: "${bloqueo.motivo || 'sin motivo'}" (${bloqueo.hora_inicio}-${bloqueo.hora_fin})`);
    error.status = 409;
    throw error;
  }
}

async function calcularDisponibilidadAgenda({ fecha, sucursal, tecnicoId, duracion, excludeCitaId = null }, executor = { all }) {
  const dur = Math.max(15, Math.min(480, Number(duracion || 30)));
  let citasSql = `SELECT hora_inicio, hora_fin FROM citas
                  WHERE fecha = ? AND sucursal = ? AND estado NOT IN ('cancelada','no_asistio')`;
  const citasParams = [fecha, sucursal];
  if (excludeCitaId) {
    citasSql += ` AND id != ?`;
    citasParams.push(Number(excludeCitaId));
  }
  if (tecnicoId) {
    citasSql += ` AND tecnico_id = ?`;
    citasParams.push(tecnicoId);
  }
  const citasOcupadas = await executor.all(citasSql, citasParams);

  let blqSql = `SELECT hora_inicio, hora_fin FROM agenda_bloqueos WHERE fecha = ? AND sucursal = ?`;
  const blqParams = [fecha, sucursal];
  if (tecnicoId) {
    blqSql += ` AND (tecnico_id IS NULL OR tecnico_id = ?)`;
    blqParams.push(tecnicoId);
  }
  const bloqueos = await executor.all(blqSql, blqParams);
  const ocupados = [...citasOcupadas, ...bloqueos];

  const slots = [];
  let cur = hhmm(HORARIO_INICIO);
  const limite = hhmm(HORARIO_FIN) - dur;
  while (cur <= limite) {
    const hIni = String(Math.floor(cur / 60)).padStart(2, '0') + ':' + String(cur % 60).padStart(2, '0');
    const finMin = cur + dur;
    const hFin = String(Math.floor(finMin / 60)).padStart(2, '0') + ':' + String(finMin % 60).padStart(2, '0');
    slots.push({
      hora_inicio: hIni,
      hora_fin: hFin,
      libre: !ocupados.some((item) => solapan(hIni, hFin, item.hora_inicio, item.hora_fin)),
    });
    cur += 15;
  }
  return slots;
}

async function listarCitasAgenda(filters, executor = { all }) {
  const { fecha, fecha_fin, sucursal, tecnico_id, estado } = filters;
  let sql = `
    SELECT c.*, t.nombre AS tecnico_nombre
    FROM citas c
    LEFT JOIN tecnicos t ON t.id = c.tecnico_id
    WHERE c.fecha >= ?`;
  const params = [fecha];
  if (fecha_fin) { sql += ` AND c.fecha <= ?`; params.push(fecha_fin); }
  else { sql += ` AND c.fecha = ?`; params.push(fecha); }
  if (sucursal) { sql += ` AND c.sucursal = ?`; params.push(sucursal); }
  if (tecnico_id) { sql += ` AND c.tecnico_id = ?`; params.push(tecnico_id); }
  if (estado) { sql += ` AND c.estado = ?`; params.push(estado); }
  sql += ` ORDER BY c.hora_inicio ASC`;
  return hydrateCitasWithStudies(await executor.all(sql, params), executor);
}

async function crearCitaAgenda(body, usuario) {
  const payload = validateAgendaCitaPayload(body);
  if (payload.error) {
    const error = new Error(payload.error);
    error.status = 400;
    throw error;
  }

  return withTransaction(async (tx) => {
    await assertAgendaSlotDisponible(payload, tx);
    const studies = await loadAgendaStudies(payload.estudiosIds, tx);
    const eIds = serializeAgendaStudyIds(studies);
    const eNom = serializeAgendaStudyNames(studies);
    const created = await tx.run(`
      INSERT INTO citas
        (sucursal, tecnico_id, paciente_id, paciente_nombre, paciente_celular,
         fecha, hora_inicio, hora_fin, duracion_min, estudios_ids, estudios_nombres,
         estado, notas, creado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'programada', ?, ?)
    `, [
      payload.sucursal,
      payload.tecnicoId,
      payload.pacienteId,
      payload.pacienteNombre,
      payload.pacienteCelular,
      payload.fecha,
      payload.horaInicio,
      payload.horaFin,
      payload.duracionMin,
      eIds,
      eNom,
      payload.notas,
      usuario,
    ]);
    await syncCitaEstudios(created.lastID, studies, tx);
    const citas = await listarCitasAgenda({ fecha: payload.fecha, fecha_fin: payload.fecha, sucursal: payload.sucursal }, tx);
    return citas.find((cita) => Number(cita.id) === Number(created.lastID));
  });
}

async function actualizarCitaAgenda(id, body) {
  const citaExistente = await get(`SELECT * FROM citas WHERE id = ?`, [id]);
  if (!citaExistente) {
    const error = new Error('Cita no encontrada');
    error.status = 404;
    throw error;
  }
  if (citaExistente.orden_id) {
    const error = new Error('No se puede editar una cita que ya tiene orden vinculada');
    error.status = 409;
    throw error;
  }
  const payload = validateAgendaCitaPayload(body, citaExistente);
  if (payload.error) {
    const error = new Error(payload.error);
    error.status = 400;
    throw error;
  }

  return withTransaction(async (tx) => {
    await assertAgendaSlotDisponible({ ...payload, excludeCitaId: id }, tx);
    const studies = await loadAgendaStudies(payload.estudiosIds, tx);
    const eIds = serializeAgendaStudyIds(studies);
    const eNom = serializeAgendaStudyNames(studies);
    await tx.run(`
      UPDATE citas SET
        sucursal=?, tecnico_id=?, paciente_id=?, paciente_nombre=?,
        paciente_celular=?, fecha=?, hora_inicio=?, hora_fin=?,
        duracion_min=?, estudios_ids=?, estudios_nombres=?, notas=?
      WHERE id=?
    `, [
      payload.sucursal,
      payload.tecnicoId,
      payload.pacienteId,
      payload.pacienteNombre,
      payload.pacienteCelular,
      payload.fecha,
      payload.horaInicio,
      payload.horaFin,
      payload.duracionMin,
      eIds,
      eNom,
      payload.notas,
      id,
    ]);
    await syncCitaEstudios(id, studies, tx);
    const citas = await listarCitasAgenda({ fecha: payload.fecha, fecha_fin: payload.fecha, sucursal: payload.sucursal }, tx);
    return citas.find((cita) => Number(cita.id) === Number(id));
  });
}

const get_agenda_tecnicos = async (req, res) => {
  try {
    const { sucursal } = req.query;
    const rows = sucursal
      ? await all(`SELECT * FROM tecnicos WHERE sucursal = ? AND activo = 1 ORDER BY nombre`, [sucursal])
      : await all(`SELECT * FROM tecnicos WHERE activo = 1 ORDER BY sucursal, nombre`);
    res.json(rows);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const post_agenda_tecnicos = async (req, res) => {
  try {
    const { nombre, sucursal } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    if (!SUCURSALES_VALIDAS.includes(sucursal)) return res.status(400).json({ error: 'Sucursal invÃ¡lida' });
    const r = await run(`INSERT INTO tecnicos (nombre, sucursal) VALUES (?, ?)`, [nombre.trim(), sucursal]);
    const tecnico = await get(`SELECT * FROM tecnicos WHERE id = ?`, [r.lastID]);
    res.status(201).json(tecnico);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const delete_agenda_tecnicos_by_id = async (req, res) => {
  try {
    await run(`UPDATE tecnicos SET activo = 0 WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const get_agenda_disponibilidad = async (req, res) => {
  try {
    const { fecha, sucursal, tecnico_id, duracion = 30, exclude_cita_id } = req.query;
    if (!fecha || !sucursal) return res.status(400).json({ error: 'fecha y sucursal requeridos' });

    res.json(await calcularDisponibilidadAgenda({
      fecha,
      sucursal,
      tecnicoId: tecnico_id ? Number(tecnico_id) : null,
      duracion,
      excludeCitaId: exclude_cita_id ? Number(exclude_cita_id) : null,
    }));
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const get_agenda_citas = async (req, res) => {
  try {
    const { fecha, fecha_fin, sucursal, tecnico_id, estado } = req.query;
    if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
    res.json(await listarCitasAgenda({ fecha, fecha_fin, sucursal, tecnico_id, estado }));
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const post_agenda_citas = async (req, res) => {
  try {
    res.status(201).json(await crearCitaAgenda(req.body, req.user.usuario));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const patch_agenda_citas_by_id_estado = async (req, res) => {
  try {
    const { estado } = req.body;
    if (!ESTADOS_CITA.includes(estado)) return res.status(400).json({ error: 'Estado invÃ¡lido' });
    const cita = await get(`SELECT * FROM citas WHERE id = ?`, [req.params.id]);
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    await run(`UPDATE citas SET estado = ? WHERE id = ?`, [estado, req.params.id]);
    res.json({ ok: true, id: Number(req.params.id), estado });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const put_agenda_citas_by_id = async (req, res) => {
  try {
    const id = Number(req.params.id);
    res.json(await actualizarCitaAgenda(id, req.body));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const delete_agenda_citas_by_id = async (req, res) => {
  try {
    const cita = await get(`SELECT * FROM citas WHERE id = ?`, [req.params.id]);
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    await run(`UPDATE citas SET estado = 'cancelada' WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const post_agenda_citas_by_id_orden = async (req, res) => {
  try {
    const cita = await get(`SELECT * FROM citas WHERE id = ?`, [req.params.id]);
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    if (cita.orden_id) return res.status(409).json({ error: 'Esta cita ya tiene una orden vinculada', orden_folio: cita.orden_folio });

    const { sucursal, medico } = req.body;
    const [citaHydratada] = await hydrateCitasWithStudies([cita]);
    const resultado = await crearOrdenDesdeCitaSegura(citaHydratada, { sucursal, medico });
    return res.status(201).json(resultado);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const get_agenda_bloqueos = async (req, res) => {
  try {
    const { fecha, sucursal } = req.query;
    if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
    let sql = `SELECT b.*, t.nombre AS tecnico_nombre FROM agenda_bloqueos b LEFT JOIN tecnicos t ON t.id = b.tecnico_id WHERE b.fecha = ?`;
    const params = [fecha];
    if (sucursal) { sql += ` AND b.sucursal = ?`; params.push(sucursal); }
    sql += ` ORDER BY b.hora_inicio`;
    res.json(await all(sql, params));
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const post_agenda_bloqueos = async (req, res) => {
  try {
    const { sucursal, tecnico_id, fecha, hora_inicio, hora_fin, motivo } = req.body;
    if (!sucursal || !fecha || !hora_inicio || !hora_fin)
      return res.status(400).json({ error: 'sucursal, fecha, hora_inicio y hora_fin son requeridos' });
    if (hhmm(hora_inicio) >= hhmm(hora_fin))
      return res.status(400).json({ error: 'Horario invÃ¡lido' });
    const r = await run(
      `INSERT INTO agenda_bloqueos (sucursal, tecnico_id, fecha, hora_inicio, hora_fin, motivo) VALUES (?, ?, ?, ?, ?, ?)`,
      [sucursal, tecnico_id || null, fecha, hora_inicio, hora_fin, motivo || null]
    );
    res.status(201).json(await get(`SELECT * FROM agenda_bloqueos WHERE id = ?`, [r.lastID]));
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const delete_agenda_bloqueos_by_id = async (req, res) => {
  try {
    await run(`DELETE FROM agenda_bloqueos WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

module.exports = {
  get_agenda_tecnicos,
  post_agenda_tecnicos,
  delete_agenda_tecnicos_by_id,
  get_agenda_disponibilidad,
  get_agenda_citas,
  post_agenda_citas,
  patch_agenda_citas_by_id_estado,
  put_agenda_citas_by_id,
  delete_agenda_citas_by_id,
  post_agenda_citas_by_id_orden,
  get_agenda_bloqueos,
  post_agenda_bloqueos,
  delete_agenda_bloqueos_by_id,
};
