const { all, get } = require('../db');

const PERIODOS_VALIDOS = new Set(['hoy', 'semana', 'mes', 'mes_anterior', 'rango']);

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) return null;
  return date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeekMonday(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  return start;
}

function resolveRange(query = {}) {
  const periodo = PERIODOS_VALIDOS.has(String(query.periodo || '')) ? String(query.periodo) : 'mes';
  const today = new Date();
  let from;
  let to;

  if (periodo === 'hoy') {
    from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    to = from;
  } else if (periodo === 'semana') {
    from = startOfWeekMonday(today);
    to = addDays(from, 6);
  } else if (periodo === 'mes_anterior') {
    from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    to = new Date(today.getFullYear(), today.getMonth(), 0);
  } else if (periodo === 'rango') {
    from = parseDate(query.desde);
    to = parseDate(query.hasta);
    if (!from || !to || from > to) {
      const error = new Error('Rango de fechas invalido');
      error.status = 400;
      throw error;
    }
  } else {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
    to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  }

  return {
    periodo,
    desde: formatDate(from),
    hasta: formatDate(to),
    desdeSql: `${formatDate(from)} 00:00:00`,
    hastaSql: `${formatDate(to)} 23:59:59`,
    sucursal: String(query.sucursal || '').trim(),
  };
}

function sucursalFilter(range, params) {
  if (!range.sucursal) return '';
  params.push(range.sucursal);
  return ' AND o.sucursal = ?';
}

async function getResumen(range) {
  const params = [range.desdeSql, range.hastaSql];
  const sucursalSql = sucursalFilter(range, params);

  return get(`
    SELECT
      COUNT(DISTINCT o.id) AS ordenes,
      COUNT(DISTINCT o.paciente_id) AS pacientes,
      COALESCE(SUM(o.total), 0) AS ventas,
      COALESCE(SUM(o.pagado), 0) AS cobrado,
      COALESCE(SUM(o.saldo), 0) AS saldo,
      COALESCE(AVG(o.total), 0) AS ticket_promedio,
      COALESCE(SUM(est.conteo), 0) AS estudios_vendidos
    FROM ordenes o
    LEFT JOIN (
      SELECT orden_id, COUNT(*) AS conteo
      FROM orden_estudios
      GROUP BY orden_id
    ) est ON est.orden_id = o.id
    WHERE o.fecha BETWEEN ? AND ?
      AND o.estado != 'cancelado'
      ${sucursalSql}
  `, params);
}

async function getEstudios(range, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
  const params = [range.desdeSql, range.hastaSql];
  const sucursalSql = sucursalFilter(range, params);
  params.push(safeLimit);

  return all(`
    SELECT
      e.id,
      e.nombre,
      e.categoria,
      COUNT(*) AS cantidad,
      COALESCE(SUM(oe.precio), 0) AS ingresos,
      COALESCE(AVG(oe.precio), 0) AS precio_promedio,
      COUNT(DISTINCT o.id) AS ordenes
    FROM orden_estudios oe
    JOIN estudios e ON e.id = oe.estudio_id
    JOIN ordenes o ON o.id = oe.orden_id
    WHERE o.fecha BETWEEN ? AND ?
      AND o.estado != 'cancelado'
      ${sucursalSql}
    GROUP BY e.id, e.nombre, e.categoria
    ORDER BY cantidad DESC, ingresos DESC, e.nombre ASC
    LIMIT ?
  `, params);
}

async function getVentasDia(range) {
  const params = [range.desdeSql, range.hastaSql];
  const sucursalSql = sucursalFilter(range, params);

  return all(`
    SELECT
      substr(o.fecha, 1, 10) AS fecha,
      COUNT(DISTINCT o.id) AS ordenes,
      COALESCE(SUM(o.total), 0) AS ventas,
      COALESCE(SUM(o.pagado), 0) AS cobrado,
      COALESCE(SUM(est.conteo), 0) AS estudios
    FROM ordenes o
    LEFT JOIN (
      SELECT orden_id, COUNT(*) AS conteo
      FROM orden_estudios
      GROUP BY orden_id
    ) est ON est.orden_id = o.id
    WHERE o.fecha BETWEEN ? AND ?
      AND o.estado != 'cancelado'
      ${sucursalSql}
    GROUP BY substr(o.fecha, 1, 10)
    ORDER BY fecha ASC
  `, params);
}

async function getCategorias(range) {
  const params = [range.desdeSql, range.hastaSql];
  const sucursalSql = sucursalFilter(range, params);

  return all(`
    SELECT
      COALESCE(NULLIF(TRIM(e.categoria), ''), 'OTROS') AS categoria,
      COUNT(*) AS cantidad,
      COALESCE(SUM(oe.precio), 0) AS ingresos
    FROM orden_estudios oe
    JOIN estudios e ON e.id = oe.estudio_id
    JOIN ordenes o ON o.id = oe.orden_id
    WHERE o.fecha BETWEEN ? AND ?
      AND o.estado != 'cancelado'
      ${sucursalSql}
    GROUP BY COALESCE(NULLIF(TRIM(e.categoria), ''), 'OTROS')
    ORDER BY cantidad DESC, ingresos DESC
  `, params);
}

async function getSucursales() {
  return all(`
    SELECT DISTINCT sucursal
    FROM ordenes
    WHERE sucursal IS NOT NULL AND TRIM(sucursal) <> ''
    ORDER BY sucursal ASC
  `);
}

module.exports = {
  resolveRange,
  getResumen,
  getEstudios,
  getVentasDia,
  getCategorias,
  getSucursales,
};
