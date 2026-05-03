(function () {
  'use strict';

  let pacCurrentPage = 1;
  let pacTotalPacientes = 0;
  let pacEditingId = null;
  let pacDeletingId = null;
  let pacSearchTimer = null;
  let pacInicializado = false;

  const $ = (id) => document.getElementById(id);

  function pacEsc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pacCanDelete() {
    return typeof can === 'function' ? can('pacientes.delete') : true;
  }

  function pacSetModalStatus(text, type = 'error') {
    const el = $('pac-modal-status');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = type === 'error' ? 'var(--red)' : 'var(--green-dark)';
  }

  function pacGetPerPage() {
    return parseInt($('pac-per-page')?.value, 10) || 10;
  }

  function pacGetSearch() {
    return $('pac-search-input')?.value.trim() || '';
  }

  function pacEdadDesdeFecha(fecha) {
    if (!fecha) return null;
    const nacimiento = new Date(`${fecha}T00:00:00`);
    if (Number.isNaN(nacimiento.getTime())) return null;
    const hoy = new Date();
    let edad = hoy.getFullYear() - nacimiento.getFullYear();
    const mes = hoy.getMonth() - nacimiento.getMonth();
    if (mes < 0 || (mes === 0 && hoy.getDate() < nacimiento.getDate())) edad -= 1;
    return edad >= 0 ? edad : null;
  }

  function pacEdad(paciente) {
    return pacEdadDesdeFecha(paciente.fecha_nacimiento) ?? paciente.edad ?? null;
  }

  function pacFmtDate(value) {
    if (!value) return '-';
    if (typeof fmtDate === 'function') return fmtDate(value);
    return String(value).split('T')[0];
  }

  function pacSexoBadge(sexo) {
    const map = { M: 'Masculino', F: 'Femenino', O: 'Otro' };
    const span = document.createElement('span');
    const suffix = sexo === 'M' ? 'm' : sexo === 'F' ? 'f' : 'o';
    span.className = `pac-badge pac-badge-${suffix}`;
    span.textContent = map[sexo] || sexo || '-';
    return span;
  }

  function pacRenderSkeleton() {
    const tbody = $('pac-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    for (let i = 0; i < 5; i += 1) {
      const tr = document.createElement('tr');
      [84, 210, 120, 70, 82, 110, 92, 110].forEach((w) => {
        const td = document.createElement('td');
        const div = document.createElement('div');
        div.className = 'pac-skeleton-cell';
        div.style.width = `${w}px`;
        td.appendChild(div);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  async function pacCargarPacientes(page = 1) {
    pacCurrentPage = page;
    const limit = pacGetPerPage();
    const offset = (page - 1) * limit;
    const buscar = pacGetSearch();
    pacRenderSkeleton();

    try {
      const params = new URLSearchParams({ limit, offset });
      if (buscar) params.set('buscar', buscar);
      const r = await api(`/api/pacientes?${params.toString()}`);
      if (!r.ok) throw new Error('Error al cargar pacientes');

      const data = await r.json();
      const pacientes = data.pacientes || [];
      pacTotalPacientes = data.total || 0;
      pacRenderTabla(pacientes);
      pacRenderPaginacion(page, limit, pacTotalPacientes);
      pacRenderTableInfo(pacientes.length, pacTotalPacientes, offset, limit);
    } catch (err) {
      if (err.isAuth) return;
      pacRenderError('No se pudieron cargar los pacientes.');
    }
  }

  function pacRenderTabla(pacientes) {
    const tbody = $('pac-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!pacientes.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.innerHTML = `
        <div class="pac-empty-state">
          <div class="icon">Buscar</div>
          <div class="title">${pacGetSearch() ? 'Sin resultados' : 'Sin pacientes registrados'}</div>
          <div class="copy">${pacGetSearch() ? 'Intenta con otro nombre, celular, registro o fecha de nacimiento' : 'Haz clic en "Nuevo Paciente" para comenzar'}</div>
        </div>
      `;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    pacientes.forEach((p) => {
      const tr = document.createElement('tr');

      const tdReg = document.createElement('td');
      tdReg.textContent = p.registro || '-';

      const tdPaciente = document.createElement('td');
      tdPaciente.innerHTML = `
        <div class="pac-name">${pacEsc(p.nombre || '-')}</div>
        <div class="pac-subline">${p.fecha_nacimiento ? `Nac. ${pacEsc(pacFmtDate(p.fecha_nacimiento))}` : 'Sin fecha de nacimiento'}</div>
      `;

      const tdCel = document.createElement('td');
      tdCel.textContent = p.celular || '-';

      const tdEdad = document.createElement('td');
      const edad = pacEdad(p);
      tdEdad.textContent = edad === null ? '-' : `${edad}`;

      const tdSexo = document.createElement('td');
      tdSexo.appendChild(pacSexoBadge(p.sexo));

      const tdUltima = document.createElement('td');
      tdUltima.textContent = p.ultima_visita ? pacFmtDate(p.ultima_visita) : '-';

      const tdEstado = document.createElement('td');
      tdEstado.innerHTML = `
        <span class="pac-mini-pill">${Number(p.ordenes_total || 0)} orden${Number(p.ordenes_total || 0) === 1 ? '' : 'es'}</span>
        ${Number(p.ordenes_adeudo || 0) > 0 ? '<span class="pac-mini-pill warn">Adeudo</span>' : ''}
      `;

      const tdAcc = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'pac-action-group';

      const btnView = document.createElement('button');
      btnView.type = 'button';
      btnView.title = 'Ver detalle';
      btnView.className = 'pac-action-btn view';
      btnView.textContent = 'Ver';
      btnView.addEventListener('click', () => pacAbrirDetalle(p.id));

      const btnEdit = document.createElement('button');
      btnEdit.type = 'button';
      btnEdit.title = 'Editar';
      btnEdit.className = 'pac-action-btn edit';
      btnEdit.textContent = 'Editar';
      btnEdit.addEventListener('click', () => pacAbrirEditar(p));

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.title = pacCanDelete() ? 'Eliminar o archivar' : 'Solo admin puede eliminar';
      btnDel.className = 'pac-action-btn delete';
      btnDel.textContent = 'Borrar';
      if (!pacCanDelete()) {
        btnDel.disabled = true;
      } else {
        btnDel.addEventListener('click', () => pacAbrirConfirmarEliminar(p));
      }

      wrap.append(btnView, btnEdit, btnDel);
      tdAcc.appendChild(wrap);
      tr.append(tdReg, tdPaciente, tdCel, tdEdad, tdSexo, tdUltima, tdEstado, tdAcc);
      tbody.appendChild(tr);
    });
  }

  function pacRenderTableInfo(count, total, offset, limit) {
    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + limit, total);
    const el = $('pac-table-info');
    if (!el) return;
    el.innerHTML = `Mostrando <strong>${from}-${to}</strong> de <strong>${total}</strong> paciente${total !== 1 ? 's' : ''}`;
  }

  function pacRenderError(msg) {
    const tbody = $('pac-tbody');
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8">
            <div class="pac-error-state">
              <div class="icon">Alerta</div>
              <div class="title">${msg}</div>
              <div class="copy">Intenta de nuevo en unos segundos.</div>
            </div>
          </td>
        </tr>
      `;
    }
    const info = $('pac-table-info');
    if (info) info.textContent = '';
    $('pac-pagination')?.classList.remove('visible');
  }

  function pacRenderPaginacion(page, limit, total) {
    const totalPages = Math.ceil(total / limit);
    const pag = $('pac-pagination');
    const pagInfo = $('pac-pag-info');
    const pagControls = $('pac-pag-controls');
    if (!pag || !pagInfo || !pagControls) return;

    if (totalPages <= 1) {
      pag.classList.remove('visible');
      return;
    }

    pag.classList.add('visible');
    pagInfo.textContent = `Pagina ${page} de ${totalPages}`;
    pagControls.innerHTML = '';

    const makePagBtn = (label, disabled, active, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `pac-page-btn${active ? ' active' : ''}`;
      b.textContent = label;
      b.disabled = disabled;
      if (!disabled && !active) b.addEventListener('click', onClick);
      return b;
    };

    pagControls.appendChild(makePagBtn('<', page === 1, false, () => pacCargarPacientes(page - 1)));
    const startPage = Math.max(1, page - 2);
    const endPage = Math.min(totalPages, page + 2);
    for (let i = startPage; i <= endPage; i += 1) {
      pagControls.appendChild(makePagBtn(String(i), false, i === page, () => pacCargarPacientes(i)));
    }
    pagControls.appendChild(makePagBtn('>', page === totalPages, false, () => pacCargarPacientes(page + 1)));
  }

  function pacLimpiarForm() {
    [
      'pac-f-registro',
      'pac-f-nombre',
      'pac-f-fecha-nacimiento',
      'pac-f-celular',
      'pac-f-correo',
      'pac-f-direccion',
      'pac-f-observaciones',
    ].forEach((id) => {
      const el = $(id);
      if (el) el.value = '';
    });
    const sexo = $('pac-f-sexo');
    if (sexo) sexo.value = '';
  }

  async function pacCargarSiguienteRegistro() {
    const input = $('pac-f-registro');
    if (!input) return;
    input.value = 'Generando...';
    try {
      const r = await api('/api/pacientes/siguiente-registro');
      const data = await r.json();
      input.value = r.ok && data.registro ? data.registro : '';
    } catch (err) {
      if (err.isAuth) return;
      input.value = '';
    }
  }

  async function pacAbrirNuevo() {
    pacEditingId = null;
    $('pac-modal-title').textContent = 'Nuevo Paciente';
    $('pac-modal-save').textContent = 'Guardar';
    pacLimpiarForm();
    pacSetModalStatus('');
    $('pac-modal-form').classList.add('open');
    pacCargarSiguienteRegistro();
    $('pac-f-nombre').focus();
  }

  function pacAbrirEditar(p) {
    pacEditingId = p.id;
    $('pac-modal-title').textContent = 'Editar Paciente';
    $('pac-modal-save').textContent = 'Actualizar';
    $('pac-f-registro').value = p.registro || '';
    $('pac-f-nombre').value = p.nombre || '';
    $('pac-f-fecha-nacimiento').value = p.fecha_nacimiento || '';
    $('pac-f-celular').value = p.celular || '';
    $('pac-f-correo').value = p.correo || '';
    $('pac-f-direccion').value = p.direccion || '';
    $('pac-f-observaciones').value = p.observaciones || '';
    $('pac-f-sexo').value = p.sexo || '';
    pacSetModalStatus('');
    $('pac-modal-form').classList.add('open');
    $('pac-f-nombre').focus();
  }

  function pacCerrarModalForm() {
    $('pac-modal-form')?.classList.remove('open');
    pacEditingId = null;
  }

  function pacAbrirConfirmarEliminar(p) {
    pacDeletingId = p.id;
    $('pac-confirm-msg').textContent = `Si "${p.nombre}" tiene ordenes, se archivara para conservar su historial.`;
    $('pac-modal-confirm').classList.add('open');
  }

  function pacCerrarConfirm() {
    $('pac-modal-confirm')?.classList.remove('open');
    pacDeletingId = null;
  }

  function pacCerrarDetalle() {
    $('pac-modal-detail')?.classList.remove('open');
  }

  async function pacAbrirDetalle(id) {
    const modal = $('pac-modal-detail');
    const body = $('pac-detail-body');
    if (!modal || !body) return;
    modal.classList.add('open');
    body.innerHTML = '<div class="pac-detail-loading">Cargando historial...</div>';

    try {
      const r = await api(`/api/pacientes/${id}/detalle`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'No se pudo cargar el detalle');
      const p = data.paciente || {};
      const resumen = data.resumen || {};
      $('pac-detail-title').textContent = p.nombre || 'Detalle del paciente';
      body.innerHTML = `
        <div class="pac-detail-grid">
          <div class="pac-detail-card"><span>Registro</span><strong>${pacEsc(p.registro || '-')}</strong></div>
          <div class="pac-detail-card"><span>Nacimiento</span><strong>${pacEsc(pacFmtDate(p.fecha_nacimiento))}</strong></div>
          <div class="pac-detail-card"><span>Edad</span><strong>${pacEsc(pacEdad(p) ?? '-')}</strong></div>
          <div class="pac-detail-card"><span>Celular</span><strong>${pacEsc(p.celular || '-')}</strong></div>
          <div class="pac-detail-card"><span>Total facturado</span><strong>$${fmt(Number(resumen.total_facturado || 0))}</strong></div>
          <div class="pac-detail-card"><span>Saldo pendiente</span><strong>$${fmt(Number(resumen.saldo_pendiente || 0))}</strong></div>
        </div>
        <div class="pac-detail-section">
          <h4>Contacto y notas</h4>
          <p>${pacEsc(p.correo || 'Sin correo')} ${p.direccion ? `- ${pacEsc(p.direccion)}` : ''}</p>
          <p>${pacEsc(p.observaciones || 'Sin observaciones')}</p>
        </div>
        <div class="pac-detail-section">
          <h4>Ultimas ordenes</h4>
          ${pacRenderOrdenesDetalle(data.ordenes || [])}
        </div>
      `;
    } catch (err) {
      if (err.isAuth) return;
      body.innerHTML = '<div class="pac-error-state"><div class="title">No se pudo cargar el detalle</div></div>';
    }
  }

  function pacRenderOrdenesDetalle(ordenes) {
    if (!ordenes.length) return '<div class="pac-detail-empty">Sin ordenes registradas.</div>';
    return `
      <div class="pac-detail-list">
        ${ordenes.map((o) => `
          <div class="pac-detail-row">
            <span class="mono">${pacEsc(o.folio)}</span>
            <span>${pacEsc(pacFmtDate(o.fecha))}</span>
            <strong>$${fmt(Number(o.total || 0))}</strong>
            <span>${pacEsc(o.estado_pago || o.estado || '-')}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function pacGuardarPaciente() {
    pacSetModalStatus('');

    const nombre = $('pac-f-nombre').value.trim();
    const fecha_nacimiento = $('pac-f-fecha-nacimiento').value || null;
    const edad = pacEdadDesdeFecha(fecha_nacimiento);
    const sexo = $('pac-f-sexo').value;
    const registroInput = $('pac-f-registro').value.trim().toUpperCase();
    const registro = /^PAC-\d{4}-\d{4,}$/.test(registroInput) ? registroInput : '';
    const celular = $('pac-f-celular').value.trim();
    const correo = $('pac-f-correo').value.trim();
    const direccion = $('pac-f-direccion').value.trim();
    const observaciones = $('pac-f-observaciones').value.trim();

    if (!nombre) {
      pacSetModalStatus('El nombre es requerido');
      $('pac-f-nombre').focus();
      return;
    }
    if (!fecha_nacimiento || edad === null || edad > 149) {
      pacSetModalStatus('Ingresa una fecha de nacimiento valida');
      $('pac-f-fecha-nacimiento').focus();
      return;
    }
    if (!sexo) {
      pacSetModalStatus('Selecciona el sexo');
      $('pac-f-sexo').focus();
      return;
    }

    const btnSave = $('pac-modal-save');
    const labelFinal = pacEditingId ? 'Actualizar' : 'Guardar';
    btnSave.disabled = true;
    btnSave.textContent = 'Guardando...';

    try {
      const url = pacEditingId ? `/api/pacientes/${pacEditingId}` : '/api/pacientes';
      const method = pacEditingId ? 'PUT' : 'POST';
      const body = { registro, nombre, celular, correo, direccion, observaciones, fecha_nacimiento, edad, sexo };
      const r = await api(url, { method, body: JSON.stringify(body) });
      const result = await r.json();
      if (!r.ok) {
        pacSetModalStatus(result.error || 'Error al guardar');
        return;
      }

      pacCerrarModalForm();
      toast(pacEditingId ? 'Paciente actualizado' : 'Paciente registrado', 'OK');
      pacCargarPacientes(pacCurrentPage);
    } catch (err) {
      if (err.isAuth) return;
      pacSetModalStatus('No se pudo conectar con el servidor');
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = labelFinal;
    }
  }

  async function pacEliminarPaciente() {
    if (!pacDeletingId) return;

    const btnDel = $('pac-confirm-delete');
    btnDel.disabled = true;
    btnDel.textContent = 'Procesando...';

    try {
      const r = await api(`/api/pacientes/${pacDeletingId}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(d.error || 'Error al eliminar', 'Error');
        return;
      }

      pacCerrarConfirm();
      toast(d.archived ? 'Paciente archivado' : 'Paciente eliminado', 'OK');
      const newTotal = pacTotalPacientes - 1;
      const limit = pacGetPerPage();
      const maxPage = Math.max(1, Math.ceil(newTotal / limit));
      pacCargarPacientes(Math.min(pacCurrentPage, maxPage));
    } catch (err) {
      if (err.isAuth) return;
      toast('Error al conectar con el servidor', 'Error');
    } finally {
      btnDel.disabled = false;
      btnDel.textContent = 'Si, continuar';
    }
  }

  function pacBindEvents() {
    $('pac-btn-nuevo')?.addEventListener('click', pacAbrirNuevo);
    $('pac-modal-save')?.addEventListener('click', pacGuardarPaciente);
    $('pac-modal-close-form')?.addEventListener('click', pacCerrarModalForm);
    $('pac-modal-cancel-form')?.addEventListener('click', pacCerrarModalForm);
    $('pac-confirm-delete')?.addEventListener('click', pacEliminarPaciente);
    $('pac-modal-close-confirm')?.addEventListener('click', pacCerrarConfirm);
    $('pac-confirm-cancel')?.addEventListener('click', pacCerrarConfirm);
    $('pac-modal-close-detail')?.addEventListener('click', pacCerrarDetalle);
    $('pac-modal-detail')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) pacCerrarDetalle();
    });
    $('pac-modal-form')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) pacCerrarModalForm();
    });
    $('pac-modal-confirm')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) pacCerrarConfirm();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        pacCerrarModalForm();
        pacCerrarConfirm();
        pacCerrarDetalle();
      }
    });
    $('pac-search-input')?.addEventListener('input', () => {
      clearTimeout(pacSearchTimer);
      pacSearchTimer = setTimeout(() => pacCargarPacientes(1), 350);
    });
    $('pac-per-page')?.addEventListener('change', () => pacCargarPacientes(1));
    [
      'pac-f-registro',
      'pac-f-nombre',
      'pac-f-fecha-nacimiento',
      'pac-f-celular',
      'pac-f-correo',
      'pac-f-direccion',
      'pac-f-observaciones',
      'pac-f-sexo',
    ].forEach((id) => {
      $(id)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && id !== 'pac-f-observaciones') pacGuardarPaciente();
      });
    });
  }

  pacBindEvents();

  window.pacIniciarVista = function () {
    if (!pacInicializado) pacInicializado = true;
    pacCargarPacientes(pacCurrentPage);
  };
})();
