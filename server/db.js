require('dotenv').config();

const sqlite3 = require('sqlite3').verbose();
const bcrypt  = require('bcrypt');
const path    = require('path');
const seedEstudios = require('./seed-estudios');

const DB_PATH    = process.env.DB_PATH || path.resolve(__dirname, '../database/lab.db');
const SALT_ROUNDS = 10;

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error al conectar con la base de datos:', err.message);
    process.exit(1);
  }
  console.log(`Base de datos conectada: ${DB_PATH}`);
});

/* =========================
   HELPER: run DDL con logging
========================= */
function ddl(sql, description = '') {
  db.run(sql, (err) => {
    if (err) console.error(`Error en DDL${description ? ` (${description})` : ''}: ${err.message}`);
  });
}

/* =========================
   HELPER: migración segura de columna
   SQLite no soporta ADD COLUMN IF NOT EXISTS — ignoramos el error de columna duplicada.
========================= */
function migrateColumn(sql, description = '') {
  db.run(sql, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.error(`Error en migración (${description}): ${err.message}`);
    }
  });
}

function dropColumnIfExists(table, column, description = '') {
  const safeTable = String(table || '').replace(/[^A-Za-z0-9_]/g, '');
  const safeColumn = String(column || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!safeTable || !safeColumn) return;

  db.all(`PRAGMA table_info(${safeTable})`, (err, columns = []) => {
    if (err) {
      console.error(`Error en migracion (${description || `${safeTable}.${safeColumn}`}): ${err.message}`);
      return;
    }
    if (!columns.some((col) => col.name === safeColumn)) return;
    db.run(`ALTER TABLE ${safeTable} DROP COLUMN ${safeColumn}`, (dropErr) => {
      if (dropErr) {
        console.error(`Error en migracion (${description || `${safeTable}.${safeColumn}`}): ${dropErr.message}`);
      }
    });
  });
}

function clearColumnIfExists(table, column, description = '') {
  const safeTable = String(table || '').replace(/[^A-Za-z0-9_]/g, '');
  const safeColumn = String(column || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!safeTable || !safeColumn) return;

  db.all(`PRAGMA table_info(${safeTable})`, (err, columns = []) => {
    if (err) {
      console.error(`Error en migracion (${description || `${safeTable}.${safeColumn}`}): ${err.message}`);
      return;
    }
    if (!columns.some((col) => col.name === safeColumn)) return;
    db.run(`UPDATE ${safeTable} SET ${safeColumn} = NULL`, (clearErr) => {
      if (clearErr) {
        console.error(`Error en migracion (${description || `${safeTable}.${safeColumn}`}): ${clearErr.message}`);
      }
    });
  });
}

function backfillRegistrosPacientes() {
  const year = new Date().getFullYear();
  const prefix = `PAC-${year}-`;

  db.serialize(() => {
    db.get(
      `SELECT MAX(CAST(SUBSTR(registro, LENGTH(?)+1) AS INTEGER)) AS ultimo
       FROM pacientes
       WHERE registro LIKE ?`,
      [prefix, `${prefix}%`],
      (maxErr, row) => {
        if (maxErr) {
          console.error(`Error en migracion (pacientes_backfill_registro_max): ${maxErr.message}`);
          return;
        }

        let siguiente = Number(row?.ultimo || 0) + 1;
        db.all(
          `SELECT id FROM pacientes
           WHERE registro IS NULL OR TRIM(registro) = '' OR TRIM(registro) = '-'
           ORDER BY id ASC`,
          (listErr, pacientes = []) => {
            if (listErr) {
              console.error(`Error en migracion (pacientes_backfill_registro_list): ${listErr.message}`);
              return;
            }

            pacientes.forEach((paciente) => {
              const registro = `${prefix}${String(siguiente).padStart(4, '0')}`;
              siguiente += 1;
              db.run(
                `UPDATE pacientes SET registro = ?, updated_at = COALESCE(updated_at, datetime('now')) WHERE id = ?`,
                [registro, paciente.id],
                (updateErr) => {
                  if (updateErr) {
                    console.error(`Error en migracion (pacientes_backfill_registro_update): ${updateErr.message}`);
                  }
                }
              );
            });
          }
        );
      }
    );
  });
}

const SEED_CATEGORIA_MAP = Object.freeze({
  BIOQUIMICA: 'BIOQUÍMICA',
  BIOLOGIA_MOLECULAR: 'BIOLOGÍA MOLECULAR',
  ENDOCRINOLOGIA: 'ENDOCRINOLOGÍA',
  GENERAL: 'GENERAL',
  HEMATOLOGIA: 'HEMATOLOGÍA',
  INMUNOLOGIA: 'INMUNOLOGÍA',
  MARCADORES_TUMORALES: 'MARCADORES TUMORALES',
  MICROBIOLOGIA: 'MICROBIOLOGÍA',
  PATOLOGIA: 'PATOLOGÍA',
  PERFILES: 'PERFILES',
  QUIMICA_ESPECIAL: 'QUÍMICA ESPECIAL',
  TOXICOLOGIA: 'TOXICOLOGÍA',
  UROANALISIS: 'UROANÁLISIS',
  OTROS: 'OTROS'
});

function canonicalSeedText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSeedCategoria(value) {
  return SEED_CATEGORIA_MAP[String(value || '').trim().toUpperCase()] || 'GENERAL';
}

function migrateResultadoArchivosTable() {
  db.all(`PRAGMA table_info(resultado_archivos)`, (err, columns = []) => {
    if (err) {
      console.error(`Error en migracion (resultado_archivos_table_info): ${err.message}`);
      return;
    }
    if (!columns.length) return;

    const estudioColumn = columns.find((column) => column.name === 'estudio_id');
    const estudioNotNull = estudioColumn ? Number(estudioColumn.notnull) === 1 : false;

    db.all(`PRAGMA index_list(resultado_archivos)`, (idxErr, indexes = []) => {
      if (idxErr) {
        console.error(`Error en migracion (resultado_archivos_index_list): ${idxErr.message}`);
        return;
      }

      const hasUniqueIndex = indexes.some((index) => Number(index.unique) === 1);
      if (!estudioNotNull && !hasUniqueIndex) return;

      db.serialize(() => {
        db.run(`ALTER TABLE resultado_archivos RENAME TO resultado_archivos_old`, (renameErr) => {
          if (renameErr) {
            console.error(`Error en migracion (resultado_archivos_rename): ${renameErr.message}`);
            return;
          }

          db.run(`
            CREATE TABLE resultado_archivos (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              orden_id        INTEGER NOT NULL,
              estudio_id      INTEGER,
              archivo_url     TEXT    NOT NULL,
              archivo_path    TEXT,
              archivo_nombre  TEXT    NOT NULL,
              resultado_uuid  TEXT,
              r2_key          TEXT,
              r2_url          TEXT,
              qr_base64       TEXT,
              documento_tipo  TEXT    NOT NULL DEFAULT 'principal',
              fecha           TEXT    NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY (orden_id)   REFERENCES ordenes(id)  ON DELETE CASCADE ON UPDATE CASCADE,
              FOREIGN KEY (estudio_id) REFERENCES estudios(id) ON DELETE CASCADE ON UPDATE CASCADE
            )
          `, (createErr) => {
            if (createErr) {
              console.error(`Error en migracion (resultado_archivos_create): ${createErr.message}`);
              return;
            }

            db.run(`
              INSERT INTO resultado_archivos (
                id, orden_id, estudio_id, archivo_url, archivo_path, archivo_nombre,
                resultado_uuid, r2_key, r2_url, qr_base64, fecha
              )
              SELECT
                id, orden_id, estudio_id, archivo_url, archivo_path, archivo_nombre,
                NULL, NULL, NULL, NULL, fecha
              FROM resultado_archivos_old
            `, (copyErr) => {
              if (copyErr) {
                console.error(`Error en migracion (resultado_archivos_copy): ${copyErr.message}`);
                return;
              }

              db.run(`DROP TABLE resultado_archivos_old`, (dropErr) => {
                if (dropErr) {
                  console.error(`Error en migracion (resultado_archivos_drop_old): ${dropErr.message}`);
                  return;
                }

                db.run(`CREATE INDEX IF NOT EXISTS idx_res_arch_orden ON resultado_archivos(orden_id)`, (indexErr) => {
                  if (indexErr) {
                    console.error(`Error en migracion (resultado_archivos_idx_orden): ${indexErr.message}`);
                  }
                });
                db.run(`
                  CREATE UNIQUE INDEX IF NOT EXISTS idx_resultado_archivos_uuid
                  ON resultado_archivos(resultado_uuid)
                  WHERE resultado_uuid IS NOT NULL AND TRIM(resultado_uuid) <> ''
                `, (uuidIndexErr) => {
                  if (uuidIndexErr) {
                    console.error(`Error en migracion (resultado_archivos_idx_uuid): ${uuidIndexErr.message}`);
                  }
                });
              });
            });
          });
        });
      });
    });
  });
}

