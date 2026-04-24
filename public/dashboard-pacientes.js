(function () {
  'use strict';

  let pacCurrentPage = 1;
  let pacTotalPacientes = 0;
  let pacEditingId = null;
  let pacDeletingId = null;
  let pacSearchTimer = null;
  let pacInicializado = false;

  function pacCanDelete() {
    return can('pacientes.delete');
  }

  function pacSetModalStatus(text, type = 'error') {
    const el = document.getElementById('pac-modal-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = type === 'error' ? 'var(--red)' : 'var(--green-dark)';
  }

  function pacGetPerPage() {
    return parseInt(document.getElementById('pac-per-page')?.value, 10) || 10;
  }

  function pacGetSearch() {
    return document.getElementById('pac-search-input')?.value.trim() || '';
  }

  function pacSexoBadge(sexo) {
    const map = { M: 'Masculino', F: 'Femenino', O: 'Otro' };
    const span = document.createElement('span');
    const suffix = sexo === 'M' ? 'm' : sexo === 'F' ? 'f' : 'o';
    span.className = `pac-badge pac-badge-${suffix}`;
    span.textContent = map[sexo] || sexo || '—';
    return span;
  }

  function pacRenderSkeleton() {
    const tbody = document.getElementById('pac-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    for (let i = 0; i < 5; i += 1) {
      const tr = document.createElement('tr');
      [80, 160, 100, 120, 40, 70, 80].forEach((w) => {
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
      pacTotalPacientes = data.total || 0;
      pacRenderTabla(data.pacientes || []);
      pacRenderPaginacion(page, limit, pacTotalPacientes);
      pacRenderTableInfo((data.pacientes || []).length, pacTotalPacientes, offset, limit);
    } catch (err) {
      if (err.isAuth) return;
      pacRenderError('No se pudieron cargar los pacientes.');
    }
  }

  function pacRenderTabla(pacientes) {
    const tbody = document.getElementById('pac-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!pacientes.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.innerHTML = `
        <div class="pac-empty-state">
          <div class="icon">🔍</div>
          <div class="title">${pacGetSearch() ? 'Sin resultados' : 'Sin pacientes registrados'}</div>
          <div class="copy">${pacGetSearch() ? 'Intenta con otro nombre, DNI o registro' : 'Haz clic en "Nuevo Paciente" para comenzar'}</div>
        </div>
      `;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    pacientes.forEach((p) => {
      const tr = document.createElement('tr');

      const tdReg = document.createElement('td');
      tdReg.textContent = p.registro || '—';

      const tdNom = document.createElement('td');
      tdNom.style.fontWeight = '700';
      tdNom.textContent = p.nombre;

      const tdDni = document.createElement('td');
      tdDni.textContent = p.dni || '—';

      const tdCel = document.createElement('td');
      tdCel.textContent = p.celular || '—';

      const tdEdad = document.createElement('td');
      tdEdad.textContent = p.edad ?? '—';

      const tdSexo = document.createElement('td');
      tdSexo.appendChild(pacSexoBadge(p.sexo));

      const tdAcc = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'pac-action-group';

      const btnEdit = document.createElement('button');
      btnEdit.type = 'button';
      btnEdit.title = 'Editar';
      btnEdit.className = 'pac-action-btn edit';
      btnEdit.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
      btnEdit.addEventListener('click', () => pacAbrirEditar(p));

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.title = pacCanDelete() ? 'Eliminar' : 'Solo admin puede eliminar';
      btnDel.className = 'pac-action-btn delete';
      btnDel.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
      if (!pacCanDelete()) {
        btnDel.disabled = true;
      } else {
        btnDel.addEventListener('click', () => pacAbrirConfirmarEliminar(p));
      }

      wrap.append(btnEdit, btnDel);
      tdAcc.appendChild(wrap);

      tr.append(tdReg, tdNom, tdDni, tdCel, tdEdad, tdSexo, tdAcc);
      tbody.appendChild(tr);
    });
  }

  function pacRenderTableInfo(count, total, offset, limit) {
    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + limit, total);
    const el = document.getElementById('pac-table-info');
    if (!el) return;
    el.innerHTML = `Mostrando <strong>${from}–${to}</strong> de <strong>${total}</strong> paciente${total !== 1 ? 's' : ''}`;
  }

  function pacRenderError(msg) {
    const tbody = document.getElementById('pac-tbody');
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7">
            <div class="pac-error-state">
              <div class="icon">⚠️</div>
              <div class="title">${msg}</div>
              <div class="copy">Intenta de nuevo en unos segundos.</div>
            </div>
          </td>
        </tr>
      `;
    }
    const info = document.getElementById('pac-table-info');
    if (info) info.textContent = '';
    document.getElementById('pac-pagination')?.classList.remove('visible');
  }

  function pacRenderPaginacion(page, limit, total) {
    const totalPages = Math.ceil(total / limit);
    const pag = document.getElementById('pac-pagination');
    const pagInfo = document.getElementById('pac-pag-info');
    const pagControls = document.getElementById('pac-pag-controls');
    if (!pag || !pagInfo || !pagControls) return;

    if (totalPages <= 1) {
      pag.classList.remove('visible');
      return;
    }

    pag.classList.add('visible');
    pagInfo.textContent = `Página ${page} de ${totalPages}`;
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

    const makeDots = () => {
      const dots = document.createElement('span');
      dots.className = 'pac-page-dots';
      dots.textContent = '…';
      return dots;
    };

    pagControls.appendChild(makePagBtn('‹', page === 1, false, () => pacCargarPacientes(page - 1)));

    const startPage = Math.max(1, page - 2);
    const endPage = Math.min(totalPages, page + 2);

    if (startPage > 1) {
      pagControls.appendChild(makePagBtn('1', false, false, () => pacCargarPacientes(1)));
      if (startPage > 2) pagControls.appendChild(makeDots());
    }

    for (let i = startPage; i <= endPage; i += 1) {
      pagControls.appendChild(makePagBtn(String(i), false, i === page, () => pacCargarPacientes(i)));
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) pagControls.appendChild(makeDots());
      pagControls.appendChild(makePagBtn(String(totalPages), false, false, () => pacCargarPacientes(totalPages)));
    }

    pagControls.appendChild(makePagBtn('›', page === totalPages, false, () => pacCargarPacientes(page + 1)));
  }

  function pacLimpiarForm() {
    ['pac-f-registro', 'pac-f-nombre', 'pac-f-dni', 'pac-f-celular', 'pac-f-edad'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const sexo = document.getElementById('pac-f-sexo');
    if (sexo) sexo.value = '';
  }

  function pacAbrirNuevo() {
    pacEditingId = null;
    document.getElementById('pac-modal-title').textContent = '➕ Nuevo Paciente';
    document.getElementById('pac-modal-save').textContent = 'Guardar';
    pacLimpiarForm();
    pacSetModalStatus('');
    document.getElementById('pac-modal-form').classList.add('open');
    document.getElementById('pac-f-nombre').focus();
  }

  function pacAbrirEditar(p) {
    pacEditingId = p.id;
    document.getElementById('pac-modal-title').textContent = '✏️ Editar Paciente';
    document.getElementById('pac-modal-save').textContent = 'Actualizar';
    document.getElementById('pac-f-registro').value = p.registro || '';
    document.getElementById('pac-f-nombre').value = p.nombre || '';
    document.getElementById('pac-f-dni').value = p.dni || '';
    document.getElementById('pac-f-celular').value = p.celular || '';
    document.getElementById('pac-f-edad').value = p.edad || '';
    document.getElementById('pac-f-sexo').value = p.sexo || '';
    pacSetModalStatus('');
    document.getElementById('pac-modal-form').classList.add('open');
    document.getElementById('pac-f-nombre').focus();
  }

  function pacCerrarModalForm() {
    document.getElementById('pac-modal-form').classList.remove('open');
    pacEditingId = null;
  }

  function pacAbrirConfirmarEliminar(p) {
    pacDeletingId = p.id;
    document.getElementById('pac-confirm-msg').textContent = `Se eliminará a "${p.nombre}". Esta acción no se puede deshacer.`;
    document.getElementById('pac-modal-confirm').classList.add('open');
  }

  function pacCerrarConfirm() {
    document.getElementById('pac-modal-confirm').classList.remove('open');
    pacDeletingId = null;
  }

  async function pacGuardarPaciente() {
    pacSetModalStatus('');

    const nombre = document.getElementById('pac-f-nombre').value.trim();
    const edad = parseInt(document.getElementById('pac-f-edad').value, 10);
    const sexo = document.getElementById('pac-f-sexo').value;
    const registro = document.getElementById('pac-f-registro').value.trim();
    const dni = document.getElementById('pac-f-dni').value.trim();
    const celular = document.getElementById('pac-f-celular').value.trim();

    if (!nombre) {
      pacSetModalStatus('El nombre es requerido');
      document.getElementById('pac-f-nombre').focus();
      return;
    }
    if (!edad || edad < 1 || edad > 149) {
      pacSetModalStatus('Ingresa una edad válida (1–149)');
      document.getElementById('pac-f-edad').focus();
      return;
    }
    if (!sexo) {
      pacSetModalStatus('Selecciona el sexo');
      document.getElementById('pac-f-sexo').focus();
      return;
    }

    const btnSave = document.getElementById('pac-modal-save');
    const labelFinal = pacEditingId ? 'Actualizar' : 'Guardar';
    btnSave.disabled = true;
    btnSave.textContent = 'Guardando...';

    try {
      const url = pacEditingId ? `/api/pacientes/${pacEditingId}` : '/api/pacientes';
      const method = pacEditingId ? 'PUT' : 'POST';
      const r = await api(url, { method, body: JSON.stringify({ registro, nombre, dni, celular, edad, sexo }) });
      const result = await r.json();
      if (!r.ok) {
        pacSetModalStatus(result.error || 'Error al guardar');
        return;
      }

      pacCerrarModalForm();
      toast(pacEditingId ? 'Paciente actualizado' : 'Paciente registrado', '✔');
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

    const btnDel = document.getElementById('pac-confirm-delete');
    btnDel.disabled = true;
    btnDel.textContent = 'Eliminando...';

    try {
      const r = await api(`/api/pacientes/${pacDeletingId}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast(d.error || 'Error al eliminar', '❌');
        return;
      }

      pacCerrarConfirm();
      toast('Paciente eliminado', '🗑️');
      const newTotal = pacTotalPacientes - 1;
      const limit = pacGetPerPage();
      const maxPage = Math.max(1, Math.ceil(newTotal / limit));
      pacCargarPacientes(Math.min(pacCurrentPage, maxPage));
    } catch (err) {
      if (err.isAuth) return;
      toast('Error al conectar con el servidor', '❌');
    } finally {
      btnDel.disabled = false;
      btnDel.textContent = 'Sí, eliminar';
    }
  }

  function pacBindEvents() {
    document.getElementById('pac-btn-nuevo').addEventListener('click', pacAbrirNuevo);
    document.getElementById('pac-modal-save').addEventListener('click', pacGuardarPaciente);
    document.getElementById('pac-modal-close-form').addEventListener('click', pacCerrarModalForm);
    document.getElementById('pac-modal-cancel-form').addEventListener('click', pacCerrarModalForm);
    document.getElementById('pac-confirm-delete').addEventListener('click', pacEliminarPaciente);
    document.getElementById('pac-modal-close-confirm').addEventListener('click', pacCerrarConfirm);
    document.getElementById('pac-confirm-cancel').addEventListener('click', pacCerrarConfirm);
    document.getElementById('pac-modal-form').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) pacCerrarModalForm();
    });
    document.getElementById('pac-modal-confirm').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) pacCerrarConfirm();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        pacCerrarModalForm();
        pacCerrarConfirm();
      }
    });
    document.getElementById('pac-search-input').addEventListener('input', () => {
      clearTimeout(pacSearchTimer);
      pacSearchTimer = setTimeout(() => pacCargarPacientes(1), 350);
    });
    document.getElementById('pac-per-page').addEventListener('change', () => pacCargarPacientes(1));
    ['pac-f-registro', 'pac-f-nombre', 'pac-f-dni', 'pac-f-celular', 'pac-f-edad', 'pac-f-sexo'].forEach((id) => {
      document.getElementById(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') pacGuardarPaciente();
      });
    });
  }

  pacBindEvents();

  window.pacIniciarVista = function () {
    if (!pacInicializado) {
      pacInicializado = true;
      pacCargarPacientes(1);
    }
  };
})();
