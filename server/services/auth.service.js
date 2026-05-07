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
const { parsePositiveMoney: parseStrictPositiveMoney } = require('../utils/validation');


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
  if (!isValidRole(role)) return { error: `Rol invalido. Valid roles: ${ROLES.join(', ')}` };
  if (requirePassword && (!password || password.length < 10)) {
    return { error: 'Contrasena minimo 10 caracteres' };
  }
  if (!requirePassword && password && password.length < 10) {
    return { error: 'Contrasena minimo 10 caracteres' };
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

  // Si se definió TZ_OFFSET en .env (ej: TZ_OFFSET=-6 para México Centro),
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
  return parseStrictPositiveMoney(value);
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
   MULTER — storage corregido
   Usa /tmp primero, luego mueve al destino correcto
========================= */
const RESULTADOS_STORAGE_BASE = resultadoStorage.RESULTADOS_STORAGE_BASE;
const RESULTADOS_TMP_DIR = resultadoStorage.RESULTADOS_TMP_DIR;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Guardar temporalmente, se mueve después con los datos del body
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
    else cb(new Error('Tipo de archivo no permitido. Solo PDF e imágenes.'));
  }
});

/* =========================
   LOGIN
========================= */


const post_login = async (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });

    const user = await get(`SELECT * FROM usuarios WHERE usuario = ?`, [usuario]);
    if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const token = signUserToken(user);
    res.json({ token, role: user.role, permissions: resolveUserPermissions(user) });
  } catch (err) {
    throw err;
  }
};

const get_bootstrap_status = async (_req, res) => {
  try {
    const hasUsers = await existeAlgunUsuario();
    res.json({ needsSetup: !hasUsers });
  } catch (err) {
    throw err;
  }
};

const post_bootstrap_admin = async (req, res) => {
  try {
    const { usuario, password } = req.body || {};

    if (!usuario || !usuario.trim()) {
      return res.status(400).json({ error: 'Usuario requerido' });
    }
    if (!password || password.length < 10) {
      return res.status(400).json({ error: 'Contraseña mínimo 10 caracteres' });
    }

    const created = await withTransaction(async (tx) => {
      const hasUsers = await existeAlgunUsuario(tx);
      if (hasUsers) return null;

      const hashed = await bcrypt.hash(password, 10);
      const result = await tx.run(
        `INSERT INTO usuarios (usuario, password, role, permissions) VALUES (?, ?, ?, ?)`,
        [usuario.trim(), hashed, 'admin', null]
      );

      return { id: result.lastID, usuario: usuario.trim(), role: 'admin', permissions: null };
    });

    if (!created) {
      return res.status(409).json({ error: 'La configuración inicial ya fue completada' });
    }

    const token = signUserToken(created);

    res.status(201).json({ token, role: created.role, usuario: created.usuario, permissions: resolveUserPermissions(created) });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'El nombre de usuario ya existe' });
    }
    throw err;
  }
};

const get_usuarios_meta = async (_req, res) => {
  res.json({
    roles: ROLES,
    permissions: PERMISSIONS,
    defaults: Object.fromEntries(ROLES.map((role) => [role, resolveUserPermissions({ role, permissions: null })])),
  });
};

const get_usuarios = async (req, res) => {
  try {
    const usuarios = await all(`SELECT id, usuario, role, permissions FROM usuarios ORDER BY id ASC`);
    res.json(usuarios.map((user) => ({
      id: user.id,
      usuario: user.usuario,
      role: user.role,
      permissions: resolveUserPermissions(user),
      hasCustomPermissions: Boolean(user.permissions),
    })));
  } catch (err) {
    throw err;
  }
};

const post_usuarios = async (req, res) => {
  try {
    const parsed = parseUserPayload(req.body, { requirePassword: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const hashed = await bcrypt.hash(parsed.password, 10);
    const result = await run(
      `INSERT INTO usuarios (usuario, password, role, permissions) VALUES (?, ?, ?, ?)`,
      [parsed.usuario, hashed, parsed.role, parsed.permissionsSerialized]
    );
    res.status(201).json({
      id: result.lastID,
      usuario: parsed.usuario,
      role: parsed.role,
      permissions: parsed.permissions,
      hasCustomPermissions: Boolean(parsed.permissionsSerialized),
    });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'El nombre de usuario ya existe' });
    throw err;
  }
};

const put_usuarios_by_id = async (req, res) => {
  try {
    const { id } = req.params;
    const parsed = parseUserPayload(req.body, { requirePassword: false });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const existe = await get(`SELECT id FROM usuarios WHERE id = ?`, [id]);
    if (!existe) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (parsed.password) {
      const hashed = await bcrypt.hash(parsed.password, 10);
      await run(`UPDATE usuarios SET usuario=?, password=?, role=?, permissions=? WHERE id=?`, [parsed.usuario, hashed, parsed.role, parsed.permissionsSerialized, id]);
    } else {
      await run(`UPDATE usuarios SET usuario=?, role=?, permissions=? WHERE id=?`, [parsed.usuario, parsed.role, parsed.permissionsSerialized, id]);
    }
    const response = {
      id: Number(id),
      usuario: parsed.usuario,
      role: parsed.role,
      permissions: parsed.permissions,
      hasCustomPermissions: Boolean(parsed.permissionsSerialized),
    };
    if (Number(id) === req.user.id) {
      response.token = signUserToken({
        id: Number(id),
        usuario: parsed.usuario,
        role: parsed.role,
        permissions: parsed.permissionsSerialized,
      });
    }
    res.json(response);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'El nombre de usuario ya existe' });
    throw err;
  }
};

const delete_usuarios_by_id = async (req, res) => {
  try {
    const { id } = req.params;
    if (Number(id) === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
    const existe = await get(`SELECT id FROM usuarios WHERE id = ?`, [id]);
    if (!existe) return res.status(404).json({ error: 'Usuario no encontrado' });
    await run(`DELETE FROM usuarios WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (err) {
    throw err;
  }
};

module.exports = {
  post_login,
  get_bootstrap_status,
  post_bootstrap_admin,
  get_usuarios_meta,
  get_usuarios,
  post_usuarios,
  put_usuarios_by_id,
  delete_usuarios_by_id,
};