db.serialize(async () => {

  ddl(`PRAGMA foreign_keys = ON`,  'foreign_keys');
  ddl(`PRAGMA journal_mode = WAL`, 'journal_mode');

  /* =========================
    PAGOS
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS pagos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id    INTEGER NOT NULL,
      folio_orden TEXT    NOT NULL,
      monto       REAL    NOT NULL CHECK(monto > 0),
      metodo      TEXT    NOT NULL CHECK(metodo IN ('efectivo','tarjeta','transferencia')),
      referencia  TEXT,
      cajero      TEXT    NOT NULL,
      fecha       TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE CASCADE
    )
  `, 'pagos');

  ddl(`CREATE INDEX IF NOT EXISTS idx_pagos_orden ON pagos(orden_id)`, 'idx_pagos_orden');
  ddl(`CREATE INDEX IF NOT EXISTS idx_pagos_fecha ON pagos(fecha)`,    'idx_pagos_fecha');

  /* =========================
    SESIONES DE CAJA
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS sesiones_caja (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      estado                  TEXT    NOT NULL DEFAULT 'abierta' CHECK(estado IN ('abierta','cerrada')),
      cajero_apertura         TEXT    NOT NULL,
      cajero_cierre           TEXT,
      fecha_apertura          TEXT    NOT NULL DEFAULT (datetime('now')),
      fecha_cierre            TEXT,
      saldo_inicial           REAL    NOT NULL DEFAULT 0,
      saldo_cierre            REAL,
      observaciones_apertura  TEXT,
      observaciones_cierre    TEXT,
      created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `, 'sesiones_caja');

  ddl(`CREATE INDEX IF NOT EXISTS idx_sesiones_caja_estado ON sesiones_caja(estado)`, 'idx_sesiones_caja_estado');
  ddl(`CREATE INDEX IF NOT EXISTS idx_sesiones_caja_fecha_apertura ON sesiones_caja(fecha_apertura)`, 'idx_sesiones_caja_fecha_apertura');
  ddl(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sesiones_caja_abierta_unique ON sesiones_caja(estado) WHERE estado = 'abierta'`, 'idx_sesiones_caja_abierta_unique');

  migrateColumn(`ALTER TABLE pagos ADD COLUMN sesion_caja_id INTEGER`, 'pagos_add_sesion_caja_id');
  ddl(`CREATE INDEX IF NOT EXISTS idx_pagos_sesion_caja ON pagos(sesion_caja_id)`, 'idx_pagos_sesion_caja');

  /* =========================
    CORTES DE CAJA
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS cortes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cajero          TEXT    NOT NULL,
      fecha_inicio    TEXT    NOT NULL,
      fecha_fin       TEXT    NOT NULL DEFAULT (datetime('now')),
      total_efectivo  REAL    NOT NULL DEFAULT 0,
      total_tarjeta   REAL    NOT NULL DEFAULT 0,
      total_transferencia REAL NOT NULL DEFAULT 0,
      total_general   REAL    NOT NULL DEFAULT 0,
      num_pagos       INTEGER NOT NULL DEFAULT 0,
      observaciones   TEXT
    )
  `, 'cortes');

  migrateColumn(`ALTER TABLE cortes ADD COLUMN sesion_caja_id INTEGER`, 'cortes_add_sesion_caja_id');
  ddl(`CREATE INDEX IF NOT EXISTS idx_cortes_sesion_caja ON cortes(sesion_caja_id)`, 'idx_cortes_sesion_caja');

  /* =========================
     USUARIOS
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario  TEXT    NOT NULL UNIQUE,
      password TEXT    NOT NULL,
      role     TEXT    NOT NULL CHECK(role IN ('admin', 'laboratorio', 'recepcion')),
      permissions TEXT
    )
  `, 'usuarios');
  migrateColumn(`ALTER TABLE usuarios ADD COLUMN permissions TEXT`, 'usuarios_add_permissions');

  /* =========================
     PACIENTES
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS pacientes (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      registro TEXT    UNIQUE,
      nombre   TEXT    NOT NULL,
      celular  TEXT,
      correo   TEXT,
      direccion TEXT,
      observaciones TEXT,
      fecha_nacimiento TEXT,
      edad     INTEGER,
      sexo     TEXT    CHECK(sexo IN ('M', 'F', 'O')),
      activo   INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    )
  `, 'pacientes');
  migrateColumn(`ALTER TABLE pacientes ADD COLUMN fecha_nacimiento TEXT`, 'pacientes_add_fecha_nacimiento');
  migrateColumn(`ALTER TABLE pacientes ADD COLUMN correo TEXT`, 'pacientes_add_correo');
  migrateColumn(`ALTER TABLE pacientes ADD COLUMN direccion TEXT`, 'pacientes_add_direccion');
  migrateColumn(`ALTER TABLE pacientes ADD COLUMN observaciones TEXT`, 'pacientes_add_observaciones');
  migrateColumn(`ALTER TABLE pacientes ADD COLUMN activo INTEGER NOT NULL DEFAULT 1`, 'pacientes_add_activo');
  migrateColumn(`ALTER TABLE pacientes ADD COLUMN created_at TEXT`, 'pacientes_add_created_at');
  migrateColumn(`ALTER TABLE pacientes ADD COLUMN updated_at TEXT`, 'pacientes_add_updated_at');
  ddl(`UPDATE pacientes SET activo = 1 WHERE activo IS NULL`, 'pacientes_activo_default');
  ddl(`UPDATE pacientes SET created_at = COALESCE(created_at, datetime('now')), updated_at = COALESCE(updated_at, datetime('now'))`, 'pacientes_timestamps_default');
  backfillRegistrosPacientes();
  clearColumnIfExists('pacientes', 'dni', 'pacientes_clear_dni');
  dropColumnIfExists('pacientes', 'dni', 'pacientes_drop_dni');

  /* =========================
     ORDENES
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS ordenes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      folio            TEXT    NOT NULL UNIQUE,
      sucursal         TEXT    NOT NULL,
      paciente_id      INTEGER NOT NULL,
      medico           TEXT,
      medico_telefono  TEXT,
      total            REAL    NOT NULL DEFAULT 0,
      pagado           REAL    NOT NULL DEFAULT 0,
      saldo            REAL    NOT NULL DEFAULT 0,
      estado_pago      TEXT    NOT NULL DEFAULT 'pendiente'
                               CHECK(estado_pago IN ('pendiente', 'parcial', 'pagado')),
      estado           TEXT    NOT NULL DEFAULT 'pendiente'
                               CHECK(estado IN ('pendiente', 'en_proceso', 'completado', 'cancelado')),
      fecha            TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (paciente_id)
        REFERENCES pacientes(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
    )
  `, 'ordenes');

  /*
   * ─── MIGRACIÓN: agregar medico_telefono a tablas existentes ───────────────
   * Instrucción ALTER TABLE para bases de datos ya desplegadas:
   *   ALTER TABLE ordenes ADD COLUMN medico_telefono TEXT;
   */
  migrateColumn(
    `ALTER TABLE ordenes ADD COLUMN medico_telefono TEXT`,
    'ordenes_add_medico_telefono'
  );
  migrateColumn(
    `ALTER TABLE ordenes ADD COLUMN estado_pago TEXT NOT NULL DEFAULT 'pendiente'`,
    'ordenes_add_estado_pago'
  );

  ddl(`CREATE INDEX IF NOT EXISTS idx_ordenes_folio    ON ordenes(folio)`,       'idx_ordenes_folio');
  ddl(`CREATE INDEX IF NOT EXISTS idx_ordenes_fecha    ON ordenes(fecha)`,       'idx_ordenes_fecha');
  ddl(`CREATE INDEX IF NOT EXISTS idx_ordenes_sucursal ON ordenes(sucursal)`,    'idx_ordenes_sucursal');
  ddl(`CREATE INDEX IF NOT EXISTS idx_ordenes_paciente ON ordenes(paciente_id)`, 'idx_ordenes_paciente');
  ddl(`CREATE INDEX IF NOT EXISTS idx_ordenes_estado   ON ordenes(estado)`,      'idx_ordenes_estado');
  ddl(`CREATE INDEX IF NOT EXISTS idx_ordenes_estado_pago ON ordenes(estado_pago)`, 'idx_ordenes_estado_pago');

  /* =========================
     ESTUDIOS (CATÁLOGO)
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS estudios (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clave_externa TEXT,
      nombre       TEXT    NOT NULL UNIQUE,
      nombre_corto TEXT,
      precio       REAL    NOT NULL CHECK(precio >= 0),
      categoria    TEXT    NOT NULL DEFAULT 'OTROS',
      subcategoria TEXT,
      sinonimos_busqueda TEXT,
      indicaciones TEXT,
      tipo_muestra TEXT,
      tipo_tubo TEXT,
      color_tapa TEXT,
      tubos_requeridos INTEGER NOT NULL DEFAULT 1,
      area_proceso TEXT,
      comparte_tubo INTEGER NOT NULL DEFAULT 0
    )
  `, 'estudios');

  // Migración: columnas para tablas ya existentes
  migrateColumn(`ALTER TABLE estudios ADD COLUMN categoria    TEXT NOT NULL DEFAULT 'OTROS'`, 'estudios_add_categoria');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN indicaciones TEXT`,                          'estudios_add_indicaciones');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN clave_externa TEXT`,                         'estudios_add_clave_externa');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN nombre_corto TEXT`,                          'estudios_add_nombre_corto');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN subcategoria TEXT`,                          'estudios_add_subcategoria');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN sinonimos_busqueda TEXT`,                    'estudios_add_sinonimos_busqueda');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN tipo_muestra TEXT`,                         'estudios_add_tipo_muestra');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN tipo_tubo TEXT`,                            'estudios_add_tipo_tubo');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN color_tapa TEXT`,                           'estudios_add_color_tapa');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN tubos_requeridos INTEGER NOT NULL DEFAULT 1`, 'estudios_add_tubos_requeridos');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN area_proceso TEXT`,                         'estudios_add_area_proceso');
  migrateColumn(`ALTER TABLE estudios ADD COLUMN comparte_tubo INTEGER NOT NULL DEFAULT 0`, 'estudios_add_comparte_tubo');

  /*
   * ─── ÍNDICE DE RENDIMIENTO para búsqueda de estudios ──────────────────────
   * Con cientos de estudios, este índice hace que el live-search sea instantáneo.
   */
  ddl(`CREATE INDEX IF NOT EXISTS idx_estudios_nombre    ON estudios(nombre)`,    'idx_estudios_nombre');
  ddl(`CREATE INDEX IF NOT EXISTS idx_estudios_categoria ON estudios(categoria)`, 'idx_estudios_categoria');

  /* =========================
     RELACIÓN ORDEN - ESTUDIOS
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS orden_estudios (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id   INTEGER NOT NULL,
      estudio_id INTEGER NOT NULL,
      precio     REAL    NOT NULL CHECK(precio >= 0),
      FOREIGN KEY (orden_id)   REFERENCES ordenes(id)  ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (estudio_id) REFERENCES estudios(id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `, 'orden_estudios');

  ddl(`CREATE INDEX IF NOT EXISTS idx_orden_estudios_orden ON orden_estudios(orden_id)`, 'idx_orden_estudios_orden');

  /* =========================
     ETIQUETAS / TUBOS POR ORDEN
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS orden_tubos (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id           INTEGER NOT NULL,
      folio_orden        TEXT    NOT NULL,
      paciente_id        INTEGER NOT NULL,
      orden_estudio_id   INTEGER,
      estudio_id         INTEGER,
      grupo_clave        TEXT,
      etiqueta_uid       TEXT    NOT NULL,
      tipo_muestra       TEXT,
      tipo_tubo          TEXT,
      color_tapa         TEXT,
      area_proceso       TEXT,
      estudios_resumen   TEXT    NOT NULL,
      indice_tubo        INTEGER NOT NULL DEFAULT 1,
      total_tubos_grupo  INTEGER NOT NULL DEFAULT 1,
      comparte_tubo      INTEGER NOT NULL DEFAULT 0,
      impreso            INTEGER NOT NULL DEFAULT 0,
      impreso_en         TEXT,
      reimpresiones      INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (orden_id)         REFERENCES ordenes(id)        ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (paciente_id)      REFERENCES pacientes(id)      ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (orden_estudio_id) REFERENCES orden_estudios(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (estudio_id)       REFERENCES estudios(id)       ON DELETE CASCADE ON UPDATE CASCADE
    )
  `, 'orden_tubos');

  ddl(`CREATE INDEX IF NOT EXISTS idx_orden_tubos_orden ON orden_tubos(orden_id)`, 'idx_orden_tubos_orden');
  ddl(`CREATE INDEX IF NOT EXISTS idx_orden_tubos_folio ON orden_tubos(folio_orden)`, 'idx_orden_tubos_folio');

  /* =========================
     RESULTADOS (texto / valores)
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS resultados (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id   INTEGER NOT NULL,
      estudio_id INTEGER NOT NULL,
      resultado  TEXT,
      unidades   TEXT,
      referencia TEXT,
      fecha      TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (orden_id)   REFERENCES ordenes(id)  ON DELETE CASCADE,
      FOREIGN KEY (estudio_id) REFERENCES estudios(id) ON DELETE CASCADE
    )
  `, 'resultados');

  /* =========================
     RESULTADO_ARCHIVOS
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS resultado_archivos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id        INTEGER NOT NULL,
      estudio_id      INTEGER,
      archivo_url     TEXT    NOT NULL,
      archivo_path    TEXT,
      archivo_nombre  TEXT    NOT NULL,
      resultado_uuid  TEXT,
      r2_key          TEXT,
      r2_url          TEXT,
      qr_base64       TEXT,
      documento_tipo  TEXT    NOT NULL DEFAULT 'principal',
      fecha           TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (orden_id)   REFERENCES ordenes(id)  ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (estudio_id) REFERENCES estudios(id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `, 'resultado_archivos');

  ddl(`CREATE INDEX IF NOT EXISTS idx_res_arch_orden ON resultado_archivos(orden_id)`, 'idx_res_arch_orden');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN archivo_path TEXT`, 'resultado_archivos_add_archivo_path');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN resultado_uuid TEXT`, 'resultado_archivos_add_resultado_uuid');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN r2_key TEXT`, 'resultado_archivos_add_r2_key');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN r2_url TEXT`, 'resultado_archivos_add_r2_url');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN qr_base64 TEXT`, 'resultado_archivos_add_qr_base64');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN documento_tipo TEXT NOT NULL DEFAULT 'principal'`, 'resultado_archivos_add_documento_tipo');
  ddl(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_resultado_archivos_uuid
     ON resultado_archivos(resultado_uuid)
     WHERE resultado_uuid IS NOT NULL AND TRIM(resultado_uuid) <> ''`,
    'idx_resultado_archivos_uuid'
  );
  ddl(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_resultado_archivos_principal_estudio
     ON resultado_archivos(orden_id, estudio_id)
     WHERE documento_tipo = 'principal' AND estudio_id IS NOT NULL`,
    'idx_resultado_archivos_principal_estudio'
  );
  ddl(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_resultado_archivos_principal_orden
     ON resultado_archivos(orden_id)
     WHERE documento_tipo = 'principal' AND estudio_id IS NULL`,
    'idx_resultado_archivos_principal_orden'
  );
  migrateResultadoArchivosTable();
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN resultado_uuid TEXT`, 'resultado_archivos_repair_resultado_uuid');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN r2_key TEXT`, 'resultado_archivos_repair_r2_key');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN r2_url TEXT`, 'resultado_archivos_repair_r2_url');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN qr_base64 TEXT`, 'resultado_archivos_repair_qr_base64');
  migrateColumn(`ALTER TABLE resultado_archivos ADD COLUMN documento_tipo TEXT NOT NULL DEFAULT 'principal'`, 'resultado_archivos_repair_documento_tipo');

  /* =========================
     EMPRESA
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS empresa (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre    TEXT    NOT NULL DEFAULT 'Mi Laboratorio',
      direccion TEXT,
      ruc       TEXT,
      rfc       TEXT,
      telefono  TEXT,
      correo    TEXT,
      logo      TEXT,
      updated_at TEXT   DEFAULT (datetime('now'))
    )
  `, 'empresa');

  migrateColumn(`ALTER TABLE empresa ADD COLUMN updated_at TEXT`, 'empresa_add_updated_at');
  ddl(`INSERT OR IGNORE INTO empresa (id, nombre) VALUES (1, 'Mi Laboratorio')`, 'seed empresa');
  ddl(`UPDATE empresa SET updated_at = COALESCE(updated_at, datetime('now')) WHERE updated_at IS NULL`, 'empresa_seed_updated_at');


  /* =========================
     SEED: ESTUDIOS
  ========================= */
 

  ddl(`
    UPDATE estudios
    SET categoria = CASE categoria
      WHEN 'BIOQUÃMICA' THEN 'BIOQUÍMICA'
      WHEN 'ENDOCRINOLOGÃA' THEN 'ENDOCRINOLOGÍA'
      WHEN 'HEMATOLOGÃA' THEN 'HEMATOLOGÍA'
      WHEN 'INMUNOLOGÃA' THEN 'INMUNOLOGÍA'
      WHEN 'MICROBIOLOGÃA' THEN 'MICROBIOLOGÍA'
      WHEN 'PATOLOGÃA' THEN 'PATOLOGÍA'
      WHEN 'QUÃMICA ESPECIAL' THEN 'QUÍMICA ESPECIAL'
      WHEN 'TOXICOLOGÃA' THEN 'TOXICOLOGÍA'
      WHEN 'UROANÃLISIS' THEN 'UROANÁLISIS'
      ELSE categoria
    END
    WHERE categoria IN (
      'BIOQUÃMICA',
      'ENDOCRINOLOGÃA',
      'HEMATOLOGÃA',
      'INMUNOLOGÃA',
      'MICROBIOLOGÃA',
      'PATOLOGÃA',
      'QUÃMICA ESPECIAL',
      'TOXICOLOGÃA',
      'UROANÃLISIS'
    )
  `, 'seed estudios normaliza categorias');

  ddl(`
    UPDATE estudios
    SET categoria = 'MARCADORES TUMORALES'
    WHERE nombre IN (
      'Alfa - Fetoproteína (AFP)',
      'Antígeno Carcinoembrionario (CEA)',
      'Antígeno prostático específico (PSA) libre',
      'Antígeno prostático específico (PSA) total',
      'Antígeno prostático total + libre',
      'CEA (Antígeno carcinoembionario)',
      'Fosfatasa ácida prostática'
    )
       OR nombre LIKE '%(AFP)%'
       OR nombre LIKE '%(CEA)%'
       OR nombre LIKE '%PSA%'
       OR (nombre LIKE '%Fosfatasa%' AND nombre LIKE '%prost%')
  `, 'seed estudios corrige marcadores tumorales');

  ddl(`
    UPDATE estudios
    SET
      tubos_requeridos = CASE
        WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1
        ELSE tubos_requeridos
      END,
      comparte_tubo = COALESCE(comparte_tubo, 0)
    WHERE
      tubos_requeridos IS NULL
      OR tubos_requeridos < 1
      OR comparte_tubo IS NULL
  `, 'seed estudios defaults etiquetas');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE WHEN COALESCE(tipo_muestra, '') = '' THEN 'Orina de 24 horas' ELSE tipo_muestra END,
      tipo_tubo = CASE WHEN COALESCE(tipo_tubo, '') = '' THEN 'Recipiente de 24 horas' ELSE tipo_tubo END,
      color_tapa = CASE WHEN COALESCE(color_tapa, '') = '' THEN 'Sin tapa' ELSE color_tapa END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Uroanalisis' ELSE area_proceso END,
      comparte_tubo = CASE WHEN comparte_tubo IS NULL THEN 0 ELSE comparte_tubo END
    WHERE LOWER(nombre) LIKE '%orina de 24%'
       OR LOWER(nombre) LIKE '%orina 24%'
  `, 'seed estudios etiquetas orina 24h');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE WHEN COALESCE(tipo_muestra, '') = '' THEN 'Orina' ELSE tipo_muestra END,
      tipo_tubo = CASE WHEN COALESCE(tipo_tubo, '') = '' THEN 'Frasco esteril' ELSE tipo_tubo END,
      color_tapa = CASE WHEN COALESCE(color_tapa, '') = '' THEN 'Amarilla' ELSE color_tapa END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Uroanalisis' ELSE area_proceso END,
      comparte_tubo = 0
    WHERE categoria = 'UROANÁLISIS'
      AND NOT (LOWER(nombre) LIKE '%orina de 24%' OR LOWER(nombre) LIKE '%orina 24%')
  `, 'seed estudios etiquetas uroanalisis');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE WHEN COALESCE(tipo_muestra, '') = '' THEN 'Heces' ELSE tipo_muestra END,
      tipo_tubo = CASE WHEN COALESCE(tipo_tubo, '') = '' THEN 'Frasco esteril' ELSE tipo_tubo END,
      color_tapa = CASE WHEN COALESCE(color_tapa, '') = '' THEN 'Cafe' ELSE color_tapa END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Microbiologia' ELSE area_proceso END,
      comparte_tubo = 0
    WHERE LOWER(nombre) LIKE 'copro%'
       OR LOWER(nombre) LIKE '%heces%'
  `, 'seed estudios etiquetas heces');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE WHEN COALESCE(tipo_muestra, '') = '' THEN 'Sangre arterial o venosa' ELSE tipo_muestra END,
      tipo_tubo = CASE WHEN COALESCE(tipo_tubo, '') = '' THEN 'Jeringa heparinizada' ELSE tipo_tubo END,
      color_tapa = CASE WHEN COALESCE(color_tapa, '') = '' THEN 'Verde' ELSE color_tapa END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Quimica especial' ELSE area_proceso END,
      comparte_tubo = 0
    WHERE LOWER(nombre) LIKE 'gasometr%'
  `, 'seed estudios etiquetas gasometria');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE WHEN COALESCE(tipo_muestra, '') = '' THEN 'Sangre total' ELSE tipo_muestra END,
      tipo_tubo = CASE WHEN COALESCE(tipo_tubo, '') = '' THEN 'EDTA' ELSE tipo_tubo END,
      color_tapa = CASE WHEN COALESCE(color_tapa, '') = '' THEN 'Lila' ELSE color_tapa END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Hematologia' ELSE area_proceso END,
      comparte_tubo = CASE WHEN comparte_tubo IS NULL OR comparte_tubo = 0 THEN 1 ELSE comparte_tubo END
    WHERE categoria = 'HEMATOLOGÍA'
  `, 'seed estudios etiquetas hematologia');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE WHEN COALESCE(tipo_muestra, '') = '' THEN 'Muestra clinica' ELSE tipo_muestra END,
      tipo_tubo = CASE WHEN COALESCE(tipo_tubo, '') = '' THEN 'Contenedor esteril' ELSE tipo_tubo END,
      color_tapa = CASE WHEN COALESCE(color_tapa, '') = '' THEN 'Segun muestra' ELSE color_tapa END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Microbiologia' ELSE area_proceso END,
      comparte_tubo = 0
    WHERE categoria = 'MICROBIOLOGÍA'
      AND COALESCE(tipo_muestra, '') = ''
  `, 'seed estudios etiquetas microbiologia');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE WHEN COALESCE(tipo_muestra, '') = '' THEN 'Suero' ELSE tipo_muestra END,
      tipo_tubo = CASE WHEN COALESCE(tipo_tubo, '') = '' THEN 'Tubo seco / SST' ELSE tipo_tubo END,
      color_tapa = CASE WHEN COALESCE(color_tapa, '') = '' THEN 'Roja o dorada' ELSE color_tapa END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE
        WHEN COALESCE(area_proceso, '') <> '' THEN area_proceso
        WHEN categoria = 'BIOQUÍMICA' THEN 'Quimica clinica'
        WHEN categoria = 'ENDOCRINOLOGÍA' THEN 'Endocrinologia'
        WHEN categoria = 'INMUNOLOGÍA' THEN 'Inmunologia'
        WHEN categoria = 'MARCADORES TUMORALES' THEN 'Marcadores tumorales'
        WHEN categoria = 'PERFILES' THEN 'Perfiles'
        WHEN categoria = 'GENERAL' THEN 'Procesamiento general'
        ELSE area_proceso
      END,
      comparte_tubo = CASE WHEN comparte_tubo IS NULL OR comparte_tubo = 0 THEN 1 ELSE comparte_tubo END
    WHERE categoria IN ('BIOQUÍMICA', 'ENDOCRINOLOGÍA', 'INMUNOLOGÍA', 'MARCADORES TUMORALES', 'PERFILES', 'GENERAL')
      AND COALESCE(tipo_muestra, '') = ''
  `, 'seed estudios etiquetas suero');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE
        WHEN LOWER(nombre) LIKE '%vph%' OR LOWER(nombre) LIKE '%papovavirus%' THEN 'Cepillado cervicovaginal / exudado'
        WHEN LOWER(nombre) LIKE '%mycoplasma genitalium%' THEN 'Exudado urogenital / orina primer chorro'
        WHEN LOWER(nombre) LIKE '%mycobacterium tuberculosis%' THEN 'Esputo / muestra respiratoria'
        WHEN LOWER(nombre) LIKE '%perfil infeccioso por pcr%' THEN 'Exudado / muestra segun panel'
        ELSE 'Sangre total con EDTA / plasma'
      END,
      tipo_tubo = CASE
        WHEN LOWER(nombre) LIKE '%vph%' OR LOWER(nombre) LIKE '%papovavirus%' THEN 'Medio de transporte molecular'
        WHEN LOWER(nombre) LIKE '%mycoplasma genitalium%' THEN 'Contenedor esteril / medio PCR'
        WHEN LOWER(nombre) LIKE '%mycobacterium tuberculosis%' THEN 'Contenedor esteril'
        WHEN LOWER(nombre) LIKE '%perfil infeccioso por pcr%' THEN 'Contenedor esteril / medio de transporte'
        ELSE 'EDTA'
      END,
      color_tapa = CASE
        WHEN LOWER(nombre) LIKE '%vph%' OR LOWER(nombre) LIKE '%papovavirus%' THEN 'Sin color estandar'
        WHEN LOWER(nombre) LIKE '%mycoplasma genitalium%' THEN 'Sin color estandar'
        WHEN LOWER(nombre) LIKE '%mycobacterium tuberculosis%' THEN 'Sin color estandar'
        WHEN LOWER(nombre) LIKE '%perfil infeccioso por pcr%' THEN 'Sin color estandar'
        ELSE 'Lila'
      END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Biologia molecular' ELSE area_proceso END,
      comparte_tubo = 0
    WHERE categoria = 'BIOLOGÍA MOLECULAR'
      AND (
        COALESCE(tipo_muestra, '') = ''
        OR COALESCE(tipo_tubo, '') = ''
        OR COALESCE(color_tapa, '') = ''
        OR COALESCE(area_proceso, '') = ''
      )
  `, 'seed estudios etiquetas biologia molecular');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE
        WHEN LOWER(nombre) LIKE 'biopsia%' OR LOWER(nombre) LIKE 'baaf%' THEN 'Tejido / aspirado'
        WHEN LOWER(nombre) LIKE '%papanicolaou%' THEN 'Muestra cervicovaginal'
        WHEN LOWER(nombre) LIKE '%citologia nasal%' OR LOWER(nombre) LIKE '%moco nasal%' THEN 'Moco nasal'
        WHEN LOWER(nombre) LIKE '%citologia uretral%' THEN 'Exudado uretral'
        WHEN LOWER(nombre) LIKE '%moco fecal%' THEN 'Moco fecal'
        WHEN LOWER(nombre) LIKE '%liquido cefalorraquideo%' THEN 'Liquido cefalorraquideo'
        WHEN LOWER(nombre) LIKE '%liquidos corporales%' THEN 'Liquido corporal'
        WHEN LOWER(nombre) LIKE '%calculo renal%' OR LOWER(nombre) LIKE '%biliar%' THEN 'Calculo / pieza'
        ELSE 'Muestra citologica / tejido'
      END,
      tipo_tubo = CASE
        WHEN LOWER(nombre) LIKE 'biopsia%' THEN 'Frasco con formol 10%'
        WHEN LOWER(nombre) LIKE 'baaf%' THEN 'Portaobjetos / frasco citologico'
        WHEN LOWER(nombre) LIKE '%papanicolaou%' THEN 'Medio citologico / laminilla'
        WHEN LOWER(nombre) LIKE '%citologia%' THEN 'Portaobjetos / frasco citologico'
        WHEN LOWER(nombre) LIKE '%liquido cefalorraquideo%' OR LOWER(nombre) LIKE '%liquidos corporales%' THEN 'Tubo esteril'
        WHEN LOWER(nombre) LIKE '%calculo renal%' OR LOWER(nombre) LIKE '%biliar%' THEN 'Contenedor seco'
        ELSE 'Contenedor patologico'
      END,
      color_tapa = CASE
        WHEN LOWER(nombre) LIKE '%liquido cefalorraquideo%' OR LOWER(nombre) LIKE '%liquidos corporales%' THEN 'Roja / esteril'
        ELSE 'Sin color estandar'
      END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Patologia y citologia' ELSE area_proceso END,
      comparte_tubo = 0
    WHERE categoria = 'PATOLOGÍA'
      AND (
        COALESCE(tipo_muestra, '') = ''
        OR COALESCE(tipo_tubo, '') = ''
        OR COALESCE(color_tapa, '') = ''
        OR COALESCE(area_proceso, '') = ''
      )
  `, 'seed estudios etiquetas patologia');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE
        WHEN LOWER(nombre) LIKE '%osmolaridad urinaria%' THEN 'Orina'
        ELSE 'Suero'
      END,
      tipo_tubo = CASE
        WHEN LOWER(nombre) LIKE '%osmolaridad urinaria%' THEN 'Frasco esteril'
        ELSE 'Tubo seco / SST'
      END,
      color_tapa = CASE
        WHEN LOWER(nombre) LIKE '%osmolaridad urinaria%' THEN 'Amarilla'
        ELSE 'Roja o dorada'
      END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Quimica especial' ELSE area_proceso END,
      comparte_tubo = CASE
        WHEN LOWER(nombre) LIKE '%osmolaridad urinaria%' THEN 0
        ELSE 1
      END
    WHERE categoria = 'QUÍMICA ESPECIAL'
      AND (
        COALESCE(tipo_muestra, '') = ''
        OR COALESCE(tipo_tubo, '') = ''
        OR COALESCE(color_tapa, '') = ''
        OR COALESCE(area_proceso, '') = ''
      )
  `, 'seed estudios etiquetas quimica especial');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = 'Orina',
      tipo_tubo = 'Frasco esteril',
      color_tapa = 'Amarilla',
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Toxicologia' ELSE area_proceso END,
      comparte_tubo = 0
    WHERE categoria = 'TOXICOLOGÍA'
      AND (
        LOWER(nombre) LIKE '%anfetamin%'
        OR LOWER(nombre) LIKE '%barbit%'
        OR LOWER(nombre) LIKE '%benzodiazep%'
        OR LOWER(nombre) LIKE '%cannabino%'
        OR LOWER(nombre) LIKE '%cocain%'
        OR LOWER(nombre) LIKE '%opiace%'
      )
      AND (
        COALESCE(tipo_muestra, '') = ''
        OR COALESCE(tipo_tubo, '') = ''
        OR COALESCE(color_tapa, '') = ''
        OR COALESCE(area_proceso, '') = ''
      )
  `, 'seed estudios etiquetas toxicologia orina');

  ddl(`
    UPDATE estudios
    SET
      tipo_muestra = CASE
        WHEN LOWER(nombre) LIKE '%alcohol en suero%' THEN 'Suero'
        ELSE 'Suero / plasma'
      END,
      tipo_tubo = CASE
        WHEN LOWER(nombre) LIKE '%ciclosporina%' OR LOWER(nombre) LIKE '%sirolimus%' OR LOWER(nombre) LIKE '%tacrolimus%' THEN 'EDTA'
        WHEN LOWER(nombre) LIKE '%litio%' THEN 'Tubo seco / SST'
        ELSE 'Tubo seco / SST'
      END,
      color_tapa = CASE
        WHEN LOWER(nombre) LIKE '%ciclosporina%' OR LOWER(nombre) LIKE '%sirolimus%' OR LOWER(nombre) LIKE '%tacrolimus%' THEN 'Lila'
        ELSE 'Roja o dorada'
      END,
      tubos_requeridos = CASE WHEN tubos_requeridos IS NULL OR tubos_requeridos < 1 THEN 1 ELSE tubos_requeridos END,
      area_proceso = CASE WHEN COALESCE(area_proceso, '') = '' THEN 'Toxicologia' ELSE area_proceso END,
      comparte_tubo = 0
    WHERE categoria = 'TOXICOLOGÍA'
      AND NOT (
        LOWER(nombre) LIKE '%anfetamin%'
        OR LOWER(nombre) LIKE '%barbit%'
        OR LOWER(nombre) LIKE '%benzodiazep%'
        OR LOWER(nombre) LIKE '%cannabino%'
        OR LOWER(nombre) LIKE '%cocain%'
        OR LOWER(nombre) LIKE '%opiace%'
      )
      AND (
        COALESCE(tipo_muestra, '') = ''
        OR COALESCE(tipo_tubo, '') = ''
        OR COALESCE(color_tapa, '') = ''
        OR COALESCE(area_proceso, '') = ''
      )
  `, 'seed estudios etiquetas toxicologia suero');

  try {
    const actuales = await new Promise((resolve, reject) => {
      db.all(`SELECT id, nombre, categoria, clave_externa FROM estudios`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    const claveCounts = new Map();
    actuales.forEach((row) => {
      const clave = String(row.clave_externa || '').trim();
      if (!clave) return;
      claveCounts.set(clave, (claveCounts.get(clave) || 0) + 1);
    });

    const byClaveExterna = new Map(
      actuales
        .filter((row) => {
          const clave = String(row.clave_externa || '').trim();
          return clave && claveCounts.get(clave) === 1;
        })
        .map((row) => [String(row.clave_externa).trim(), row])
    );

    const clavesDuplicadas = [...claveCounts.entries()].filter(([, total]) => total > 1).map(([clave]) => clave);
    if (clavesDuplicadas.length) {
      console.warn(`Claves externas duplicadas detectadas en estudios: ${clavesDuplicadas.join(', ')}`);
    }
    const byCanonical = new Map(
      actuales.map((row) => [canonicalSeedText(row.nombre), row])
    );

    for (const estudio of seedEstudios) {
      const nombre = String(estudio.nombre || '').trim();
      if (!nombre) continue;

      const canonical = canonicalSeedText(nombre);
      const precio = Number(estudio.precio || 0);
      const categoriaSeed = normalizeSeedCategoria(estudio.categoria);
      const claveExterna = String(estudio.clave || '').trim() || null;
      const existente = (claveExterna && byClaveExterna.get(claveExterna)) || byCanonical.get(canonical);

      if (existente) {
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE estudios
             SET precio = ?,
                 clave_externa = ?,
                 categoria = CASE
                   WHEN categoria IS NULL OR TRIM(categoria) = '' OR categoria IN ('OTROS', 'GENERAL')
                     THEN ?
                   ELSE categoria
                 END
             WHERE id = ?`,
            [precio, claveExterna, categoriaSeed, existente.id],
            (err) => err ? reject(err) : resolve()
          );
        });
        continue;
      }

      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO estudios (
            clave_externa, nombre, precio, categoria,
            tipo_muestra, tipo_tubo, color_tapa, tubos_requeridos, area_proceso, comparte_tubo
          ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, NULL, 0)`,
          [claveExterna, nombre, precio, categoriaSeed],
          function(err) {
            if (err) reject(err);
            else {
              byCanonical.set(canonical, {
                id: this.lastID,
                nombre,
                categoria: categoriaSeed,
                clave_externa: claveExterna
              });
              if (claveExterna) {
                byClaveExterna.set(claveExterna, {
                  id: this.lastID,
                  nombre,
                  categoria: categoriaSeed,
                  clave_externa: claveExterna
                });
              }
              resolve();
            }
          }
        );
      });
    }
  } catch (err) {
    console.error('Error al sincronizar seed de estudios desde Excel:', err.message);
  }

  ddl(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_estudios_clave_externa_unique
     ON estudios(clave_externa)
     WHERE clave_externa IS NOT NULL AND TRIM(clave_externa) <> ''`,
    'idx_estudios_clave_externa_unique'
  );

  try {
    await run(`
      UPDATE estudios
      SET subcategoria = 'Hormonas tiroideas'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'ENDOCRINOLOGÍA'
        AND (
          UPPER(nombre) LIKE '%TSH%'
          OR UPPER(nombre) LIKE '%T3%'
          OR UPPER(nombre) LIKE '%T4%'
          OR UPPER(nombre) LIKE '%TIRO%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Hormonas sexuales y fertilidad'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'ENDOCRINOLOGÍA'
        AND (
          UPPER(nombre) LIKE '%FSH%'
          OR UPPER(nombre) LIKE '%LH%'
          OR UPPER(nombre) LIKE '%ESTRADIOL%'
          OR UPPER(nombre) LIKE '%ESTRONA%'
          OR UPPER(nombre) LIKE '%ESTRIOL%'
          OR UPPER(nombre) LIKE '%PROGEST%'
          OR UPPER(nombre) LIKE '%TESTOSTERONA%'
          OR UPPER(nombre) LIKE '%ANDRO%'
          OR UPPER(nombre) LIKE '%HGC%'
          OR UPPER(nombre) LIKE '%AMH%'
          OR UPPER(nombre) LIKE '%MULLERIANA%'
          OR UPPER(nombre) LIKE '%INHIBINA%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Suprarrenales y catecolaminas'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'ENDOCRINOLOGÍA'
        AND (
          UPPER(nombre) LIKE '%ACTH%'
          OR UPPER(nombre) LIKE '%CORTISOL%'
          OR UPPER(nombre) LIKE '%ALDOSTERONA%'
          OR UPPER(nombre) LIKE '%RENINA%'
          OR UPPER(nombre) LIKE '%ADRENALINA%'
          OR UPPER(nombre) LIKE '%NORADRENALINA%'
          OR UPPER(nombre) LIKE '%DOPAMINA%'
          OR UPPER(nombre) LIKE '%METANEFRIN%'
          OR UPPER(nombre) LIKE '%VANILMAND%'
          OR UPPER(nombre) LIKE '%5-HIDROXI%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Coagulación'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'HEMATOLOGÍA'
        AND (
          UPPER(nombre) LIKE '%PROTROMBINA%'
          OR UPPER(nombre) LIKE '%TROMBINA%'
          OR UPPER(nombre) LIKE '%TROMBOPLASTINA%'
          OR UPPER(nombre) LIKE '%FIBRIN%'
          OR UPPER(nombre) LIKE '%DIMERO%'
          OR UPPER(nombre) LIKE '%FACTOR %'
          OR UPPER(nombre) LIKE '%ANTITROMBINA%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Citometría y celularidad'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'HEMATOLOGÍA'
        AND (
          UPPER(nombre) LIKE '%BIOMETR%'
          OR UPPER(nombre) LIKE '%RETICUL%'
          OR UPPER(nombre) LIKE '%FORMULA %'
          OR UPPER(nombre) LIKE '%FROTIS%'
          OR UPPER(nombre) LIKE '%ERITROPOYETINA%'
          OR UPPER(nombre) LIKE '%G6PD%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Serología infecciosa'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'INMUNOLOGÍA'
        AND (
          UPPER(nombre) LIKE '%HEPATITIS%'
          OR UPPER(nombre) LIKE '%HIV%'
          OR UPPER(nombre) LIKE '%VIH%'
          OR UPPER(nombre) LIKE '%DENGUE%'
          OR UPPER(nombre) LIKE '%RUBEOLA%'
          OR UPPER(nombre) LIKE '%HERPES%'
          OR UPPER(nombre) LIKE '%TOXOPLAS%'
          OR UPPER(nombre) LIKE '%CITOMEGALO%'
          OR UPPER(nombre) LIKE '%EPSTEIN%'
          OR UPPER(nombre) LIKE '%VARICELA%'
          OR UPPER(nombre) LIKE '%TREPONEMA%'
          OR UPPER(nombre) LIKE '%VDRL%'
          OR UPPER(nombre) LIKE '%SARS%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Autoinmunidad'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'INMUNOLOGÍA'
        AND (
          UPPER(nombre) LIKE '%ANA%'
          OR UPPER(nombre) LIKE '%ANCA%'
          OR UPPER(nombre) LIKE '%DNA%'
          OR UPPER(nombre) LIKE '%SSA%'
          OR UPPER(nombre) LIKE '%SSB%'
          OR UPPER(nombre) LIKE '%SMITH%'
          OR UPPER(nombre) LIKE '%RNP%'
          OR UPPER(nombre) LIKE '%CARDIOLIP%'
          OR UPPER(nombre) LIKE '%FOSFOLIP%'
          OR UPPER(nombre) LIKE '%MITOCONDR%'
          OR UPPER(nombre) LIKE '%MUSCULO LISO%'
          OR UPPER(nombre) LIKE '%TPO%'
          OR UPPER(nombre) LIKE '%TIROGLOBUL%'
          OR UPPER(nombre) LIKE '%CCP%'
          OR UPPER(nombre) LIKE '%ENDOMISIO%'
          OR UPPER(nombre) LIKE '%GLIADINA%'
          OR UPPER(nombre) LIKE '%TRANSGUTAMIN%'
          OR UPPER(nombre) LIKE '%HLA-B27%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Marcadores séricos'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'MARCADORES TUMORALES'
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Cultivos y microbiología'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'MICROBIOLOGÍA'
        AND (
          UPPER(nombre) LIKE '%CULTIVO%'
          OR UPPER(nombre) LIKE '%EXUDADO%'
          OR UPPER(nombre) LIKE '%HEMOCULTIVO%'
          OR UPPER(nombre) LIKE '%COPROCULTIVO%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Parasitología y tinciones'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'MICROBIOLOGÍA'
        AND (
          UPPER(nombre) LIKE '%BACILOSCOP%'
          OR UPPER(nombre) LIKE '%GOTA GRUESA%'
          OR UPPER(nombre) LIKE '%TINCION%'
          OR UPPER(nombre) LIKE '%CRYPTOSPOR%'
          OR UPPER(nombre) LIKE '%AMIBA%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Orina de 24 horas'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'UROANÁLISIS'
        AND (
          UPPER(nombre) LIKE '%24 HRS%'
          OR UPPER(nombre) LIKE '%24 HRS.%'
          OR UPPER(nombre) LIKE '%24 HRS'
          OR UPPER(nombre) LIKE '%24HR%'
        )
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Urianálisis general'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'UROANÁLISIS'
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Monitoreo terapéutico y drogas'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'TOXICOLOGÍA'
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Patología y citología'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'PATOLOGÍA'
    `);

    await run(`
      UPDATE estudios
      SET subcategoria = 'Cardiometabólico'
      WHERE COALESCE(subcategoria, '') = ''
        AND categoria = 'BIOQUÍMICA'
        AND (
          UPPER(nombre) LIKE '%TROPONINA%'
          OR UPPER(nombre) LIKE '%BNP%'
          OR UPPER(nombre) LIKE '%NT-PROBNP%'
          OR UPPER(nombre) LIKE '%CK-MB%'
          OR UPPER(nombre) LIKE '%CPK%'
          OR UPPER(nombre) LIKE '%MIOGLOBINA%'
        )
    `);
  } catch (err) {
    console.error('Error al asignar subcategorias automáticas:', err.message);
  }


  /* =========================
     AGENDA — TÉCNICOS
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS tecnicos (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre    TEXT    NOT NULL,
      sucursal  TEXT    NOT NULL,
      activo    INTEGER NOT NULL DEFAULT 1
    )
  `, 'tecnicos');

  ddl(`CREATE INDEX IF NOT EXISTS idx_tecnicos_sucursal ON tecnicos(sucursal)`, 'idx_tecnicos_sucursal');

  ddl(`
    INSERT OR IGNORE INTO tecnicos (id, nombre, sucursal) VALUES
      (1, 'Técnico General', 'CDC'),
      (2, 'Técnico General', 'NTE'),
      (3, 'Técnico General', 'SUR')
  `, 'seed tecnicos');

  /* =========================
     AGENDA — BLOQUEOS
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS agenda_bloqueos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sucursal    TEXT    NOT NULL,
      tecnico_id  INTEGER,
      fecha       TEXT    NOT NULL,
      hora_inicio TEXT    NOT NULL,
      hora_fin    TEXT    NOT NULL,
      motivo      TEXT,
      FOREIGN KEY (tecnico_id) REFERENCES tecnicos(id) ON DELETE SET NULL
    )
  `, 'agenda_bloqueos');

  ddl(`CREATE INDEX IF NOT EXISTS idx_bloqueos_fecha ON agenda_bloqueos(fecha, sucursal)`, 'idx_bloqueos_fecha');

  /* =========================
     AGENDA — CITAS
  ========================= */
  ddl(`
    CREATE TABLE IF NOT EXISTS citas (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sucursal         TEXT    NOT NULL,
      tecnico_id       INTEGER,
      paciente_id      INTEGER,
      paciente_nombre  TEXT    NOT NULL,
      paciente_celular TEXT,
      fecha            TEXT    NOT NULL,
      hora_inicio      TEXT    NOT NULL,
      hora_fin         TEXT    NOT NULL,
      duracion_min     INTEGER NOT NULL DEFAULT 30,
      estudios_ids     TEXT    NOT NULL DEFAULT '[]',
      estudios_nombres TEXT    NOT NULL DEFAULT '',
      estado           TEXT    NOT NULL DEFAULT 'programada'
                               CHECK(estado IN ('programada','confirmada','en_curso','completada','cancelada','no_asistio')),
      notas            TEXT,
      orden_id         INTEGER,
      orden_folio      TEXT,
      creado_por       TEXT    NOT NULL,
      fecha_creacion   TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tecnico_id)  REFERENCES tecnicos(id)  ON DELETE SET NULL,
      FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE SET NULL,
      FOREIGN KEY (orden_id)    REFERENCES ordenes(id)   ON DELETE SET NULL
    )
  `, 'citas');

  ddl(`CREATE INDEX IF NOT EXISTS idx_citas_fecha    ON citas(fecha, sucursal)`, 'idx_citas_fecha');
  ddl(`CREATE INDEX IF NOT EXISTS idx_citas_tecnico  ON citas(tecnico_id)`,      'idx_citas_tecnico');
  ddl(`CREATE INDEX IF NOT EXISTS idx_citas_paciente ON citas(paciente_id)`,     'idx_citas_paciente');
  ddl(`CREATE INDEX IF NOT EXISTS idx_citas_estado   ON citas(estado)`,          'idx_citas_estado');
  clearColumnIfExists('citas', 'paciente_dni', 'citas_clear_paciente_dni');
  dropColumnIfExists('citas', 'paciente_dni', 'citas_drop_paciente_dni');

  db.serialize(() => {
    ddl(`
      CREATE TABLE IF NOT EXISTS cita_estudios (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        cita_id    INTEGER NOT NULL,
        estudio_id INTEGER NOT NULL,
        nombre     TEXT    NOT NULL,
        precio     REAL    NOT NULL DEFAULT 0,
        categoria  TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (cita_id)    REFERENCES citas(id)    ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (estudio_id) REFERENCES estudios(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        UNIQUE(cita_id, estudio_id)
      )
    `, 'cita_estudios');

    ddl(`CREATE INDEX IF NOT EXISTS idx_cita_estudios_cita ON cita_estudios(cita_id)`, 'idx_cita_estudios_cita');
    ddl(`CREATE INDEX IF NOT EXISTS idx_cita_estudios_estudio ON cita_estudios(estudio_id)`, 'idx_cita_estudios_estudio');

    ddl(`
      INSERT OR IGNORE INTO cita_estudios (cita_id, estudio_id, nombre, precio, categoria)
      SELECT c.id, e.id, e.nombre, e.precio, e.categoria
      FROM citas c
      JOIN json_each(COALESCE(NULLIF(c.estudios_ids, ''), '[]')) je
      JOIN estudios e ON e.id = CAST(je.value AS INTEGER)
    `, 'cita_estudios_backfill');
  });

  /* =========================
     SEED: USUARIOS
  ========================= */
  try {
    const adminExiste = await new Promise((resolve, reject) => {
      db.get(`SELECT id FROM usuarios WHERE usuario = ?`, ['admin'], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!adminExiste) {
      const adminPassword = process.env.SEED_ADMIN_PASSWORD;
      if (!adminPassword || adminPassword.length < 10) {
        console.warn('SEED_ADMIN_PASSWORD no definido o demasiado corto; no se creó el usuario admin por defecto.');
      } else {
        const hashed = await bcrypt.hash(adminPassword, SALT_ROUNDS);
        db.run(
          `INSERT INTO usuarios (usuario, password, role) VALUES (?, ?, ?)`,
          ['admin', hashed, 'admin'],
          (err) => { if (err) console.error('Error al insertar usuario admin:', err.message); }
        );
      }
    }
  } catch (err) {
    console.error('Error al hashear contraseñas seed:', err.message);
  }

});

/* =========================
   GRACEFUL SHUTDOWN
========================= */
function closeDb() {
  db.close((err) => {
    if (err) console.error('Error al cerrar la base de datos:', err.message);
    else     console.log('Base de datos cerrada correctamente.');
  });
}
process.on('SIGINT',  closeDb);
process.on('SIGTERM', closeDb);

/* =========================
   PROMISE WRAPPERS
========================= */
function run(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else     resolve(this);
    });
  });
}

function get(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else     resolve(row);
    });
  });
}

function all(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else     resolve(rows);
    });
  });
}

async function withTransaction(work) {
  await run('BEGIN IMMEDIATE');
  try {
    const tx = { run, get, all };
    const result = await work(tx);
    await run('COMMIT');
    return result;
  } catch (err) {
    try { await run('ROLLBACK'); } catch {}
    throw err;
  }
}

module.exports = { db, run, get, all, withTransaction };
