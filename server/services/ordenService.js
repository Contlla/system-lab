async function generarRegistroPaciente(executor) {
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

module.exports = { generarRegistroPaciente };
