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


const get_estudios = async (req, res) => {
  try {
    const estudios = await all('SELECT * FROM estudios ORDER BY categoria, nombre');
    res.json(estudios);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_estudios = async (req, res) => {
  try {
    const {
      clave_externa,
      nombre,
      nombre_corto,
      precio,
      categoria,
      subcategoria,
      sinonimos_busqueda,
      indicaciones,
      tipo_muestra,
      tipo_tubo,
      color_tapa,
      tubos_requeridos,
      area_proceso,
      comparte_tubo
    } = req.body;
    const categoriaNormalizada = normalizarCategoria(categoria);
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    if (precio === undefined || Number(precio) < 0) return res.status(400).json({ error: 'Precio invÃ¡lido' });
    if (!categoriaNormalizada) return res.status(400).json({ error: `CategorÃ­a invÃ¡lida. VÃ¡lidas: ${CATEGORIAS_VALIDAS.join(', ')}` });
    if (tubos_requeridos !== undefined && Number(tubos_requeridos) < 1) return res.status(400).json({ error: 'Cantidad de tubos invÃ¡lida' });

    const result = await run(
      `INSERT INTO estudios (
        clave_externa, nombre, nombre_corto, precio, categoria, subcategoria, sinonimos_busqueda, indicaciones,
        tipo_muestra, tipo_tubo, color_tapa, tubos_requeridos, area_proceso, comparte_tubo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clave_externa?.trim() || null,
        nombre.trim(),
        nombre_corto?.trim() || null,
        Number(precio),
        categoriaNormalizada,
        subcategoria?.trim() || null,
        sinonimos_busqueda?.trim() || null,
        indicaciones?.trim() || null,
        tipo_muestra?.trim() || null,
        tipo_tubo?.trim() || null,
        color_tapa?.trim() || null,
        Math.max(1, Number(tubos_requeridos || 1)),
        area_proceso?.trim() || null,
        comparte_tubo ? 1 : 0
      ]
    );
    const estudio = await get(`SELECT * FROM estudios WHERE id = ?`, [result.lastID]);
    res.status(201).json(estudio);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Ya existe un estudio con ese nombre' });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const put_estudios_by_id = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      clave_externa,
      nombre,
      nombre_corto,
      precio,
      categoria,
      subcategoria,
      sinonimos_busqueda,
      indicaciones,
      tipo_muestra,
      tipo_tubo,
      color_tapa,
      tubos_requeridos,
      area_proceso,
      comparte_tubo
    } = req.body;
    const categoriaNormalizada = normalizarCategoria(categoria);
    if (!nombre || !nombre.trim())               return res.status(400).json({ error: 'Nombre requerido' });
    if (precio === undefined || Number(precio) < 0) return res.status(400).json({ error: 'Precio invÃ¡lido' });
    if (!categoriaNormalizada) return res.status(400).json({ error: `CategorÃ­a invÃ¡lida. VÃ¡lidas: ${CATEGORIAS_VALIDAS.join(', ')}` });
    if (tubos_requeridos !== undefined && Number(tubos_requeridos) < 1) return res.status(400).json({ error: 'Cantidad de tubos invÃ¡lida' });

    const existe = await get(`SELECT id FROM estudios WHERE id = ?`, [id]);
    if (!existe) return res.status(404).json({ error: 'Estudio no encontrado' });

    await run(
      `UPDATE estudios
       SET clave_externa = ?, nombre = ?, nombre_corto = ?, precio = ?, categoria = ?, subcategoria = ?, sinonimos_busqueda = ?, indicaciones = ?,
           tipo_muestra = ?, tipo_tubo = ?, color_tapa = ?, tubos_requeridos = ?,
           area_proceso = ?, comparte_tubo = ?
       WHERE id = ?`,
      [
        clave_externa?.trim() || null,
        nombre.trim(),
        nombre_corto?.trim() || null,
        Number(precio),
        categoriaNormalizada,
        subcategoria?.trim() || null,
        sinonimos_busqueda?.trim() || null,
        indicaciones?.trim() || null,
        tipo_muestra?.trim() || null,
        tipo_tubo?.trim() || null,
        color_tapa?.trim() || null,
        Math.max(1, Number(tubos_requeridos || 1)),
        area_proceso?.trim() || null,
        comparte_tubo ? 1 : 0,
        id
      ]
    );
    const estudio = await get(`SELECT * FROM estudios WHERE id = ?`, [id]);
    res.json(estudio);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Ya existe un estudio con ese nombre' });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const delete_estudios_by_id = async (req, res) => {
  try {
    const { id } = req.params;
    const estudio = await get(`SELECT * FROM estudios WHERE id = ?`, [id]);
    if (!estudio) return res.status(404).json({ error: 'Estudio no encontrado' });

    const enUso = await get(`SELECT COUNT(*) as total FROM orden_estudios WHERE estudio_id = ?`, [id]);
    if (enUso.total > 0) {
      return res.status(409).json({
        error: `No se puede eliminar "${estudio.nombre}" porque estÃ¡ en ${enUso.total} orden(es). Puedes cambiarle el nombre si ya no lo usas.`
      });
    }

    await run(`DELETE FROM estudios WHERE id = ?`, [id]);
    res.json({ ok: true, eliminado: estudio.nombre });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_orden = async (req, res) => {
  try {
    const { nombre, celular, fecha_nacimiento, sexo, sucursal, medico, medico_telefono, estudios } = req.body;
    const edad = calcularEdadDesdeFecha(fecha_nacimiento);

    if (!nombre || !fecha_nacimiento || !sexo || !sucursal) {
      return res.status(400).json({ error: 'Faltan campos requeridos: nombre, fecha_nacimiento, sexo, sucursal' });
    }
    if (edad === null) {
      return res.status(400).json({ error: 'Fecha de nacimiento invalida' });
    }
    if (!Array.isArray(estudios) || estudios.length === 0) {
      return res.status(400).json({ error: 'Debe seleccionar al menos un estudio' });
    }
    const resultado = await crearOrdenSegura({ nombre, celular, fecha_nacimiento, edad, sexo, sucursal, medico, medico_telefono, estudios });
    return res.status(201).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_orden_by_folio_etiquetas = async (req, res) => {
  try {
    const { folio } = req.params;
    const orden = await get(`
      SELECT
        o.id,
        o.folio,
        o.sucursal,
        o.fecha,
        p.id AS paciente_id,
        p.nombre AS paciente_nombre,
        p.fecha_nacimiento AS paciente_fecha_nacimiento,
        p.edad AS paciente_edad,
        p.sexo AS paciente_sexo
      FROM ordenes o
      JOIN pacientes p ON p.id = o.paciente_id
      WHERE o.folio = ?
    `, [folio]);

    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

    let etiquetas = await all(`
      SELECT *
      FROM orden_tubos
      WHERE orden_id = ?
      ORDER BY id ASC
    `, [orden.id]);

    if (!etiquetas.length) {
      etiquetas = await regenerarEtiquetasOrden(orden.id);
    }

    const empresa = await get(`SELECT * FROM empresa WHERE id = 1`);
    res.json({ orden, etiquetas, empresa: empresa || {} });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_orden_by_folio_etiquetas_registrar_impresion = async (req, res) => {
  try {
    const { folio } = req.params;
    const orden = await get(`SELECT id FROM ordenes WHERE folio = ?`, [folio]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

    await run(`
      UPDATE orden_tubos
      SET
        reimpresiones = CASE WHEN impreso = 1 THEN reimpresiones + 1 ELSE reimpresiones END,
        impreso = 1,
        impreso_en = ?
      WHERE orden_id = ?
    `, [ahoraLocal(), orden.id]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_orden_by_folio = async (req, res) => {
  try {
    const { folio } = req.params;
    if (!folio) return res.status(400).json({ error: 'Folio requerido' });

    const orden = await get(`
      SELECT o.*, p.nombre AS paciente_nombre,
             p.celular AS paciente_celular, p.fecha_nacimiento AS paciente_fecha_nacimiento, p.edad AS paciente_edad,
             p.sexo AS paciente_sexo, p.registro AS paciente_registro
      FROM ordenes o
      JOIN pacientes p ON p.id = o.paciente_id
      WHERE o.folio = ?
    `, [folio]);

    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

    const estudios = await all(`
      SELECT e.id, oe.id AS orden_estudio_id, oe.estudio_id, oe.precio, e.nombre, e.categoria, e.indicaciones
      FROM orden_estudios oe
      JOIN estudios e ON oe.estudio_id = e.id
      WHERE oe.orden_id = ?
    `, [orden.id]);

    res.json({ orden, estudios });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const patch_orden_by_folio_estado = async (req, res) => {
  try {
    const { folio }  = req.params;
    const { estado } = req.body;
    const VALIDOS    = ['pendiente', 'en_proceso', 'completado', 'cancelado'];
    if (!VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado invalido' });

    const orden = await get(`SELECT * FROM ordenes WHERE folio = ?`, [folio]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

    await run(`UPDATE ordenes SET estado = ? WHERE folio = ?`, [estado, folio]);
    const actualizada = await get(`SELECT * FROM ordenes WHERE folio = ?`, [folio]);
    res.json(actualizada);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_orden_by_folio_estudios = async (req, res) => {
  try {
    const { folio }    = req.params;
    const { estudios } = req.body;
    if (!Array.isArray(estudios) || estudios.length === 0) return res.status(400).json({ error: 'Debe enviar al menos un estudio' });

    const orden = await get(`SELECT * FROM ordenes WHERE folio = ?`, [folio]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (orden.estado === 'completado' || orden.estado === 'cancelado') return res.status(400).json({ error: 'No se pueden modificar estudios de una orden finalizada' });

    let extra = 0;
    for (const estudioId of estudios) {
      const estudio = await get(`SELECT * FROM estudios WHERE id = ?`, [estudioId]);
      if (!estudio) continue;
      const existe = await get(`SELECT id FROM orden_estudios WHERE orden_id = ? AND estudio_id = ?`, [orden.id, estudioId]);
      if (existe) continue;
      extra += estudio.precio;
      await run(`INSERT INTO orden_estudios (orden_id, estudio_id, precio) VALUES (?, ?, ?)`, [orden.id, estudioId, estudio.precio]);
    }

      const nuevoTotal = orden.total + extra;
      const nuevoSaldo = orden.saldo + extra;
      await run(`UPDATE ordenes SET total = ?, saldo = ? WHERE id = ?`, [nuevoTotal, nuevoSaldo, orden.id]);
      const etiquetas = await regenerarEtiquetasOrden(orden.id);
      res.json({ ok: true, extra, nuevoTotal, etiquetas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const delete_orden_by_folio_estudio_by_estudioId = async (req, res) => {
  try {
    const { folio, estudioId } = req.params;
    const orden = await get(`SELECT * FROM ordenes WHERE folio = ?`, [folio]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (orden.estado === 'completado' || orden.estado === 'cancelado') return res.status(400).json({ error: 'No se pueden modificar estudios de una orden finalizada' });

    const oe = await get(`SELECT * FROM orden_estudios WHERE orden_id = ? AND estudio_id = ?`, [orden.id, estudioId]);
    if (!oe) return res.status(404).json({ error: 'Estudio no encontrado en la orden' });

      await run(`DELETE FROM orden_estudios WHERE orden_id = ? AND estudio_id = ?`, [orden.id, estudioId]);
      const nuevoTotal = Math.max(0, orden.total - oe.precio);
      const nuevoSaldo = Math.max(0, orden.saldo - oe.precio);
      await run(`UPDATE ordenes SET total = ?, saldo = ? WHERE id = ?`, [nuevoTotal, nuevoSaldo, orden.id]);
      const etiquetas = await regenerarEtiquetasOrden(orden.id);
      res.json({ ok: true, nuevoTotal, etiquetas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_empresa = async (req, res) => {
  try {
    const empresa = await get(`SELECT * FROM empresa WHERE id = 1`);
    res.json(empresa || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const put_empresa = async (req, res) => {
  try {
    const payload = normalizeEmpresaPayload(req.body);
    const error = validarEmpresaPayload(payload);
    if (error) return res.status(400).json({ error });

    const actual = await get(`SELECT * FROM empresa WHERE id = 1`);
    if (!actual) return res.status(404).json({ error: 'No se encontro la configuracion de empresa' });
    if (!payload.version) {
      return res.status(409).json({
        error: 'La configuracion de empresa debe recargarse antes de guardar.',
        current: actual,
      });
    }
    if ((actual.updated_at || '') !== payload.version) {
      return res.status(409).json({
        error: 'Los datos de empresa fueron actualizados por otro usuario. Recarga la vista para continuar.',
        current: actual,
      });
    }

    await run(
      `UPDATE empresa
         SET nombre=?, direccion=?, ruc=?, rfc=?, telefono=?, correo=?, logo=?, updated_at=datetime('now')
       WHERE id=1`,
      [
        payload.nombre,
        payload.direccion || null,
        payload.ruc || null,
        payload.rfc || null,
        payload.telefono || null,
        payload.correo || null,
        payload.logo || null,
      ]
    );
    const updated = await get(`SELECT * FROM empresa WHERE id = 1`);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_ordenes_buscar = async (req, res) => {
  try {
    const q          = req.query.q          ? `%${req.query.q}%` : null;
    const estado     = req.query.estado     || null;
    const sucursal   = req.query.sucursal   || null;
    const fechaDesde = req.query.fecha_desde || null;
    const fechaHasta = req.query.fecha_hasta || null;
    const limit      = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset     = parseInt(req.query.offset) || 0;

    const ESTADOS_VALIDOS   = ['pendiente', 'en_proceso', 'completado', 'cancelado'];
    const SUCURSALES_VALIDAS = ['CDC', 'NTE', 'SUR'];

    let where  = '1=1';
    const params = [];

    if (q) {
      where += ` AND (p.nombre LIKE ? OR o.folio LIKE ? OR p.celular LIKE ? OR p.fecha_nacimiento LIKE ?)`;
      params.push(q, q, q, q);
    }
    if (estado && ESTADOS_VALIDOS.includes(estado)) {
      where += ` AND o.estado = ?`;
      params.push(estado);
    }
    if (sucursal && SUCURSALES_VALIDAS.includes(sucursal)) {
      where += ` AND o.sucursal = ?`;
      params.push(sucursal);
    }
    if (fechaDesde) {
      where += ` AND substr(o.fecha,1,10) >= ?`;
      params.push(fechaDesde);
    }
    if (fechaHasta) {
      where += ` AND substr(o.fecha,1,10) <= ?`;
      params.push(fechaHasta);
    }

    const countRow = await get(
      `SELECT COUNT(*) AS total FROM ordenes o JOIN pacientes p ON p.id = o.paciente_id WHERE ${where}`,
      params
    );

    const ordenes = await all(
      `SELECT o.id, o.folio, o.sucursal, o.estado, o.total, o.pagado, o.saldo, o.fecha, o.medico,
              p.nombre AS paciente_nombre, p.celular AS paciente_celular, p.fecha_nacimiento AS paciente_fecha_nacimiento,
              p.edad AS paciente_edad, p.sexo AS paciente_sexo
       FROM ordenes o JOIN pacientes p ON p.id = o.paciente_id
       WHERE ${where}
       ORDER BY o.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ total: countRow.total, ordenes, limit, offset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_dashboard = async (req, res) => {
  try {
    const hoyLocal       = ahoraLocal().split(' ')[0];
    const ordenesHoy     = await get(`SELECT COUNT(*) as total FROM ordenes WHERE substr(fecha,1,10) = ?`, [hoyLocal]);
    const ingresos       = await get(`SELECT COALESCE(SUM(monto),0) as total FROM pagos WHERE substr(fecha,1,10) = ?`, [hoyLocal]);
    const pacientes      = await get(`SELECT COUNT(*) as total FROM pacientes WHERE activo = 1`);
    const completadosHoy = await get(`SELECT COUNT(*) as total FROM ordenes WHERE estado='completado' AND substr(fecha,1,10) = ?`, [hoyLocal]);
    const saldoPorCobrar = await get(`SELECT COALESCE(SUM(saldo),0) as total FROM ordenes WHERE saldo > 0 AND estado NOT IN ('cancelado','completado')`);
    const ultimasOrdenes = await all(`
      SELECT o.folio, o.total, o.fecha, o.estado, p.nombre AS paciente_nombre
      FROM ordenes o JOIN pacientes p ON p.id = o.paciente_id
      ORDER BY o.id DESC LIMIT 8
    `);
    res.json({ ordenesHoy: ordenesHoy?.total??0, ingresos: ingresos?.total??0, pacientes: pacientes?.total??0, completadosHoy: completadosHoy?.total??0, saldoPorCobrar: saldoPorCobrar?.total??0, ultimasOrdenes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const get_pacientes = async (req, res) => {
  try {
    const buscarRaw = String(req.query.buscar || '').trim();
    const buscar = buscarRaw ? `%${buscarRaw}%` : '%';
    const limit  = Math.min(parseInt(req.query.limit)||10, 100);
    const offset = parseInt(req.query.offset)||0;
    const where = `
      activo = 1 AND (
        nombre LIKE ? OR registro LIKE ? OR celular LIKE ? OR
        correo LIKE ? OR fecha_nacimiento LIKE ?
      )
    `;
    const params = [buscar, buscar, buscar, buscar, buscar];
    const total = await get(`SELECT COUNT(*) as total FROM pacientes WHERE ${where}`, params);
    const pacientes = await all(`
      SELECT p.id, p.registro, p.nombre, p.celular, p.correo, p.direccion, p.observaciones,
             p.fecha_nacimiento, p.edad, p.sexo, p.activo, p.created_at, p.updated_at,
             (SELECT COUNT(*) FROM ordenes o WHERE o.paciente_id = p.id) AS ordenes_total,
             (SELECT COUNT(*) FROM ordenes o WHERE o.paciente_id = p.id AND o.saldo > 0) AS ordenes_adeudo,
             (SELECT MAX(fecha) FROM ordenes o WHERE o.paciente_id = p.id) AS ultima_visita
      FROM pacientes p
      WHERE ${where}
      ORDER BY p.id DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    res.json({ pacientes, total: total.total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const post_pacientes = async (req, res) => {
  try {
    const { registro, nombre, celular, correo, direccion, observaciones, fecha_nacimiento, edad, sexo } = req.body;
    const edadCalculada = fecha_nacimiento ? calcularEdadDesdeFecha(fecha_nacimiento) : Number(edad);
    if (!nombre || !nombre.trim() || edadCalculada === null || Number.isNaN(edadCalculada) || !sexo) return res.status(400).json({ error: 'Nombre, fecha de nacimiento/edad y sexo son requeridos' });
    if (fecha_nacimiento && calcularEdadDesdeFecha(fecha_nacimiento) === null) return res.status(400).json({ error: 'Fecha de nacimiento invalida' });
    if (!['M', 'F', 'O'].includes(sexo)) return res.status(400).json({ error: 'Sexo invalido' });
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ error: 'Correo invalido' });
    const duplicado = await get(`
      SELECT id, nombre FROM pacientes
      WHERE activo = 1 AND UPPER(TRIM(nombre)) = UPPER(TRIM(?))
        AND COALESCE(fecha_nacimiento, '') = COALESCE(?, '')
      LIMIT 1
    `, [nombre, fecha_nacimiento || null]);
    if (duplicado) return res.status(409).json({ error: 'Ya existe un paciente con el mismo nombre y fecha de nacimiento', duplicado });
    const now = ahoraLocal();
    let registroFinal = normalizarRegistroPaciente(registro);
    if (registroFinal) {
      const registroEnUso = await get(`SELECT id FROM pacientes WHERE registro = ? LIMIT 1`, [registroFinal]);
      if (registroEnUso) registroFinal = '';
    }
    if (!registroFinal) registroFinal = await generarRegistroPaciente();
    const result  = await run(`
      INSERT INTO pacientes (registro,nombre,celular,correo,direccion,observaciones,fecha_nacimiento,edad,sexo,activo,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?)
    `, [registroFinal,nombre.trim(),celular||null,correo||null,direccion||null,observaciones||null,fecha_nacimiento||null,edadCalculada,sexo,now,now]);
    const paciente = await get(`
      SELECT id, registro, nombre, celular, correo, direccion, observaciones, fecha_nacimiento, edad, sexo, activo, created_at, updated_at
      FROM pacientes WHERE id = ?
    `, [result.lastID]);
    res.status(201).json(paciente);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'El nÃºmero de registro ya existe' });
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const get_pacientes_siguiente_registro = async (_req, res) => {
  try {
    const registro = await generarRegistroPaciente();
    res.json({ registro });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const put_pacientes_by_id = async (req, res) => {
  try {
    const { id } = req.params;
    const { registro, nombre, celular, correo, direccion, observaciones, fecha_nacimiento, edad, sexo } = req.body;
    const edadCalculada = fecha_nacimiento ? calcularEdadDesdeFecha(fecha_nacimiento) : Number(edad);
    if (!nombre || !nombre.trim() || edadCalculada === null || Number.isNaN(edadCalculada) || !sexo) return res.status(400).json({ error: 'Nombre, fecha de nacimiento/edad y sexo son requeridos' });
    if (fecha_nacimiento && calcularEdadDesdeFecha(fecha_nacimiento) === null) return res.status(400).json({ error: 'Fecha de nacimiento invalida' });
    if (!['M', 'F', 'O'].includes(sexo)) return res.status(400).json({ error: 'Sexo invalido' });
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ error: 'Correo invalido' });
    const existe = await get(`SELECT id FROM pacientes WHERE id = ?`, [id]);
    if (!existe) return res.status(404).json({ error: 'Paciente no encontrado' });
    const duplicado = await get(`
      SELECT id, nombre FROM pacientes
      WHERE activo = 1 AND id <> ?
        AND UPPER(TRIM(nombre)) = UPPER(TRIM(?))
        AND COALESCE(fecha_nacimiento, '') = COALESCE(?, '')
      LIMIT 1
    `, [id, nombre, fecha_nacimiento || null]);
    if (duplicado) return res.status(409).json({ error: 'Ya existe otro paciente con el mismo nombre y fecha de nacimiento', duplicado });
    await run(`
      UPDATE pacientes SET registro=?,nombre=?,celular=?,correo=?,direccion=?,observaciones=?,fecha_nacimiento=?,edad=?,sexo=?,updated_at=?
      WHERE id=?
    `, [registro||null,nombre.trim(),celular||null,correo||null,direccion||null,observaciones||null,fecha_nacimiento||null,edadCalculada,sexo,ahoraLocal(),id]);
    const paciente = await get(`
      SELECT id, registro, nombre, celular, correo, direccion, observaciones, fecha_nacimiento, edad, sexo, activo, created_at, updated_at
      FROM pacientes WHERE id = ?
    `, [id]);
    res.json(paciente);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'El nÃºmero de registro ya existe' });
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const delete_pacientes_by_id = async (req, res) => {
  try {
    const usos = await get(`SELECT COUNT(*) AS total FROM ordenes WHERE paciente_id = ?`, [req.params.id]);
    if (Number(usos?.total || 0) > 0) {
      await run(`UPDATE pacientes SET activo = 0, updated_at = ? WHERE id = ?`, [ahoraLocal(), req.params.id]);
      return res.json({ ok: true, archived: true });
    }
    await run(`DELETE FROM pacientes WHERE id = ?`, [req.params.id]);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

const get_pacientes_by_id_detalle = async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Paciente invalido' });
    const paciente = await get(`
      SELECT id, registro, nombre, celular, correo, direccion, observaciones, fecha_nacimiento, edad, sexo, activo, created_at, updated_at
      FROM pacientes WHERE id = ?
    `, [id]);
    if (!paciente) return res.status(404).json({ error: 'Paciente no encontrado' });
    const ordenes = await all(`
      SELECT id, folio, fecha, sucursal, medico, total, pagado, saldo, estado_pago, estado
      FROM ordenes
      WHERE paciente_id = ?
      ORDER BY fecha DESC, id DESC
      LIMIT 20
    `, [id]);
    const citas = await all(`
      SELECT id, fecha, hora_inicio, hora_fin, sucursal, estado, orden_folio
      FROM citas
      WHERE paciente_id = ?
      ORDER BY fecha DESC, hora_inicio DESC
      LIMIT 20
    `, [id]);
    const pagos = await all(`
      SELECT p.id, p.folio_orden, p.monto, p.metodo, p.fecha, p.cajero
      FROM pagos p
      JOIN ordenes o ON o.id = p.orden_id
      WHERE o.paciente_id = ?
      ORDER BY p.fecha DESC, p.id DESC
      LIMIT 20
    `, [id]);
    const resumen = await get(`
      SELECT COUNT(*) AS ordenes_total,
             COALESCE(SUM(total),0) AS total_facturado,
             COALESCE(SUM(pagado),0) AS total_pagado,
             COALESCE(SUM(saldo),0) AS saldo_pendiente,
             MAX(fecha) AS ultima_visita
      FROM ordenes
      WHERE paciente_id = ?
    `, [id]);
    res.json({ paciente, resumen, ordenes, citas, pagos });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
};

module.exports = {
  get_estudios,
  post_estudios,
  put_estudios_by_id,
  delete_estudios_by_id,
  post_orden,
  get_orden_by_folio_etiquetas,
  post_orden_by_folio_etiquetas_registrar_impresion,
  get_orden_by_folio,
  patch_orden_by_folio_estado,
  post_orden_by_folio_estudios,
  delete_orden_by_folio_estudio_by_estudioId,
  get_empresa,
  put_empresa,
  get_ordenes_buscar,
  get_dashboard,
  get_pacientes,
  post_pacientes,
  get_pacientes_siguiente_registro,
  put_pacientes_by_id,
  delete_pacientes_by_id,
  get_pacientes_by_id_detalle,
};
