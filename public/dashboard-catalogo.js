let catEstudios = [];
let catFiltroActivo = 'TODOS';
let catBusqueda = '';
let editandoId = null;
let eliminandoId = null;

const CAT_CATEGORIAS_BASE = [
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
  'OTROS'
];

function catFixEncoding(value) {
  return String(value || '')
    .replace(/\u00c3\u008d/g, '\u00cd')
    .replace(/\u00c3\u0081/g, '\u00c1')
    .replace(/\u00c3\u0093/g, '\u00d3')
    .replace(/\u00c3\u0089/g, '\u00c9')
    .replace(/\u00c3\u009a/g, '\u00da')
    .replace(/\u00c3\u0091/g, '\u00d1')
    .replace(/\u00c2\u00b7/g, '\u00b7')
    .replace(/\u00c2/g, '');
}

function catCanonical(value) {
  return catFixEncoding(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\uFFFD/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function catNormalize(value) {
  const key = catCanonical(value);
  const found = CAT_CATEGORIAS_BASE.find((cat) => catCanonical(cat) === key);
  return found || catFixEncoding(value).trim();
}

function catListaCategorias(extra = []) {
  const seen = new Set();
  return [...CAT_CATEGORIAS_BASE, ...extra.map(catNormalize)]
    .filter(Boolean)
    .filter((cat) => {
      const key = catCanonical(cat);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function renderCatChips() {
  const wrap = document.getElementById('cat-chips');
  const categorias = catListaCategorias(catEstudios.map((e) => e.categoria))
    .filter((cat) => cat !== 'OTROS');

  wrap.innerHTML = '';

  const chips = ['TODOS', ...categorias, 'OTROS'].filter((cat, idx, arr) => arr.indexOf(cat) === idx);
  chips.forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = 'cat-chip' + (cat === catFiltroActivo ? ' active' : '');
    btn.dataset.cat = cat;
    btn.textContent = cat === 'TODOS' ? 'Todos' : cat;
    btn.addEventListener('click', () => filtrarCat(btn));
    wrap.appendChild(btn);
  });
}

function renderModalCategorias(selected = '') {
  const select = document.getElementById('me-categoria');
  const categorias = catListaCategorias([...catEstudios.map((e) => e.categoria), selected]);
  const selectedCat = catNormalize(selected);

  select.innerHTML = '';

  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = '-- Selecciona --';
  select.appendChild(emptyOption);

  categorias.forEach((cat) => {
    const option = document.createElement('option');
    option.value = cat;
    option.textContent = cat;
    if (cat === selectedCat) option.selected = true;
    select.appendChild(option);
  });
}

function catPillClass(cat) {
  const key = catCanonical(cat);
  const map = {
    BIOQUIMICA: 'cat-BIOQUIMICA',
    HEMATOLOGIA: 'cat-HEMATOLOGIA',
    INMUNOLOGIA: 'cat-INMUNOLOGIA',
    UROANALISIS: 'cat-URONALISIS',
    MICROBIOLOGIA: 'cat-MICROBIOLOGIA'
  };
  return map[key] || 'cat-OTROS';
}

function catTubeSummary(e) {
  const parts = [];
  if (e.tipo_muestra) parts.push(e.tipo_muestra);
  if (e.tipo_tubo) parts.push(e.tipo_tubo);
  if (e.color_tapa) parts.push(`tapa ${e.color_tapa}`);
  if (Number(e.tubos_requeridos || 0) > 0) parts.push(`${Number(e.tubos_requeridos)} tubo${Number(e.tubos_requeridos) !== 1 ? 's' : ''}`);
  if (e.comparte_tubo) parts.push('comparte');
  return parts.join(' \u00b7 ') || 'Sin configurar';
}

async function cargarCatalogo() {
  document.getElementById('cat-body').innerHTML = '<div class="spinner"></div>';
  try {
    const res = await api('/api/estudios');
    if (!res.ok) throw new Error();

    catEstudios = (await res.json()).map((e) => ({
      ...e,
      categoria: catNormalize(e.categoria) || 'OTROS'
    }));

    if (catFiltroActivo !== 'TODOS' && !catListaCategorias(catEstudios.map((e) => e.categoria)).includes(catFiltroActivo)) {
      catFiltroActivo = 'TODOS';
    }

    renderCatChips();
    renderModalCategorias();
    renderCatalogo();
  } catch (e) {
    if (e.isAuth) return;
    document.getElementById('cat-body').innerHTML = '<div class="empty-state"><div class="icon">!</div><div>Error al cargar estudios</div></div>';
  }
}

function renderCatalogo() {
  const q = catBusqueda.trim().toLowerCase();
  const puedeGestionarCatalogo = can('estudios.manage');
  const bodyEl = document.getElementById('cat-body');

  document.getElementById('btn-nuevo-estudio').style.display = puedeGestionarCatalogo ? '' : 'none';

  const filtered = catEstudios.filter((e) => {
    const categoria = catNormalize(e.categoria) || 'OTROS';
    const matchCat = catFiltroActivo === 'TODOS' || categoria === catFiltroActivo;
    const matchQ = !q
      || String(e.nombre || '').toLowerCase().includes(q)
      || String(e.nombre_corto || '').toLowerCase().includes(q)
      || String(categoria).toLowerCase().includes(q)
      || String(e.subcategoria || '').toLowerCase().includes(q)
      || String(e.sinonimos_busqueda || '').toLowerCase().includes(q)
      || String(e.clave_externa || '').toLowerCase().includes(q)
      || String(e.indicaciones || '').toLowerCase().includes(q)
      || String(e.tipo_muestra || '').toLowerCase().includes(q)
      || String(e.tipo_tubo || '').toLowerCase().includes(q)
      || String(e.color_tapa || '').toLowerCase().includes(q)
      || String(e.area_proceso || '').toLowerCase().includes(q);
    return matchCat && matchQ;
  });

  document.getElementById('cat-count').textContent = `${filtered.length} estudio${filtered.length !== 1 ? 's' : ''}`;

  if (filtered.length === 0) {
    bodyEl.innerHTML = '<div class="empty-state"><div class="icon"></div><div>No hay estudios que coincidan</div></div>';
    return;
  }

  bodyEl.innerHTML = `
    <table class="estudios-table">
      <thead>
        <tr>
          <th style="width:96px;">Clave</th>
          <th>Nombre</th>
          <th>Categoria</th>
          <th>Precio</th>
          <th>Tubos</th>
          <th style="width:140px;">Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>`;

  const tbody = bodyEl.querySelector('tbody');

  filtered.forEach((e) => {
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    tdId.style.fontFamily = "'DM Mono',monospace";
    tdId.style.fontWeight = '700';
    tdId.textContent = String(e.clave_externa || e.id || '');

    const tdNombre = document.createElement('td');
    tdNombre.style.fontWeight = '700';
    tdNombre.textContent = e.nombre || '';

    const tdCategoria = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `cat-pill ${catPillClass(e.categoria)}`;
    pill.textContent = catNormalize(e.categoria) || 'OTROS';
    tdCategoria.appendChild(pill);

    const tdPrecio = document.createElement('td');
    tdPrecio.style.fontFamily = "'DM Mono',monospace";
    tdPrecio.style.fontWeight = '600';
    tdPrecio.textContent = `$${fmt(e.precio)}`;

    const tdTubos = document.createElement('td');
    const tubosMain = document.createElement('div');
    tubosMain.style.cssText = 'font-size:12px;font-weight:700;color:var(--text);';
    tubosMain.textContent = catTubeSummary(e);
    const tubosMeta = document.createElement('div');
    tubosMeta.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px;';
    tubosMeta.textContent = e.area_proceso || 'Sin area';
    tdTubos.append(tubosMain, tubosMeta);

    const tdAcciones = document.createElement('td');
    if (puedeGestionarCatalogo) {
      const actions = document.createElement('div');
      actions.className = 'actions-cell';

      const btnEditar = document.createElement('button');
      btnEditar.className = 'btn btn-ghost btn-sm';
      btnEditar.textContent = 'Editar';
      btnEditar.addEventListener('click', () => abrirModalEstudio(e.id));

      const btnEliminar = document.createElement('button');
      btnEliminar.className = 'btn btn-sm btn-danger';
      btnEliminar.style.background = '#fdedec';
      btnEliminar.style.color = '#922b21';
      btnEliminar.style.border = '1px solid #f5b7b1';
      btnEliminar.textContent = 'Eliminar';
      btnEliminar.addEventListener('click', () => pedirEliminar(e.id, e.nombre || ''));

      actions.appendChild(btnEditar);
      actions.appendChild(btnEliminar);
      tdAcciones.appendChild(actions);
    } else {
      tdAcciones.style.color = 'var(--muted)';
      tdAcciones.style.fontSize = '12px';
      tdAcciones.textContent = '-';
    }

    tr.appendChild(tdId);
    tr.appendChild(tdNombre);
    tr.appendChild(tdCategoria);
    tr.appendChild(tdPrecio);
    tr.appendChild(tdTubos);
    tr.appendChild(tdAcciones);
    tbody.appendChild(tr);
  });
}

function filtrarCat(btn) {
  document.querySelectorAll('#cat-chips .cat-chip').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  catFiltroActivo = btn.dataset.cat;
  renderCatalogo();
}

let catSearchTimer;
document.getElementById('cat-search').addEventListener('input', (e) => {
  catBusqueda = e.target.value;
  clearTimeout(catSearchTimer);
  catSearchTimer = setTimeout(renderCatalogo, 200);
});

function abrirModalEstudio(id = null) {
  editandoId = id;
  const modal = document.getElementById('modal-estudio');
  const errEl = document.getElementById('modal-err');
  errEl.style.display = 'none';

  if (id) {
    const e = catEstudios.find((x) => x.id === id);
    if (!e) return;
    renderModalCategorias(e.categoria);
    document.getElementById('modal-estudio-title').textContent = 'Editar estudio';
    document.getElementById('me-clave-externa').value = e.clave_externa || '';
    document.getElementById('me-nombre').value = e.nombre;
    document.getElementById('me-nombre-corto').value = e.nombre_corto || '';
    document.getElementById('me-precio').value = e.precio;
    document.getElementById('me-categoria').value = catNormalize(e.categoria) || '';
    document.getElementById('me-subcategoria').value = e.subcategoria || '';
    document.getElementById('me-sinonimos').value = e.sinonimos_busqueda || '';
    document.getElementById('me-tipo-muestra').value = e.tipo_muestra || '';
    document.getElementById('me-tipo-tubo').value = e.tipo_tubo || '';
    document.getElementById('me-color-tapa').value = e.color_tapa || '';
    document.getElementById('me-tubos-requeridos').value = Number(e.tubos_requeridos || 1);
    document.getElementById('me-area-proceso').value = e.area_proceso || '';
    document.getElementById('me-comparte-tubo').value = e.comparte_tubo ? '1' : '0';
    document.getElementById('me-indicaciones').value = e.indicaciones || '';
  } else {
    renderModalCategorias();
    document.getElementById('modal-estudio-title').textContent = 'Nuevo estudio';
    document.getElementById('me-clave-externa').value = '';
    document.getElementById('me-nombre').value = '';
    document.getElementById('me-nombre-corto').value = '';
    document.getElementById('me-precio').value = '';
    document.getElementById('me-categoria').value = '';
    document.getElementById('me-subcategoria').value = '';
    document.getElementById('me-sinonimos').value = '';
    document.getElementById('me-tipo-muestra').value = '';
    document.getElementById('me-tipo-tubo').value = '';
    document.getElementById('me-color-tapa').value = '';
    document.getElementById('me-tubos-requeridos').value = '1';
    document.getElementById('me-area-proceso').value = '';
    document.getElementById('me-comparte-tubo').value = '0';
    document.getElementById('me-indicaciones').value = '';
  }

  modal.classList.add('open');
  setTimeout(() => document.getElementById('me-nombre').focus(), 80);
}

function cerrarModalEstudio() {
  document.getElementById('modal-estudio').classList.remove('open');
  editandoId = null;
}

async function guardarEstudio() {
  const nombre = document.getElementById('me-nombre').value.trim();
  const clave_externa = document.getElementById('me-clave-externa').value.trim();
  const nombre_corto = document.getElementById('me-nombre-corto').value.trim();
  const precio = document.getElementById('me-precio').value;
  const categoria = catNormalize(document.getElementById('me-categoria').value);
  const subcategoria = document.getElementById('me-subcategoria').value.trim();
  const sinonimos_busqueda = document.getElementById('me-sinonimos').value.trim();
  const tipo_muestra = document.getElementById('me-tipo-muestra').value.trim();
  const tipo_tubo = document.getElementById('me-tipo-tubo').value.trim();
  const color_tapa = document.getElementById('me-color-tapa').value.trim();
  const tubos_requeridos = Number(document.getElementById('me-tubos-requeridos').value || 1);
  const area_proceso = document.getElementById('me-area-proceso').value.trim();
  const comparte_tubo = document.getElementById('me-comparte-tubo').value === '1';
  const indicaciones = document.getElementById('me-indicaciones').value.trim();
  const errEl = document.getElementById('modal-err');
  const btn = document.getElementById('btn-guardar-estudio');

  errEl.style.display = 'none';
  if (!nombre) {
    errEl.textContent = 'El nombre es requerido';
    errEl.style.display = 'block';
    return;
  }
  if (precio === '' || Number(precio) < 0) {
    errEl.textContent = 'Ingresa un precio valido';
    errEl.style.display = 'block';
    return;
  }
  if (!categoria) {
    errEl.textContent = 'Selecciona una categoria';
    errEl.style.display = 'block';
    return;
  }
  if (!Number.isFinite(tubos_requeridos) || tubos_requeridos < 1) {
    errEl.textContent = 'Ingresa una cantidad de tubos valida';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    const method = editandoId ? 'PUT' : 'POST';
    const url = editandoId ? `/api/estudios/${editandoId}` : '/api/estudios';
    const res = await api(url, {
      method,
      body: JSON.stringify({
        clave_externa,
        nombre,
        nombre_corto,
        precio: Number(precio),
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
      })
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error || 'Error al guardar';
      errEl.style.display = 'block';
      return;
    }

    toast(editandoId ? 'Estudio actualizado' : 'Estudio creado', 'OK');
    cerrarModalEstudio();
    await cargarCatalogo();
  } catch (e) {
    if (e.isAuth) return;
    errEl.textContent = 'Error de conexion';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
}

function pedirEliminar(id, nombre) {
  eliminandoId = id;
  document.getElementById('confirm-msg').textContent = `¿Eliminar "${nombre}"?`;
  document.getElementById('confirm-sub').textContent = 'Esta accion no se puede deshacer. Si el estudio esta en ordenes existentes, no sera posible eliminarlo.';
  document.getElementById('modal-confirm').classList.add('open');
}

function cerrarModalConfirm() {
  document.getElementById('modal-confirm').classList.remove('open');
  eliminandoId = null;
}

async function confirmarEliminar() {
  if (!eliminandoId) return;

  const btn = document.getElementById('btn-confirm-del');
  btn.disabled = true;
  btn.textContent = 'Eliminando...';

  try {
    const res = await api(`/api/estudios/${eliminandoId}`, { method: 'DELETE' });
    const data = await res.json();

    if (!res.ok) {
      cerrarModalConfirm();
      toast(data.error || 'No se pudo eliminar', 'X');
      return;
    }

    toast(`"${data.eliminado}" eliminado`, 'OK');
    cerrarModalConfirm();
    await cargarCatalogo();
  } catch (e) {
    if (e.isAuth) return;
    toast('Error de conexion', 'X');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Eliminar';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    cerrarModalEstudio();
    cerrarModalConfirm();
  }
});

document.getElementById('modal-estudio').addEventListener('click', function(e) {
  if (e.target === this) cerrarModalEstudio();
});

document.getElementById('modal-confirm').addEventListener('click', function(e) {
  if (e.target === this) cerrarModalConfirm();
});
