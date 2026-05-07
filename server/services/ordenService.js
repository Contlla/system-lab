const { get, run, all, withTransaction } = require('../db');

const ESTADOS_PAGO = Object.freeze({
  PENDIENTE: 'pendiente',
  PARCIAL: 'parcial',
  PAGADO: 'pagado',
});

function ahoraLocal() {
  const TZ = process.env.TZ_OFFSET !== undefined
    ? parseInt(process.env.TZ_OFFSET, 10)
    : null;

  const now = new Date();
  const fechaRef = TZ !== null && !Number.isNaN(TZ)
    ? new Date(now.getTime() + now.getTimezoneOffset() * 60000 + TZ * 3600000)
    : now;

  const pad = (n) => String(n).padStart(2, '0');
  return `${fechaRef.getFullYear()}-${pad(fechaRef.getMonth() + 1)}-${pad(fechaRef.getDate())} ` +
    `${pad(fechaRef.getHours())}:${pad(fechaRef.getMinutes())}:${pad(fechaRef.getSeconds())}`;
}

async function generarRegistroPaciente(executor = { get }) {
  const year = new Date().getFullYear();
  const prefix = `PAC-${year}-`;
  const row = await executor.get(
    `SELECT MAX(CAST(SUBSTR(registro, LENGTH(?)+1) AS INTEGER)) AS ultimo
     FROM pacientes WHERE registro LIKE ?`,
    [prefix, `${prefix}%`]
  );
  const siguiente = (row?.ultimo ?? 0) + 1;
  return `${prefix}${String(siguiente).padStart(4, '0')}`;
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

async function sincronizarEstadoPagoOrden(ordenId, executor = { get, run }) {
  const orden = await executor.get(
    `SELECT id, total, pagado, saldo, estado_pago FROM ordenes WHERE id = ?`,
    [ordenId]
  );
  if (!orden) return null;

  let estadoPago = ESTADOS_PAGO.PENDIENTE;
  if (Number(orden.saldo) <= 0 && Number(orden.total) > 0) estadoPago = ESTADOS_PAGO.PAGADO;
  else if (Number(orden.pagado) > 0) estadoPago = ESTADOS_PAGO.PARCIAL;

  if (estadoPago !== orden.estado_pago) {
    await executor.run(`UPDATE ordenes SET estado_pago = ? WHERE id = ?`, [estadoPago, ordenId]);
  }

  return estadoPago;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function calcularDescuento(subtotal, tipo = 'ninguno', valor = 0) {
  const base = roundMoney(subtotal);
  const discountType = ['ninguno', 'porcentaje', 'monto'].includes(tipo) ? tipo : 'ninguno';
  const discountValue = Math.max(0, Number(valor) || 0);

  if (discountType === 'ninguno' || base <= 0 || discountValue <= 0) {
    return {
      tipo: 'ninguno',
      valor: 0,
      monto: 0,
      total: base,
    };
  }

  if (discountType === 'porcentaje') {
    const pct = Math.min(100, discountValue);
    const monto = roundMoney(base * (pct / 100));
    return { tipo: discountType, valor: pct, monto, total: roundMoney(base - monto) };
  }

  const monto = Math.min(base, roundMoney(discountValue));
  return { tipo: discountType, valor: monto, monto, total: roundMoney(base - monto) };
}

function normalizarDescuentoOrden(descuento = {}, subtotal = 0) {
  const tipo = String(descuento.tipo || descuento.descuento_tipo || 'ninguno').trim();
  const valor = descuento.valor ?? descuento.descuento_valor ?? 0;
  const motivo = String(descuento.motivo || descuento.descuento_motivo || '').replace(/\s+/g, ' ').trim();
  const calculado = calcularDescuento(subtotal, tipo, valor);

  if (calculado.tipo !== 'ninguno' && calculado.monto > 0 && !motivo) {
    const error = new Error('El motivo del descuento es requerido');
    error.status = 400;
    throw error;
  }

  return { ...calculado, motivo: calculado.tipo === 'ninguno' ? null : motivo };
}

async function recalcularTotalesOrden(ordenId, executor = { get, run }) {
  const orden = await executor.get(`SELECT * FROM ordenes WHERE id = ?`, [ordenId]);
  if (!orden) return null;

  const row = await executor.get(
    `SELECT COALESCE(SUM(precio), 0) AS subtotal FROM orden_estudios WHERE orden_id = ?`,
    [ordenId]
  );
  const subtotal = roundMoney(row?.subtotal || 0);
  const descuento = calcularDescuento(subtotal, orden.descuento_tipo, orden.descuento_valor);
  const pagado = roundMoney(orden.pagado);
  const saldo = Math.max(0, roundMoney(descuento.total - pagado));

  await executor.run(
    `UPDATE ordenes
       SET subtotal = ?, descuento_tipo = ?, descuento_valor = ?, descuento_monto = ?, total = ?, saldo = ?
     WHERE id = ?`,
    [subtotal, descuento.tipo, descuento.valor, descuento.monto, descuento.total, saldo, ordenId]
  );
  await sincronizarEstadoPagoOrden(ordenId, executor);
  return executor.get(`SELECT * FROM ordenes WHERE id = ?`, [ordenId]);
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
    SELECT o.id, o.folio, o.sucursal, o.fecha, o.paciente_id, p.nombre AS paciente_nombre
    FROM ordenes o
    JOIN pacientes p ON p.id = o.paciente_id
    WHERE o.id = ?
  `, [ordenId]);

  if (!orden) throw new Error('Orden no encontrada para generar etiquetas');

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
      tipoMuestra || null,
      tipoTubo || null,
      colorTapa || null,
      areaProceso || null,
      estudiosResumen,
      indiceTubo,
      totalTubosGrupo,
      comparteTubo ? 1 : 0,
      ahoraLocal(),
    ]);

    etiquetas.push({
      etiqueta_uid: etiquetaUid,
      grupo_clave: grupoClave,
      tipo_muestra: tipoMuestra || null,
      tipo_tubo: tipoTubo || null,
      color_tapa: colorTapa || null,
      area_proceso: areaProceso || null,
      estudios_resumen: estudiosResumen,
      indice_tubo: indiceTubo,
      total_tubos_grupo: totalTubosGrupo,
      comparte_tubo: comparteTubo ? 1 : 0,
    });
  };

  for (const estudio of estudios) {
    const tubos = Math.max(1, Number(estudio.tubos_requeridos || 1));
    const comparte = Number(estudio.comparte_tubo || 0) === 1;
    const grupoClave = comparte ? firmaTubosCompartidos(estudio) : null;

    if (comparte) {
      const actual = compartidos.get(grupoClave);
      if (actual) {
        actual.estudios.push(estudio);
        continue;
      }
      compartidos.set(grupoClave, {
        estudio,
        estudios: [estudio],
        tubos,
      });
      continue;
    }

    for (let i = 1; i <= tubos; i += 1) {
      await pushEtiqueta({
        ordenEstudioId: estudio.orden_estudio_id,
        estudioId: estudio.estudio_id,
        tipoMuestra: estudio.tipo_muestra,
        tipoTubo: estudio.tipo_tubo,
        colorTapa: estudio.color_tapa,
        areaProceso: estudio.area_proceso,
        estudiosResumen: estudio.nombre,
        indiceTubo: i,
        totalTubosGrupo: tubos,
      });
    }
  }

  for (const [grupoClave, grupo] of compartidos) {
    const base = grupo.estudio;
    const resumen = grupo.estudios.map((estudio) => estudio.nombre).join(', ');
    const tubos = Math.max(...grupo.estudios.map((estudio) => Number(estudio.tubos_requeridos || 1)));
    for (let i = 1; i <= tubos; i += 1) {
      await pushEtiqueta({
        grupoClave,
        tipoMuestra: base.tipo_muestra,
        tipoTubo: base.tipo_tubo,
        colorTapa: base.color_tapa,
        areaProceso: base.area_proceso,
        estudiosResumen: resumen,
        indiceTubo: i,
        totalTubosGrupo: tubos,
        comparteTubo: 1,
      });
    }
  }

  return etiquetas;
}

async function crearOrdenSegura({
  nombre,
  celular,
  fecha_nacimiento,
  edad,
  sexo,
  sucursal,
  medico,
  medico_telefono,
  estudios,
  descuento = null,
  descuento_usuario_id = null,
  descuento_usuario = null,
}) {
  return withTransaction(async (tx) => {
    const registro = await generarRegistroPaciente(tx);
    const paciente = await tx.run(
      `INSERT INTO pacientes (registro, nombre, celular, fecha_nacimiento, edad, sexo, activo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [registro, nombre, celular || null, fecha_nacimiento || null, edad, sexo, ahoraLocal(), ahoraLocal()]
    );
    const pacienteId = paciente.lastID;

    const folio = await generarFolioEnTx(tx, sucursal);
    const orden = await tx.run(
      `INSERT INTO ordenes (folio, sucursal, paciente_id, medico, medico_telefono, total, pagado, saldo, estado_pago, fecha)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      [folio, sucursal, pacienteId, medico || null, medico_telefono?.trim() || null, ESTADOS_PAGO.PENDIENTE, ahoraLocal()]
    );

    let subtotal = 0;
    for (const estudioId of estudios) {
      const estudio = await tx.get(`SELECT * FROM estudios WHERE id = ?`, [estudioId]);
      if (!estudio) throw new Error(`Estudio no encontrado: ${estudioId}`);
      subtotal += Number(estudio.precio);
      await tx.run(
        `INSERT INTO orden_estudios (orden_id, estudio_id, precio) VALUES (?, ?, ?)`,
        [orden.lastID, estudioId, estudio.precio]
      );
    }

    const subtotalRedondeado = roundMoney(subtotal);
    const descuentoNormalizado = normalizarDescuentoOrden(descuento || {}, subtotalRedondeado);
    await tx.run(
      `UPDATE ordenes
         SET subtotal = ?, descuento_tipo = ?, descuento_valor = ?, descuento_monto = ?,
             descuento_motivo = ?, descuento_usuario_id = ?, descuento_usuario = ?, descuento_fecha = ?,
             total = ?, saldo = ?
       WHERE id = ?`,
      [
        subtotalRedondeado,
        descuentoNormalizado.tipo,
        descuentoNormalizado.valor,
        descuentoNormalizado.monto,
        descuentoNormalizado.motivo,
        descuentoNormalizado.tipo === 'ninguno' ? null : descuento_usuario_id,
        descuentoNormalizado.tipo === 'ninguno' ? null : descuento_usuario,
        descuentoNormalizado.tipo === 'ninguno' ? null : ahoraLocal(),
        descuentoNormalizado.total,
        descuentoNormalizado.total,
        orden.lastID,
      ]
    );
    await sincronizarEstadoPagoOrden(orden.lastID, tx);
    const etiquetas = await regenerarEtiquetasOrden(orden.lastID, tx);
    const empresa = await tx.get(`SELECT * FROM empresa WHERE id = 1`);
    const pacienteCreado = await tx.get(
      `SELECT id, registro, nombre, fecha_nacimiento, edad, sexo FROM pacientes WHERE id = ?`,
      [pacienteId]
    );

    return {
      folio,
      ordenId: orden.lastID,
      subtotal: subtotalRedondeado,
      descuento_monto: descuentoNormalizado.monto,
      total: descuentoNormalizado.total,
      esNuevoPaciente: true,
      etiquetas,
      empresa,
      paciente: pacienteCreado,
    };
  });
}

async function registrarPagoSeguro({ folio, monto, metodo, referencia, cajero }) {
  return withTransaction(async (tx) => {
    const sesion = await tx.get(`
      SELECT * FROM sesiones_caja
      WHERE estado = 'abierta'
      ORDER BY id DESC
      LIMIT 1
    `);
    if (!sesion) {
      const error = new Error('No hay una sesion de caja abierta');
      error.status = 409;
      throw error;
    }

    const orden = await tx.get(`SELECT * FROM ordenes WHERE folio = ?`, [folio]);
    if (!orden) {
      const error = new Error('Orden no encontrada');
      error.status = 404;
      throw error;
    }
    if (Number(orden.saldo) <= 0) {
      const error = new Error('Esta orden ya esta pagada');
      error.status = 400;
      throw error;
    }

    const aplicado = Math.min(monto, Number(orden.saldo));
    const nuevoPagado = Math.round((Number(orden.pagado) + aplicado) * 100) / 100;
    const nuevoSaldo = Math.max(0, Math.round((Number(orden.total) - nuevoPagado) * 100) / 100);

    await tx.run(`UPDATE ordenes SET pagado = ?, saldo = ? WHERE id = ?`, [nuevoPagado, nuevoSaldo, orden.id]);

    const pago = await tx.run(
      `INSERT INTO pagos (orden_id, folio_orden, monto, metodo, referencia, cajero, fecha, sesion_caja_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orden.id, folio, aplicado, metodo, referencia || null, cajero, ahoraLocal(), sesion.id]
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
      const registro = await generarRegistroPaciente(tx);
      const paciente = await tx.run(
        `INSERT INTO pacientes (registro, nombre, celular, edad, sexo, activo, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'O', 1, ?, ?)`,
        [registro, cita.paciente_nombre, cita.paciente_celular || null, ahoraLocal(), ahoraLocal()]
      );
      pacienteId = paciente.lastID;
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
      const estudio = await tx.get(`SELECT * FROM estudios WHERE id = ?`, [eid]);
      if (!estudio) throw new Error(`Estudio no encontrado: ${eid}`);
      total += Number(estudio.precio);
      await tx.run(
        `INSERT INTO orden_estudios (orden_id, estudio_id, precio) VALUES (?, ?, ?)`,
        [orden.lastID, estudio.id, estudio.precio]
      );
    }

    const totalRedondeado = roundMoney(total);
    if (totalRedondeado > 0) {
      await tx.run(`UPDATE ordenes SET subtotal = ?, total = ?, saldo = ? WHERE id = ?`, [totalRedondeado, totalRedondeado, totalRedondeado, orden.lastID]);
    }
    await sincronizarEstadoPagoOrden(orden.lastID, tx);
    await regenerarEtiquetasOrden(orden.lastID, tx);
    await tx.run(
      `UPDATE citas SET orden_id = ?, orden_folio = ?, estado = 'en_curso' WHERE id = ?`,
      [orden.lastID, folio, cita.id]
    );

    return { ok: true, folio, ordenId: orden.lastID, total: totalRedondeado };
  });
}

module.exports = {
  generarRegistroPaciente,
  crearOrdenSegura,
  registrarPagoSeguro,
  crearOrdenDesdeCitaSegura,
  calcularDescuento,
  normalizarDescuentoOrden,
  recalcularTotalesOrden,
};
