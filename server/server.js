require('dotenv').config();

const express  = require('express');
const app      = express();
const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcrypt');
const multer   = require('multer');

const { run, get, all, withTransaction } = require('./db');
const authMiddleware    = require('./middlewares/authMiddleware');
const {
  ROLES,
  PERMISSIONS,
  isValidRole,
  normalizePermissions,
  resolveUserPermissions,
  serializePermissions,
  buildAuthUser,
  hasPermission,
} = require('./permissions');

app.use(express.json({ limit: '4mb' })); // aumentado para soportar logos en base64 (~2MB imagen â†’ ~2.7MB base64)

/* =========================
   JWT SECRET
========================= */
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set.');
  process.exit(1);
}

const PUBLIC_DIR = path.join(__dirname, '../public');
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

app.use(express.json({ limit: '4mb' })); // aumentado para soportar logos en base64 (~2MB imagen -> ~2.7MB base64)
app.use('/uploads/resultados', authUploadsMiddleware, express.static(path.join(PUBLIC_DIR, 'uploads/resultados')));
app.use(express.static(PUBLIC_DIR));

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
const UPLOADS_BASE = path.join(__dirname, '../public/uploads/resultados');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Guardar temporalmente, se mueve despuÃ©s con los datos del body
    const tmpDir = path.join(UPLOADS_BASE, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    const ext   = path.extname(file.originalname).toLowerCase();
    const stamp = Date.now();
    cb(null, `tmp-${stamp}${ext}`);
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
app.post('/api/login', async (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Usuario y contraseÃ±a son requeridos' });

    const user = await get(`SELECT * FROM usuarios WHERE usuario = ?`, [usuario]);
    if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const token = signUserToken(user);
    res.json({ token, role: user.role, permissions: resolveUserPermissions(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en login' });
  }
});

/* =========================
   FOLIO GENERATOR
========================= */
function generarFolio(sucursal, contador) {
  const year = new Date().getFullYear();
  return `LAB-${sucursal}-${year}-${String(contador).padStart(6, '0')}`;
}

/**
 * Genera un folio Ãºnico de forma atÃ³mica usando MAX(folio) dentro de una
 * transacciÃ³n con EXCLUSIVE lock, eliminando la race condition del COUNT+1.
 */
async function generarFolioAtomico(sucursal) {
  const { db } = require('./db');
  return new Promise((resolve, reject) => {
    const year        = new Date().getFullYear();
    const folioPrefix = `LAB-${sucursal}-${year}-`;
    db.serialize(() => {
      db.run('BEGIN EXCLUSIVE', (err) => {
        if (err) return reject(err);
        db.get(
          `SELECT MAX(CAST(SUBSTR(folio, LENGTH(?)+1) AS INTEGER)) AS ultimo
           FROM ordenes WHERE folio LIKE ?`,
          [folioPrefix, `${folioPrefix}%`],
          (err2, row) => {
            if (err2) { db.run('ROLLBACK'); return reject(err2); }
            const siguiente = (row?.ultimo ?? 0) + 1;
            const folio     = `${folioPrefix}${String(siguiente).padStart(6, '0')}`;
            db.run('COMMIT', (err3) => {
              if (err3) { db.run('ROLLBACK'); return reject(err3); }
              resolve(folio);
            });
          }
        );
      });
    });
  });
}

/* =========================
   REGISTRO GENERATOR
   Genera un nÃºmero de registro Ãºnico con formato PAC-YYYY-XXXX.
   Usa MAX correlativo dentro del aÃ±o para evitar colisiones.
========================= */
async function generarRegistroPaciente() {
  const { db } = require('./db');
  return new Promise((resolve, reject) => {
    const year   = new Date().getFullYear();
    const prefix = `PAC-${year}-`;
    db.get(
      `SELECT MAX(CAST(SUBSTR(registro, LENGTH(?)+1) AS INTEGER)) AS ultimo
       FROM pacientes WHERE registro LIKE ?`,
      [prefix, `${prefix}%`],
      (err, row) => {
        if (err) return reject(err);
        const siguiente = (row?.ultimo ?? 0) + 1;
        resolve(`${prefix}${String(siguiente).padStart(4, '0')}`);
      }
    );
  });
}

async function crearOrdenSegura({ nombre, dni, celular, fecha_nacimiento, edad, sexo, sucursal, medico, medico_telefono, estudios }) {
  return withTransaction(async (tx) => {
    let pacienteId;
    let esNuevoPaciente = false;

    if (dni) {
      const existente = await tx.get(`SELECT id FROM pacientes WHERE dni = ? LIMIT 1`, [dni]);
      if (existente) {
        pacienteId = existente.id;
        await tx.run(
          `UPDATE pacientes SET nombre = ?, celular = ?, fecha_nacimiento = ?, edad = ?, sexo = ? WHERE id = ?`,
          [nombre, celular || null, fecha_nacimiento || null, edad, sexo, pacienteId]
        );
      }
    }

    if (!pacienteId) {
      esNuevoPaciente = true;
      const registro = await generarRegistroPaciente();
      const paciente = await tx.run(
        `INSERT INTO pacientes (registro, nombre, dni, celular, fecha_nacimiento, edad, sexo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [registro, nombre, dni || null, celular || null, fecha_nacimiento || null, edad, sexo]
      );
      pacienteId = paciente.lastID;
    }

    const folio = await generarFolioEnTx(tx, sucursal);
    const orden = await tx.run(
      `INSERT INTO ordenes (folio, sucursal, paciente_id, medico, medico_telefono, total, pagado, saldo, estado_pago, fecha)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      [folio, sucursal, pacienteId, medico || null, medico_telefono?.trim() || null, ESTADOS_PAGO.PENDIENTE, ahoraLocal()]
    );

    let total = 0;
    for (const estudioId of estudios) {
      const estudio = await tx.get(`SELECT * FROM estudios WHERE id = ?`, [estudioId]);
      if (!estudio) throw new Error(`Estudio no encontrado: ${estudioId}`);
      total += Number(estudio.precio);
      await tx.run(`INSERT INTO orden_estudios (orden_id, estudio_id, precio) VALUES (?, ?, ?)`, [orden.lastID, estudioId, estudio.precio]);
    }

    const totalRedondeado = Math.round(total * 100) / 100;
    await tx.run(`UPDATE ordenes SET total = ?, saldo = ? WHERE id = ?`, [totalRedondeado, totalRedondeado, orden.lastID]);
    await sincronizarEstadoPagoOrden(orden.lastID, tx);
    const etiquetas = await regenerarEtiquetasOrden(orden.lastID, tx);
    const empresa = await tx.get(`SELECT * FROM empresa WHERE id = 1`);
    const paciente = await tx.get(`SELECT id, nombre, fecha_nacimiento, edad, sexo FROM pacientes WHERE id = ?`, [pacienteId]);

    return { folio, ordenId: orden.lastID, total: totalRedondeado, esNuevoPaciente, etiquetas, empresa, paciente };
  });
}

async function registrarPagoSeguro({ folio, monto, metodo, referencia, cajero }) {
  return withTransaction(async (tx) => {
    const orden = await tx.get(`SELECT * FROM ordenes WHERE folio = ?`, [folio]);
    if (!orden) {
      const error = new Error('Orden no encontrada');
      error.status = 404;
      throw error;
    }
    if (Number(orden.saldo) <= 0) {
      const error = new Error('Esta orden ya estÃ¡ pagada');
      error.status = 400;
      throw error;
    }

    const aplicado = Math.min(monto, Number(orden.saldo));
    const nuevoPagado = Math.round((Number(orden.pagado) + aplicado) * 100) / 100;
    const nuevoSaldo = Math.max(0, Math.round((Number(orden.total) - nuevoPagado) * 100) / 100);

    await tx.run(
      `UPDATE ordenes SET pagado = ?, saldo = ? WHERE id = ?`,
      [nuevoPagado, nuevoSaldo, orden.id]
    );

    const pago = await tx.run(
      `INSERT INTO pagos (orden_id, folio_orden, monto, metodo, referencia, cajero, fecha)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orden.id, folio, aplicado, metodo, referencia || null, cajero, ahoraLocal()]
    );

    const estadoPago = await sincronizarEstadoPagoOrden(orden.id, tx);
    const ordenActualizada = await tx.get(`SELECT * FROM ordenes WHERE id = ?`, [orden.id]);

    return {
      ok: true,
      pago_id: pago.lastID,
      aplicado,
      cambio: monto > Number(orden.saldo) ? +(monto - Number(orden.saldo)).toFixed(2) : 0,
      estado_pago: estadoPago,
      orden: ordenActualizada,
    };
  });
}

async function crearOrdenDesdeCitaSegura(cita, { sucursal, medico }) {
  return withTransaction(async (tx) => {
    let pacienteId = cita.paciente_id;
    const suc = sucursal || cita.sucursal;

    if (!pacienteId) {
      if (cita.paciente_dni) {
        const existente = await tx.get(`SELECT id FROM pacientes WHERE dni = ? LIMIT 1`, [cita.paciente_dni]);
        if (existente) pacienteId = existente.id;
      }
      if (!pacienteId) {
        const p = await tx.run(
          `INSERT INTO pacientes (nombre, dni, celular, edad, sexo) VALUES (?, ?, ?, 1, 'O')`,
          [cita.paciente_nombre, cita.paciente_dni || null, cita.paciente_celular || null]
        );
        pacienteId = p.lastID;
      }
      await tx.run(`UPDATE citas SET paciente_id = ? WHERE id = ?`, [pacienteId, cita.id]);
    }

    const folio = await generarFolioEnTx(tx, suc);
    const orden = await tx.run(
      `INSERT INTO ordenes (folio, sucursal, paciente_id, medico, total, pagado, saldo, estado_pago, fecha)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      [folio, suc, pacienteId, medico || null, ESTADOS_PAGO.PENDIENTE, ahoraLocal()]
    );

    let total = 0;
    const ids = JSON.parse(cita.estudios_ids || '[]');
    for (const eid of ids) {
      const est = await tx.get(`SELECT * FROM estudios WHERE id = ?`, [eid]);
      if (!est) throw new Error(`Estudio no encontrado: ${eid}`);
      total += Number(est.precio);
      await tx.run(`INSERT INTO orden_estudios (orden_id, estudio_id, precio) VALUES (?, ?, ?)`, [orden.lastID, est.id, est.precio]);
    }

    const totalRedondeado = Math.round(total * 100) / 100;
    if (totalRedondeado > 0) {
      await tx.run(`UPDATE ordenes SET total = ?, saldo = ? WHERE id = ?`, [totalRedondeado, totalRedondeado, orden.lastID]);
    }
    await sincronizarEstadoPagoOrden(orden.lastID, tx);
    await regenerarEtiquetasOrden(orden.lastID, tx);
    await tx.run(`UPDATE citas SET orden_id = ?, orden_folio = ?, estado = 'en_curso' WHERE id = ?`, [orden.lastID, folio, cita.id]);

    return { ok: true, folio, ordenId: orden.lastID, total: totalRedondeado };
  });
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   CATÃLOGO DE ESTUDIOS â€” CRUD
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

const CATEGORIAS_VALIDAS = [...CATEGORIAS_ESTUDIO_VALIDAS];

/* GET /api/estudios â€” listado completo (cualquier usuario autenticado) */

app.get('/api/estudios', authMiddleware, requirePermission('ordenes.view'), async (req, res) => {
  try {
    const estudios = await all('SELECT * FROM estudios ORDER BY categoria, nombre');
    res.json(estudios);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* POST /api/estudios â€” crear estudio (solo admin) */
app.post('/api/estudios', authMiddleware, requirePermission('estudios.manage'), async (req, res) => {
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
});

/* PUT /api/estudios/:id â€” editar estudio (solo admin) */
app.put('/api/estudios/:id', authMiddleware, requirePermission('estudios.manage'), async (req, res) => {
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
});

/* DELETE /api/estudios/:id â€” eliminar estudio (solo admin, bloqueado si tiene Ã³rdenes) */
app.delete('/api/estudios/:id', authMiddleware, requirePermission('estudios.manage'), async (req, res) => {
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
});

/* =========================
   CREAR ORDEN (PROTEGIDO)
========================= */
app.post('/api/orden', authMiddleware, requirePermission('ordenes.create'), async (req, res) => {
  try {
    const { nombre, dni, celular, fecha_nacimiento, sexo, sucursal, medico, medico_telefono, estudios } = req.body;
    const edad = calcularEdadDesdeFecha(fecha_nacimiento);

    if (!nombre || !fecha_nacimiento || !sexo || !sucursal) {
      return res.status(400).json({ error: 'Faltan campos requeridos: nombre, fecha_nacimiento, sexo, sucursal' });
    }
    if (!edad) {
      return res.status(400).json({ error: 'Fecha de nacimiento invalida' });
    }
    if (!Array.isArray(estudios) || estudios.length === 0) {
      return res.status(400).json({ error: 'Debe seleccionar al menos un estudio' });
    }
    const resultado = await crearOrdenSegura({ nombre, dni, celular, fecha_nacimiento, edad, sexo, sucursal, medico, medico_telefono, estudios });
    return res.status(201).json(resultado);

    // â”€â”€ Buscar o crear paciente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let pacienteId;
    let esNuevoPaciente = false;

    if (dni) {
      const existente = await get(`SELECT id FROM pacientes WHERE dni = ? LIMIT 1`, [dni]);
      if (existente) {
        pacienteId = existente.id;
        // Actualizar datos por si cambiaron
        await run(`UPDATE pacientes SET nombre=?, celular=?, fecha_nacimiento=?, edad=?, sexo=? WHERE id=?`,
          [nombre, celular || null, fecha_nacimiento || null, edad, sexo, pacienteId]);
      }
    }
    if (!pacienteId) {
      esNuevoPaciente = true;
      const registro  = await generarRegistroPaciente();
      const paciente  = await run(
        `INSERT INTO pacientes (registro, nombre, dni, celular, fecha_nacimiento, edad, sexo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [registro, nombre, dni || null, celular || null, fecha_nacimiento || null, edad, sexo]
      );
      pacienteId = paciente.lastID;
    }

    const folio = await generarFolioAtomico(sucursal);

    const orden = await run(
      `INSERT INTO ordenes (folio, sucursal, paciente_id, medico, medico_telefono, total, pagado, saldo, fecha)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)`,
      [folio, sucursal, pacienteId, medico || null, medico_telefono?.trim() || null, ahoraLocal()]
    );
    const ordenId = orden.lastID;
    let total = 0;

    for (const estudioId of estudios) {
      const estudio = await get(`SELECT * FROM estudios WHERE id = ?`, [estudioId]);
      if (!estudio) continue;
      total += estudio.precio;
      await run(`INSERT INTO orden_estudios (orden_id, estudio_id, precio) VALUES (?, ?, ?)`,
        [ordenId, estudioId, estudio.precio]);
    }

    // Redondear total a 2 decimales para evitar errores de punto flotante
    const totalRedondeado = Math.round(total * 100) / 100;
    await run(`UPDATE ordenes SET total = ?, saldo = ? WHERE id = ?`, [totalRedondeado, totalRedondeado, ordenId]);

    res.status(201).json({ folio, ordenId, total: totalRedondeado, esNuevoPaciente });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orden/:folio/etiquetas', authMiddleware, requirePermission('ordenes.view'), async (req, res) => {
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
});

app.post('/api/orden/:folio/etiquetas/registrar-impresion', authMiddleware, requirePermission('ordenes.view'), async (req, res) => {
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
});

/* =========================
   BUSCAR ORDEN POR FOLIO (PROTEGIDO)
========================= */
app.get('/api/orden/:folio', authMiddleware, requirePermission('ordenes.view'), async (req, res) => {
  try {
    const { folio } = req.params;
    if (!folio) return res.status(400).json({ error: 'Folio requerido' });

    const orden = await get(`
      SELECT o.*, p.nombre AS paciente_nombre, p.dni AS paciente_dni,
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
});

/* =========================
   ACTUALIZAR ESTADO DE ORDEN (PROTEGIDO)
========================= */
app.patch('/api/orden/:folio/estado', authMiddleware, requirePermission('ordenes.change_status'), async (req, res) => {
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
});

/* =========================
   AGREGAR ESTUDIOS A ORDEN (PROTEGIDO)
========================= */
app.post('/api/orden/:folio/estudios', authMiddleware, requirePermission('ordenes.edit'), async (req, res) => {
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
});

/* =========================
   QUITAR UN ESTUDIO DE ORDEN (PROTEGIDO)
========================= */
app.delete('/api/orden/:folio/estudio/:estudioId', authMiddleware, requirePermission('ordenes.edit'), async (req, res) => {
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
});

/* =========================
   GET EMPRESA (PROTEGIDO)
========================= */
app.get('/api/empresa', authMiddleware, requirePermission('dashboard.view'), async (req, res) => {
  try {
    const empresa = await get(`SELECT * FROM empresa WHERE id = 1`);
    res.json(empresa || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   UPDATE EMPRESA (SOLO ADMIN)
========================= */
app.put('/api/empresa', authMiddleware, requirePermission('empresa.manage'), async (req, res) => {
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
});

/* =========================
   BUSCAR Ã“RDENES â€” bÃºsqueda avanzada con filtros
   GET /api/ordenes/buscar
   Query params: q, estado, sucursal, fecha_desde, fecha_hasta, limit, offset
========================= */
app.get('/api/ordenes/buscar', authMiddleware, requirePermission('ordenes.view'), async (req, res) => {
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
      where += ` AND (p.nombre LIKE ? OR o.folio LIKE ? OR p.dni LIKE ? OR p.celular LIKE ?)`;
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
              p.nombre AS paciente_nombre, p.dni AS paciente_dni, p.celular AS paciente_celular, p.fecha_nacimiento AS paciente_fecha_nacimiento,
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
});

/* =========================
   DASHBOARD (PROTEGIDO)
========================= */
app.get('/api/dashboard', authMiddleware, requirePermission('dashboard.view'), async (req, res) => {
  try {
    const hoyLocal       = ahoraLocal().split(' ')[0];
    const ordenesHoy     = await get(`SELECT COUNT(*) as total FROM ordenes WHERE substr(fecha,1,10) = ?`, [hoyLocal]);
    const ingresos       = await get(`SELECT COALESCE(SUM(monto),0) as total FROM pagos WHERE substr(fecha,1,10) = ?`, [hoyLocal]);
    const pacientes      = await get(`SELECT COUNT(*) as total FROM pacientes`);
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
});

/* =========================
   PACIENTES â€” LISTADO (PROTEGIDO)
========================= */
app.get('/api/pacientes', authMiddleware, requirePermission('pacientes.view'), async (req, res) => {
  try {
    const buscar = req.query.buscar ? `%${req.query.buscar}%` : '%';
    const limit  = Math.min(parseInt(req.query.limit)||10, 100);
    const offset = parseInt(req.query.offset)||0;
    const total    = await get(`SELECT COUNT(*) as total FROM pacientes WHERE nombre LIKE ? OR dni LIKE ? OR registro LIKE ?`, [buscar,buscar,buscar]);
    const pacientes = await all(`SELECT * FROM pacientes WHERE nombre LIKE ? OR dni LIKE ? OR registro LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`, [buscar,buscar,buscar,limit,offset]);
    res.json({ pacientes, total: total.total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   PACIENTES â€” CREAR (PROTEGIDO)
========================= */
app.post('/api/pacientes', authMiddleware, requirePermission('pacientes.manage'), async (req, res) => {
  try {
    const { registro, nombre, dni, celular, fecha_nacimiento, edad, sexo } = req.body;
    const edadCalculada = fecha_nacimiento ? calcularEdadDesdeFecha(fecha_nacimiento) : Number(edad);
    if (!nombre || !edadCalculada || !sexo) return res.status(400).json({ error: 'Nombre, fecha de nacimiento/edad y sexo son requeridos' });
    const result  = await run(`INSERT INTO pacientes (registro,nombre,dni,celular,fecha_nacimiento,edad,sexo) VALUES (?,?,?,?,?,?,?)`, [registro||null,nombre,dni||null,celular||null,fecha_nacimiento||null,edadCalculada,sexo]);
    const paciente = await get(`SELECT * FROM pacientes WHERE id = ?`, [result.lastID]);
    res.status(201).json(paciente);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'El nÃºmero de registro ya existe' });
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* =========================
   PACIENTES â€” EDITAR (PROTEGIDO)
========================= */
app.put('/api/pacientes/:id', authMiddleware, requirePermission('pacientes.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const { registro, nombre, dni, celular, fecha_nacimiento, edad, sexo } = req.body;
    const edadCalculada = fecha_nacimiento ? calcularEdadDesdeFecha(fecha_nacimiento) : Number(edad);
    if (!nombre || !edadCalculada || !sexo) return res.status(400).json({ error: 'Nombre, fecha de nacimiento/edad y sexo son requeridos' });
    const existe = await get(`SELECT id FROM pacientes WHERE id = ?`, [id]);
    if (!existe) return res.status(404).json({ error: 'Paciente no encontrado' });
    await run(`UPDATE pacientes SET registro=?,nombre=?,dni=?,celular=?,fecha_nacimiento=?,edad=?,sexo=? WHERE id=?`, [registro||null,nombre,dni||null,celular||null,fecha_nacimiento||null,edadCalculada,sexo,id]);
    const paciente = await get(`SELECT * FROM pacientes WHERE id = ?`, [id]);
    res.json(paciente);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'El nÃºmero de registro ya existe' });
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* =========================
   PACIENTES â€” ELIMINAR (SOLO ADMIN)
========================= */
app.delete('/api/pacientes/:id', authMiddleware, requirePermission('pacientes.delete'), async (req, res) => {
  try {
    await run(`DELETE FROM pacientes WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   RESULTADOS
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* =========================
   GET /api/resultados/pendientes
   Ordenes pendiente o en_proceso, con bÃºsqueda
========================= */
app.get('/api/resultados/pendientes', authMiddleware, requirePermission('resultados.view'), async (req, res) => {
  try {
    const buscar = req.query.buscar ? `%${req.query.buscar}%` : '%';
    const limit  = Math.min(parseInt(req.query.limit)||60, 200);

    const ordenes = await all(`
      SELECT o.id, o.folio, o.estado, o.sucursal, o.medico, o.fecha, o.total,
             p.nombre AS paciente_nombre, p.dni AS paciente_dni
      FROM ordenes o
      JOIN pacientes p ON p.id = o.paciente_id
      WHERE o.estado IN ('pendiente', 'en_proceso')
        AND (p.nombre LIKE ? OR o.folio LIKE ? OR p.dni LIKE ?)
      ORDER BY o.id DESC
      LIMIT ?
    `, [buscar, buscar, buscar, limit]);

    res.json(ordenes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   GET /api/resultados/completados
   Ã“rdenes completadas, con bÃºsqueda
========================= */
app.get('/api/resultados/completados', authMiddleware, requirePermission('resultados.view'), async (req, res) => {
  try {
    const buscar = req.query.buscar ? `%${req.query.buscar}%` : '%';
    const limit  = Math.min(parseInt(req.query.limit) || 100, 500);

    const ordenes = await all(`
      SELECT o.id, o.folio, o.estado, o.sucursal, o.medico, o.fecha, o.total,
             p.nombre AS paciente_nombre, p.dni AS paciente_dni
      FROM ordenes o
      JOIN pacientes p ON p.id = o.paciente_id
      WHERE o.estado = 'completado'
        AND (p.nombre LIKE ? OR o.folio LIKE ? OR p.dni LIKE ?)
      ORDER BY o.id DESC
      LIMIT ?
    `, [buscar, buscar, buscar, limit]);

    res.json(ordenes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   GET /api/resultados/orden/:folio
   Orden + estudios + archivos asociados
========================= */
app.get('/api/resultados/orden/:folio', authMiddleware, requirePermission('resultados.view'), async (req, res) => {
  try {
    const { folio } = req.params;

    const orden = await get(`
      SELECT o.*, p.nombre AS paciente_nombre, p.dni AS paciente_dni,
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

    const archivos = await all(`
      SELECT ra.id,
             ra.orden_id,
             ra.estudio_id,
             ra.archivo_url,
             ra.archivo_nombre,
             ra.fecha,
             e.nombre    AS estudio_nombre,
             e.categoria AS estudio_categoria
      FROM resultado_archivos ra
      LEFT JOIN estudios e ON e.id = ra.estudio_id
      WHERE ra.orden_id = ?
      ORDER BY datetime(ra.fecha) DESC, ra.id DESC
    `, [orden.id]);

    res.json({ orden, estudios, archivos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   POST /api/resultados/subir
========================= */
app.post('/api/resultados/subir', authMiddleware, requirePermission('resultados.upload'), upload.array('archivos', 20), async (req, res) => {
  try {
    const ordenId = parsePositiveInt(req.body.orden_id);
    const estudioId = req.body.estudio_id ? parsePositiveInt(req.body.estudio_id) : null;

    if (!Array.isArray(req.files) || !req.files.length) return res.status(400).json({ error: 'No se recibio ningun archivo' });
    if (!ordenId) return res.status(400).json({ error: 'orden_id invalido' });

    const orden = await get(`SELECT * FROM ordenes WHERE id = ?`, [ordenId]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (orden.estado === ESTADOS_ORDEN.CANCELADO) {
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

    const destDir = path.join(UPLOADS_BASE, String(ordenId));
    fs.mkdirSync(destDir, { recursive: true });

    const archivos = [];
    for (const [index, file] of req.files.entries()) {
      const ext = path.extname(file.originalname).toLowerCase();
      const stamp = `${Date.now()}-${index}`;
      const newName = estudioId
        ? `estudio-${estudioId}-${stamp}${ext}`
        : `resultado-${stamp}${ext}`;
      const destPath = path.join(destDir, newName);
      fs.renameSync(file.path, destPath);

      const archivoUrl = `/uploads/resultados/${ordenId}/${newName}`;
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
    for (const file of req.files || []) {
      if (file?.path) fs.unlink(file.path, () => {});
    }
    console.error(err);
    if (err.message?.includes('no permitido')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   DELETE /api/resultados/archivo/:id
   Elimina archivo del disco y de la BD
   Si la orden estaba completada, la revierte a en_proceso
========================= */
app.delete('/api/resultados/archivo/:id', authMiddleware, requirePermission('resultados.delete'), async (req, res) => {
  try {
    const archivo = await get(`SELECT * FROM resultado_archivos WHERE id = ?`, [req.params.id]);
    if (!archivo) return res.status(404).json({ error: 'Archivo no encontrado' });

    const fullPath = path.join(__dirname, '../public', archivo.archivo_url);
    fs.unlink(fullPath, () => {});

    await run(`DELETE FROM resultado_archivos WHERE id = ?`, [req.params.id]);

    const estado = await sincronizarEstadoOrdenPorResultados(archivo.orden_id);

    res.json({ ok: true, estado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   CAJA
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* =========================
   GET /api/caja/orden/:folio
   Estado de cuenta de una orden
========================= */
app.get('/api/caja/orden/:folio', authMiddleware, requirePermission('caja.view'), async (req, res) => {
  try {
    const { folio } = req.params;

    const orden = await get(`
      SELECT o.*, p.nombre AS paciente_nombre, p.dni AS paciente_dni
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
});

/* =========================
   POST /api/resultados/completar/:ordenId
========================= */
app.post('/api/resultados/completar/:ordenId', authMiddleware, requirePermission('resultados.upload'), async (req, res) => {
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
});

/* =========================
   POST /api/resultados/reabrir/:ordenId
========================= */
app.post('/api/resultados/reabrir/:ordenId', authMiddleware, requirePermission('resultados.upload'), async (req, res) => {
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
});

app.get('/api/bootstrap/status', async (_req, res) => {
  try {
    const hasUsers = await existeAlgunUsuario();
    res.json({ needsSetup: !hasUsers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo verificar el estado inicial' });
  }
});

app.post('/api/bootstrap-admin', async (req, res) => {
  try {
    const { usuario, password } = req.body || {};

    if (!usuario || !usuario.trim()) {
      return res.status(400).json({ error: 'Usuario requerido' });
    }
    if (!password || password.length < 10) {
      return res.status(400).json({ error: 'ContraseÃ±a mÃ­nimo 10 caracteres' });
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
      return res.status(409).json({ error: 'La configuraciÃ³n inicial ya fue completada' });
    }

    const token = signUserToken(created);

    res.status(201).json({ token, role: created.role, usuario: created.usuario, permissions: resolveUserPermissions(created) });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'El nombre de usuario ya existe' });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo crear el usuario administrador inicial' });
  }
});

/* =========================
   POST /api/caja/pago
   Registrar un pago (parcial o total)
========================= */
app.post('/api/caja/pago', authMiddleware, requirePermission('caja.pay'), async (req, res) => {
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
});

/* =========================
   GET /api/caja/historial
   Pagos del dÃ­a (o fecha dada) con totales.
   Si existe un corte ese dÃ­a, solo incluye pagos DESPUÃ‰S del Ãºltimo corte.
========================= */
app.get('/api/caja/historial', authMiddleware, requirePermission('caja.view'), async (req, res) => {
  try {
    // Usar fecha local del servidor si no viene en query
    const fecha = req.query.fecha || ahoraLocal().split(' ')[0];

    // Buscar el Ãºltimo corte del dÃ­a comparando los primeros 10 chars ("YYYY-MM-DD")
    const ultimoCorte = await get(`
      SELECT fecha_fin FROM cortes
      WHERE substr(fecha_fin, 1, 10) = ?
      ORDER BY id DESC LIMIT 1
    `, [fecha]);

    let pagosSql, pagosParams, totalesSql, totalesParams;

    if (ultimoCorte) {
      // Solo pagos DESPUÃ‰S del Ãºltimo corte
      pagosSql    = `substr(p.fecha, 1, 10) = ? AND p.fecha > ?`;
      pagosParams = [fecha, ultimoCorte.fecha_fin];
      totalesSql    = `substr(fecha, 1, 10) = ? AND fecha > ?`;
      totalesParams = [fecha, ultimoCorte.fecha_fin];
    } else {
      pagosSql    = `substr(p.fecha, 1, 10) = ?`;
      pagosParams = [fecha];
      totalesSql    = `substr(fecha, 1, 10) = ?`;
      totalesParams = [fecha];
    }

    const pagos = await all(`
      SELECT p.*, pac.nombre AS paciente_nombre
      FROM pagos p
      JOIN ordenes o  ON o.id  = p.orden_id
      JOIN pacientes pac ON pac.id = o.paciente_id
      WHERE ${pagosSql}
      ORDER BY p.id DESC
    `, pagosParams);

    const totales = await get(`
      SELECT
        COALESCE(SUM(monto), 0)                                           AS total_general,
        COALESCE(SUM(CASE WHEN metodo='efectivo'      THEN monto END), 0) AS total_efectivo,
        COALESCE(SUM(CASE WHEN metodo='tarjeta'       THEN monto END), 0) AS total_tarjeta,
        COALESCE(SUM(CASE WHEN metodo='transferencia' THEN monto END), 0) AS total_transferencia,
        COUNT(*) AS num_pagos
      FROM pagos
      WHERE ${totalesSql}
    `, totalesParams);

    res.json({ fecha, pagos, totales, desde_corte: ultimoCorte ? ultimoCorte.fecha_fin : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   POST /api/caja/corte
   Generar corte de caja del dÃ­a (solo admin / recepcion).
   Solo acumula pagos DESDE el Ãºltimo corte previo del mismo dÃ­a.
========================= */
app.post('/api/caja/corte', authMiddleware, requirePermission('caja.cut'), async (req, res) => {
  try {
    const { observaciones, fecha } = req.body;
    const fechaCorte = fecha || ahoraLocal().split(' ')[0];

    // Buscar el Ãºltimo corte del mismo dÃ­a
    const ultimoCorte = await get(`
      SELECT fecha_fin FROM cortes
      WHERE substr(fecha_fin, 1, 10) = ?
      ORDER BY id DESC LIMIT 1
    `, [fechaCorte]);

    const desdeStr   = ultimoCorte ? ultimoCorte.fecha_fin : `${fechaCorte} 00:00:00`;
    const filtroFecha = ultimoCorte
      ? `substr(fecha, 1, 10) = ? AND fecha > ?`
      : `substr(fecha, 1, 10) = ?`;
    const totalesParams = ultimoCorte ? [fechaCorte, desdeStr] : [fechaCorte];

    const totales = await get(`
      SELECT
        COALESCE(SUM(monto), 0)                                           AS total_general,
        COALESCE(SUM(CASE WHEN metodo='efectivo'      THEN monto END), 0) AS total_efectivo,
        COALESCE(SUM(CASE WHEN metodo='tarjeta'       THEN monto END), 0) AS total_tarjeta,
        COALESCE(SUM(CASE WHEN metodo='transferencia' THEN monto END), 0) AS total_transferencia,
        COUNT(*) AS num_pagos
      FROM pagos
      WHERE ${filtroFecha}
    `, totalesParams);

    if (totales.num_pagos === 0) {
      return res.status(400).json({ error: 'No hay pagos nuevos desde el Ãºltimo corte. La caja ya estÃ¡ en ceros.' });
    }

    const corte = await run(`
      INSERT INTO cortes
        (cajero, fecha_inicio, fecha_fin, total_efectivo, total_tarjeta,
         total_transferencia, total_general, num_pagos, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.user.usuario,
      desdeStr,
      ahoraLocal(),
      totales.total_efectivo,
      totales.total_tarjeta,
      totales.total_transferencia,
      totales.total_general,
      totales.num_pagos,
      observaciones || null
    ]);

    const pagosParams = ultimoCorte ? [fechaCorte, desdeStr] : [fechaCorte];
    const pagosFiltro = ultimoCorte
      ? `substr(p.fecha, 1, 10) = ? AND p.fecha > ?`
      : `substr(p.fecha, 1, 10) = ?`;

    const pagos = await all(`
      SELECT p.*, pac.nombre AS paciente_nombre
      FROM pagos p
      JOIN ordenes o ON o.id = p.orden_id
      JOIN pacientes pac ON pac.id = o.paciente_id
      WHERE ${pagosFiltro}
      ORDER BY p.id ASC
    `, pagosParams);

    const empresa = await get(`SELECT * FROM empresa WHERE id = 1`);

    res.status(201).json({
      corte_id: corte.lastID,
      fecha:    fechaCorte,
      cajero:   req.user.usuario,
      totales,
      pagos,
      empresa
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   GET /api/caja/cortes
   Historial de cortes anteriores (solo admin)
========================= */
app.get('/api/caja/cortes', authMiddleware, requirePermission('caja.history'), async (req, res) => {
  try {
    const { desde, hasta, limit: lim } = req.query;
    const limit = Math.min(parseInt(lim) || 60, 200);

    let sql    = `SELECT * FROM cortes WHERE 1=1`;
    const params = [];

    if (desde) { sql += ` AND substr(fecha_fin, 1, 10) >= ?`; params.push(desde); }
    if (hasta) { sql += ` AND substr(fecha_fin, 1, 10) <= ?`; params.push(hasta); }

    sql += ` ORDER BY id DESC LIMIT ?`;
    params.push(limit);

    const cortes = await all(sql, params);
    res.json(cortes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   GET /api/caja/cortes/:id
   Detalle completo de un corte: cabecera + pagos del perÃ­odo
========================= */
app.get('/api/caja/cortes/:id', authMiddleware, requirePermission('caja.history'), async (req, res) => {
  try {
    const corte = await get(`SELECT * FROM cortes WHERE id = ?`, [req.params.id]);
    if (!corte) return res.status(404).json({ error: 'Corte no encontrado' });

    // Pagos que caen dentro del perÃ­odo fecha_inicio < fecha <= fecha_fin
    const pagos = await all(`
      SELECT p.*, pac.nombre AS paciente_nombre
      FROM pagos p
      JOIN ordenes o  ON o.id  = p.orden_id
      JOIN pacientes pac ON pac.id = o.paciente_id
      WHERE p.fecha >  ?
        AND p.fecha <= ?
      ORDER BY p.id ASC
    `, [corte.fecha_inicio, corte.fecha_fin]);

    const empresa = await get(`SELECT * FROM empresa WHERE id = 1`);

    res.json({ corte, pagos, empresa });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   GET /api/caja/cortes/comparativa
   Totales agrupados por dÃ­a para grÃ¡fica (admin)
========================= */
app.get('/api/caja/comparativa', authMiddleware, requirePermission('caja.analytics'), async (req, res) => {
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
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   AGENDA â€” CITAS
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

const SUCURSALES_VALIDAS = ['CDC', 'NTE', 'SUR'];
const ESTADOS_CITA = ['programada','confirmada','en_curso','completada','cancelada','no_asistio'];
const HORARIO_INICIO = '07:00';
const HORARIO_FIN    = '20:00';

/* Convierte "HH:MM" a minutos desde medianoche */
function hhmm(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

/* Verifica solapamiento entre dos intervalos */
function solapan(ini1, fin1, ini2, fin2) {
  return hhmm(ini1) < hhmm(fin2) && hhmm(fin1) > hhmm(ini2);
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   GET /api/agenda/tecnicos
   Lista tÃ©cnicos, filtrando por sucursal
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/agenda/tecnicos', authMiddleware, requirePermission('agenda.view'), async (req, res) => {
  try {
    const { sucursal } = req.query;
    const rows = sucursal
      ? await all(`SELECT * FROM tecnicos WHERE sucursal = ? AND activo = 1 ORDER BY nombre`, [sucursal])
      : await all(`SELECT * FROM tecnicos WHERE activo = 1 ORDER BY sucursal, nombre`);
    res.json(rows);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   POST /api/agenda/tecnicos
   Crear tÃ©cnico (admin)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/agenda/tecnicos', authMiddleware, requirePermission('agenda.tech.manage'), async (req, res) => {
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
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   DELETE /api/agenda/tecnicos/:id  (admin)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.delete('/api/agenda/tecnicos/:id', authMiddleware, requirePermission('agenda.tech.manage'), async (req, res) => {
  try {
    await run(`UPDATE tecnicos SET activo = 0 WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   GET /api/agenda/disponibilidad
   Slots libres para una fecha + sucursal + tÃ©cnico
   Query: fecha, sucursal, tecnico_id, duracion (min)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/agenda/disponibilidad', authMiddleware, requirePermission('agenda.view'), async (req, res) => {
  try {
    const { fecha, sucursal, tecnico_id, duracion = 30 } = req.query;
    if (!fecha || !sucursal) return res.status(400).json({ error: 'fecha y sucursal requeridos' });

    const dur = Math.max(15, Math.min(480, Number(duracion)));

    // Citas del dÃ­a para ese tÃ©cnico/sucursal
    let citasSql = `SELECT hora_inicio, hora_fin FROM citas WHERE fecha = ? AND sucursal = ? AND estado NOT IN ('cancelada','no_asistio')`;
    const citasParams = [fecha, sucursal];
    if (tecnico_id) { citasSql += ` AND tecnico_id = ?`; citasParams.push(tecnico_id); }
    const citasOcupadas = await all(citasSql, citasParams);

    // Bloqueos del dÃ­a
    let blqSql = `SELECT hora_inicio, hora_fin FROM agenda_bloqueos WHERE fecha = ? AND sucursal = ?`;
    const blqParams = [fecha, sucursal];
    if (tecnico_id) { blqSql += ` AND (tecnico_id IS NULL OR tecnico_id = ?)`; blqParams.push(tecnico_id); }
    const bloqueos = await all(blqSql, blqParams);

    const ocupados = [...citasOcupadas, ...bloqueos];

    // Generar slots de 15 min entre 07:00 y 20:00
    const slots = [];
    let cur = hhmm(HORARIO_INICIO);
    const limite = hhmm(HORARIO_FIN) - dur;

    while (cur <= limite) {
      const hIni = String(Math.floor(cur / 60)).padStart(2, '0') + ':' + String(cur % 60).padStart(2, '0');
      const finMin = cur + dur;
      const hFin = String(Math.floor(finMin / 60)).padStart(2, '0') + ':' + String(finMin % 60).padStart(2, '0');
      const libre = !ocupados.some(o => solapan(hIni, hFin, o.hora_inicio, o.hora_fin));
      slots.push({ hora_inicio: hIni, hora_fin: hFin, libre });
      cur += 15;
    }

    res.json(slots);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   GET /api/agenda/citas
   Citas del dÃ­a (o rango), filtradas
   Query: fecha, fecha_fin?, sucursal?, tecnico_id?, estado?
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/agenda/citas', authMiddleware, requirePermission('agenda.view'), async (req, res) => {
  try {
    const { fecha, fecha_fin, sucursal, tecnico_id, estado } = req.query;
    if (!fecha) return res.status(400).json({ error: 'fecha requerida' });

    let sql = `
      SELECT c.*, t.nombre AS tecnico_nombre
      FROM citas c
      LEFT JOIN tecnicos t ON t.id = c.tecnico_id
      WHERE c.fecha >= ?`;
    const params = [fecha];

    if (fecha_fin) { sql += ` AND c.fecha <= ?`;        params.push(fecha_fin); }
    else           { sql += ` AND c.fecha = ?`;         params.push(fecha);     }
    if (sucursal)  { sql += ` AND c.sucursal = ?`;      params.push(sucursal);  }
    if (tecnico_id){ sql += ` AND c.tecnico_id = ?`;    params.push(tecnico_id);}
    if (estado)    { sql += ` AND c.estado = ?`;        params.push(estado);    }

    sql += ` ORDER BY c.hora_inicio ASC`;
    const citas = await all(sql, params);
    res.json(citas);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   POST /api/agenda/citas
   Crear cita con validaciÃ³n de solapamiento
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/agenda/citas', authMiddleware, requirePermission('agenda.manage'), async (req, res) => {
  try {
    const {
      sucursal, tecnico_id, paciente_id,
      paciente_nombre, paciente_dni, paciente_celular,
      fecha, hora_inicio, hora_fin, duracion_min,
      estudios_ids, estudios_nombres, notas
    } = req.body;

    // Validaciones bÃ¡sicas
    if (!sucursal || !SUCURSALES_VALIDAS.includes(sucursal))
      return res.status(400).json({ error: 'Sucursal invÃ¡lida' });
    if (!paciente_nombre?.trim())
      return res.status(400).json({ error: 'Nombre del paciente requerido' });
    if (!fecha || !hora_inicio || !hora_fin)
      return res.status(400).json({ error: 'Fecha y horario requeridos' });
    if (hhmm(hora_inicio) >= hhmm(hora_fin))
      return res.status(400).json({ error: 'Horario invÃ¡lido: inicio debe ser antes del fin' });
    if (hhmm(hora_inicio) < hhmm(HORARIO_INICIO) || hhmm(hora_fin) > hhmm(HORARIO_FIN))
      return res.status(400).json({ error: `Horario fuera del rango permitido (${HORARIO_INICIO}â€“${HORARIO_FIN})` });

    // Validar solapamiento con otras citas del mismo tÃ©cnico/sucursal
    let dupSql = `SELECT id, paciente_nombre, hora_inicio, hora_fin FROM citas
                  WHERE fecha = ? AND sucursal = ? AND estado NOT IN ('cancelada','no_asistio')`;
    const dupParams = [fecha, sucursal];
    if (tecnico_id) { dupSql += ` AND tecnico_id = ?`; dupParams.push(tecnico_id); }
    const existentes = await all(dupSql, dupParams);

    const conflicto = existentes.find(c => solapan(hora_inicio, hora_fin, c.hora_inicio, c.hora_fin));
    if (conflicto)
      return res.status(409).json({
        error: `Horario ocupado: "${conflicto.paciente_nombre}" ya tiene cita de ${conflicto.hora_inicio} a ${conflicto.hora_fin}`
      });

    // Validar solapamiento con bloqueos
    let blqSql = `SELECT motivo, hora_inicio, hora_fin FROM agenda_bloqueos
                  WHERE fecha = ? AND sucursal = ?`;
    const blqParams = [fecha, sucursal];
    if (tecnico_id) { blqSql += ` AND (tecnico_id IS NULL OR tecnico_id = ?)`; blqParams.push(tecnico_id); }
    const bloqueos = await all(blqSql, blqParams);
    const bloqueo = bloqueos.find(b => solapan(hora_inicio, hora_fin, b.hora_inicio, b.hora_fin));
    if (bloqueo)
      return res.status(409).json({
        error: `Horario bloqueado: "${bloqueo.motivo || 'sin motivo'}" (${bloqueo.hora_inicio}â€“${bloqueo.hora_fin})`
      });

    const dur = duracion_min || (hhmm(hora_fin) - hhmm(hora_inicio));
    const eIds = JSON.stringify(Array.isArray(estudios_ids) ? estudios_ids : []);
    const eNom  = Array.isArray(estudios_nombres) ? estudios_nombres.join(', ') : (estudios_nombres || '');

    const r = await run(`
      INSERT INTO citas
        (sucursal, tecnico_id, paciente_id, paciente_nombre, paciente_dni, paciente_celular,
         fecha, hora_inicio, hora_fin, duracion_min, estudios_ids, estudios_nombres,
         estado, notas, creado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'programada', ?, ?)
    `, [
      sucursal, tecnico_id || null, paciente_id || null,
      paciente_nombre.trim(), paciente_dni || null, paciente_celular || null,
      fecha, hora_inicio, hora_fin, dur, eIds, eNom,
      notas || null, req.user.usuario
    ]);

    const cita = await get(`SELECT * FROM citas WHERE id = ?`, [r.lastID]);
    res.status(201).json(cita);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   PATCH /api/agenda/citas/:id/estado
   Cambiar estado de una cita
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.patch('/api/agenda/citas/:id/estado', authMiddleware, requirePermission('agenda.manage'), async (req, res) => {
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
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   PUT /api/agenda/citas/:id
   Editar cita completa (revalida solapamiento)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.put('/api/agenda/citas/:id', authMiddleware, requirePermission('agenda.manage'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const citaExistente = await get(`SELECT * FROM citas WHERE id = ?`, [id]);
    if (!citaExistente) return res.status(404).json({ error: 'Cita no encontrada' });

    const {
      sucursal, tecnico_id, paciente_id,
      paciente_nombre, paciente_dni, paciente_celular,
      fecha, hora_inicio, hora_fin, duracion_min,
      estudios_ids, estudios_nombres, notas
    } = req.body;

    if (!paciente_nombre?.trim()) return res.status(400).json({ error: 'Nombre del paciente requerido' });
    if (!fecha || !hora_inicio || !hora_fin) return res.status(400).json({ error: 'Fecha y horario requeridos' });
    if (hhmm(hora_inicio) >= hhmm(hora_fin)) return res.status(400).json({ error: 'Horario invÃ¡lido' });

    // Solapamiento excluyendo la propia cita
    let dupSql = `SELECT id, paciente_nombre, hora_inicio, hora_fin FROM citas
                  WHERE fecha = ? AND sucursal = ? AND id != ? AND estado NOT IN ('cancelada','no_asistio')`;
    const dupParams = [fecha, sucursal || citaExistente.sucursal, id];
    if (tecnico_id) { dupSql += ` AND tecnico_id = ?`; dupParams.push(tecnico_id); }
    const existentes = await all(dupSql, dupParams);
    const conflicto = existentes.find(c => solapan(hora_inicio, hora_fin, c.hora_inicio, c.hora_fin));
    if (conflicto)
      return res.status(409).json({
        error: `Horario ocupado: "${conflicto.paciente_nombre}" (${conflicto.hora_inicio}â€“${conflicto.hora_fin})`
      });

    const dur = duracion_min || (hhmm(hora_fin) - hhmm(hora_inicio));
    const eIds = JSON.stringify(Array.isArray(estudios_ids) ? estudios_ids : []);
    const eNom  = Array.isArray(estudios_nombres) ? estudios_nombres.join(', ') : (estudios_nombres || '');

    await run(`
      UPDATE citas SET
        sucursal=?, tecnico_id=?, paciente_id=?, paciente_nombre=?,
        paciente_dni=?, paciente_celular=?, fecha=?, hora_inicio=?, hora_fin=?,
        duracion_min=?, estudios_ids=?, estudios_nombres=?, notas=?
      WHERE id=?
    `, [
      sucursal || citaExistente.sucursal,
      tecnico_id || null, paciente_id || null,
      paciente_nombre.trim(), paciente_dni || null, paciente_celular || null,
      fecha, hora_inicio, hora_fin, dur, eIds, eNom, notas || null, id
    ]);

    const cita = await get(`SELECT * FROM citas WHERE id = ?`, [id]);
    res.json(cita);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   DELETE /api/agenda/citas/:id  (cancela, no borra)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.delete('/api/agenda/citas/:id', authMiddleware, requirePermission('agenda.manage'), async (req, res) => {
  try {
    const cita = await get(`SELECT * FROM citas WHERE id = ?`, [req.params.id]);
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    await run(`UPDATE citas SET estado = 'cancelada' WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   POST /api/agenda/citas/:id/orden
   Convertir cita en orden (vincula)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/agenda/citas/:id/orden', authMiddleware, requirePermission('ordenes.create'), async (req, res) => {
  try {
    const cita = await get(`SELECT * FROM citas WHERE id = ?`, [req.params.id]);
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    if (cita.orden_id) return res.status(409).json({ error: 'Esta cita ya tiene una orden vinculada', orden_folio: cita.orden_folio });

    const { sucursal, medico } = req.body;
    const resultado = await crearOrdenDesdeCitaSegura(cita, { sucursal, medico });
    return res.status(201).json(resultado);
    const suc = sucursal || cita.sucursal;

    // Crear paciente si no existe vinculado
    let pacienteId = cita.paciente_id;
    if (!pacienteId) {
      // Buscar primero por DNI para no duplicar
      if (cita.paciente_dni) {
        const existente = await get(`SELECT id FROM pacientes WHERE dni = ? LIMIT 1`, [cita.paciente_dni]);
        if (existente) pacienteId = existente.id;
      }
      if (!pacienteId) {
        // edad=1 como mÃ­nimo vÃ¡lido; se puede actualizar despuÃ©s en el perfil del paciente
        const p = await run(
          `INSERT INTO pacientes (nombre, dni, celular, edad, sexo) VALUES (?, ?, ?, 1, 'O')`,
          [cita.paciente_nombre, cita.paciente_dni || null, cita.paciente_celular || null]
        );
        pacienteId = p.lastID;
      }
      await run(`UPDATE citas SET paciente_id = ? WHERE id = ?`, [pacienteId, cita.id]);
    }

    // Generar folio atÃ³mico
    const folio = await generarFolioAtomico(suc);

    const orden = await run(
      `INSERT INTO ordenes (folio, sucursal, paciente_id, medico, total, pagado, saldo, fecha) VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
      [folio, suc, pacienteId, medico || null, ahoraLocal()]
    );
    const ordenId = orden.lastID;

    // Agregar estudios si vienen en la cita
    let total = 0;
    const ids = JSON.parse(cita.estudios_ids || '[]');
    for (const eid of ids) {
      const est = await get(`SELECT * FROM estudios WHERE id = ?`, [eid]);
      if (!est) continue;
      total += est.precio;
      await run(`INSERT INTO orden_estudios (orden_id, estudio_id, precio) VALUES (?, ?, ?)`, [ordenId, est.id, est.precio]);
    }
    if (total > 0) await run(`UPDATE ordenes SET total = ?, saldo = ? WHERE id = ?`, [total, total, ordenId]);

    // Vincular orden a cita y marcar en_curso
    await run(`UPDATE citas SET orden_id = ?, orden_folio = ?, estado = 'en_curso' WHERE id = ?`, [ordenId, folio, cita.id]);

    res.status(201).json({ ok: true, folio, ordenId, total });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   GET /api/agenda/bloqueos
   Bloqueos de una fecha/sucursal
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/agenda/bloqueos', authMiddleware, requirePermission('agenda.view'), async (req, res) => {
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
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   POST /api/agenda/bloqueos  (admin/recepcion)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/agenda/bloqueos', authMiddleware, requirePermission('agenda.block'), async (req, res) => {
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
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   DELETE /api/agenda/bloqueos/:id  (admin/recepcion)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.delete('/api/agenda/bloqueos/:id', authMiddleware, requirePermission('agenda.block'), async (req, res) => {
  try {
    await run(`DELETE FROM agenda_bloqueos WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   USUARIOS â€” CRUD (solo admin)
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* GET /api/usuarios */
app.get('/api/usuarios/meta', authMiddleware, requirePermission('usuarios.manage'), async (_req, res) => {
  res.json({
    roles: ROLES,
    permissions: PERMISSIONS,
    defaults: Object.fromEntries(ROLES.map((role) => [role, resolveUserPermissions({ role, permissions: null })])),
  });
});

app.get('/api/usuarios', authMiddleware, requirePermission('usuarios.manage'), async (req, res) => {
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
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* POST /api/usuarios â€” crear usuario */
app.post('/api/usuarios', authMiddleware, requirePermission('usuarios.manage'), async (req, res) => {
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
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* PUT /api/usuarios/:id â€” editar usuario */
app.put('/api/usuarios/:id', authMiddleware, requirePermission('usuarios.manage'), async (req, res) => {
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
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* DELETE /api/usuarios/:id */
app.delete('/api/usuarios/:id', authMiddleware, requirePermission('usuarios.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (Number(id) === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
    const existe = await get(`SELECT id FROM usuarios WHERE id = ?`, [id]);
    if (!existe) return res.status(404).json({ error: 'Usuario no encontrado' });
    await run(`DELETE FROM usuarios WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
