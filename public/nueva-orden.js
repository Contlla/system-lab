(() => {
  const TEMPLATE_ID = 'tpl-dashboard-nueva-orden';
  const DASHBOARD_STYLE_ID = 'dashboard-nueva-orden-css';

  function ensureDashboardStyles() {
    let link = document.getElementById(DASHBOARD_STYLE_ID);
    if (!link) {
      link = document.createElement('link');
      link.id = DASHBOARD_STYLE_ID;
      link.rel = 'stylesheet';
      link.href = '/nueva-orden.css';
      link.disabled = true;
      document.head.appendChild(link);
    }
    return link;
  }

  function setDashboardStylesEnabled(enabled) {
    const link = ensureDashboardStyles();
    link.disabled = !enabled;
    if (!enabled) {
      const ticket = document.getElementById('ticket-print');
      if (ticket) ticket.remove();
    }
  }

  function initNuevaOrdenApp() {
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       AUTH GUARD
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    const token = sessionStorage.getItem('token');
    if (!token || token === 'undefined') {
      sessionStorage.removeItem('token');
      sessionStorage.removeItem('role');
      window.location.replace('/index.html');
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       ESTADO
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    let estudiosDisponibles = [];
    let seleccionadosNueva  = [];
    let seleccionadosEdit   = [];
    let ordenActual         = null;
    let estudiosAsignados   = [];
    let catActivaNueva      = 'TODOS';
    let catActivaEdit       = 'TODOS';
    let searchTermNueva     = '';
    let searchTermEdit      = '';
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       HELPERS
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function logout() {
      if (window.LabApi?.logout) return window.LabApi.logout();
      sessionStorage.removeItem('token');
      sessionStorage.removeItem('role');
      window.location.replace('/index.html');
    }
    
    /** Redondea a 2 decimales para evitar errores de punto flotante */
    function round2(val) {
      return Math.round((Number(val) || 0) * 100) / 100;
    }
    
    function fmt(val) {
      return round2(val).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function getCurrentPermissions() {
      try {
        const parsed = JSON.parse(sessionStorage.getItem('permissions') || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }

    function hasPermission(permission) {
      return getCurrentPermissions().includes(permission);
    }

    function calcularDescuentoLocal(subtotal, tipo, valor) {
      const base = round2(subtotal);
      const tipoSeguro = ['ninguno', 'porcentaje', 'monto'].includes(tipo) ? tipo : 'ninguno';
      const val = Math.max(0, Number(valor) || 0);
      if (tipoSeguro === 'ninguno' || base <= 0 || val <= 0) return { tipo: 'ninguno', valor: 0, monto: 0, total: base };
      if (tipoSeguro === 'porcentaje') {
        const pct = Math.min(100, val);
        const monto = round2(base * (pct / 100));
        return { tipo: tipoSeguro, valor: pct, monto, total: round2(base - monto) };
      }
      const monto = Math.min(base, round2(val));
      return { tipo: tipoSeguro, valor: monto, monto, total: round2(base - monto) };
    }

    function getDiscountPayload(tab, subtotal) {
      if (!hasPermission('ordenes.discount')) return null;
      const tipo = document.getElementById(`descuento-tipo-${tab}`)?.value || 'ninguno';
      const valor = document.getElementById(`descuento-valor-${tab}`)?.value || 0;
      const motivo = document.getElementById(`descuento-motivo-${tab}`)?.value?.trim() || '';
      const descuento = calcularDescuentoLocal(subtotal, tipo, valor);
      return { tipo: descuento.tipo, valor: descuento.valor, motivo };
    }

    function getValidatedDiscountPayload(tab, subtotal, statusEl = null) {
      const payload = getDiscountPayload(tab, subtotal);
      if (!payload) return null;
      const calculado = calcularDescuentoLocal(subtotal, payload.tipo, payload.valor);
      if (calculado.monto > 0 && !payload.motivo) {
        const message = 'El motivo del descuento es requerido';
        if (statusEl) setStatus(statusEl, message);
        else showToast(message, 'AVISO');
        document.getElementById(`descuento-motivo-${tab}`)?.focus();
        return { error: message };
      }
      return payload;
    }

    function setDiscountControls(tab, data = {}) {
      const tipoEl = document.getElementById(`descuento-tipo-${tab}`);
      const valorEl = document.getElementById(`descuento-valor-${tab}`);
      const motivoEl = document.getElementById(`descuento-motivo-${tab}`);
      if (!tipoEl || !valorEl || !motivoEl) return;
      tipoEl.value = data.tipo || data.descuento_tipo || 'ninguno';
      valorEl.value = Number(data.valor ?? data.descuento_valor ?? 0) || '';
      motivoEl.value = data.motivo || data.descuento_motivo || '';
    }

    function renderDiscountPanels() {
      const canDiscount = hasPermission('ordenes.discount');
      const nuevaPanel = document.getElementById('discount-panel-nueva');
      if (nuevaPanel) nuevaPanel.style.display = canDiscount ? '' : 'none';

      const editPanel = document.getElementById('discount-panel-edit');
      if (!editPanel) return;
      const lockedByPayment = Number(ordenActual?.pagado || 0) > 0;
      const lockedByState = ordenActual && !['pendiente', 'en_proceso'].includes(ordenActual.estado);
      editPanel.style.display = canDiscount && ordenActual ? '' : 'none';
      editPanel.querySelectorAll('input, select, button').forEach(el => {
        el.disabled = !canDiscount || lockedByPayment || lockedByState;
      });
      const note = document.getElementById('discount-edit-note');
      if (note) {
        note.textContent = lockedByPayment
          ? 'El descuento no se puede cambiar porque la orden ya tiene pagos.'
          : lockedByState ? 'El descuento no se puede cambiar en una orden finalizada.' : '';
      }
    }

    function isOrderTotalLocked() {
      return Boolean(ordenActual) &&
        (Number(ordenActual.pagado || 0) > 0 || !['pendiente', 'en_proceso'].includes(ordenActual.estado));
    }

    function getOrderTotalLockReason() {
      if (!ordenActual) return '';
      if (Number(ordenActual.pagado || 0) > 0) return 'la orden ya tiene pagos registrados';
      if (!['pendiente', 'en_proceso'].includes(ordenActual.estado)) return `la orden esta ${ordenActual.estado}`;
      return '';
    }

    function renderDiscountSummary(tab, subtotal) {
      const payload = getDiscountPayload(tab, subtotal) || { tipo: 'ninguno', valor: 0 };
      const descuento = calcularDescuentoLocal(subtotal, payload.tipo, payload.valor);
      const subtotalEl = document.getElementById(tab === 'nueva' ? 'subtotal-nueva' : 'subtotal-edit-orden');
      const descuentoEl = document.getElementById(`descuento-monto-${tab}`);
      if (subtotalEl) subtotalEl.textContent = fmt(subtotal);
      if (descuentoEl) descuentoEl.textContent = fmt(descuento.monto);
      if (tab === 'edit') {
        const totalEl = document.getElementById('e-total');
        if (totalEl) totalEl.value = '$' + fmt(descuento.total);
      }
      return descuento;
    }

    function calcularEdadDesdeFecha(fechaNacimiento) {
      if (!fechaNacimiento) return null;
      const birth = new Date(`${fechaNacimiento}T00:00:00`);
      if (Number.isNaN(birth.getTime())) return null;
      const now = new Date();
      let edad = now.getFullYear() - birth.getFullYear();
      const mes = now.getMonth() - birth.getMonth();
      if (mes < 0 || (mes === 0 && now.getDate() < birth.getDate())) edad -= 1;
      return edad >= 0 && edad <= 149 ? edad : null;
    }

    function formatBirthDate(fechaNacimiento) {
      if (!fechaNacimiento) return '';
      const date = new Date(`${fechaNacimiento}T00:00:00`);
      if (Number.isNaN(date.getTime())) return fechaNacimiento;
      return date.toLocaleDateString('es-MX', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    }
    
    /**
     * Sanitiza texto para insercion segura en el DOM (previene XSS).
     * Usar SIEMPRE en lugar de innerHTML con datos del servidor.
     */
    function esc(str) {
      const div = document.createElement('div');
      div.appendChild(document.createTextNode(String(str ?? '')));
      return div.innerHTML;
    }
    
    function setStatus(el, text, type = 'error') {
      el.textContent = text;
      el.className = type;
      el.style.display = text ? 'block' : 'none';
    }
    
    let _toastTimer = null;
    function showToast(msg, emoji = 'OK') {
      const t = document.getElementById('toast');
      t.textContent = `${emoji} ${msg}`;
      t.classList.add('show');
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
    }
    
    function authHeaders(extra = {}) {
      return { Authorization: 'Bearer ' + token, ...extra };
    }
    
    async function apiFetch(url, options = {}) {
      if (window.LabApi?.apiFetch) return window.LabApi.apiFetch(url, options);
      const res = await fetch(url, options);
      if (res.status === 401 || res.status === 403) { logout(); return null; }
      return res;
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       TABS
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function switchTab(tab) {
      document.getElementById('pane-nueva').style.display  = tab === 'nueva'  ? '' : 'none';
      document.getElementById('pane-buscar').style.display = tab === 'buscar' ? '' : 'none';
      document.getElementById('tab-nueva').classList.toggle('active', tab === 'nueva');
      document.getElementById('tab-buscar').classList.toggle('active', tab === 'buscar');
      // Enfocar buscador de estudios al abrir Nueva Orden (acelera flujo cajero)
      if (tab === 'nueva') {
        requestAnimationFrame(() => document.getElementById('search-nueva')?.focus());
      }
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       CARGAR ESTUDIOS
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    async function cargarEstudios() {
      try {
        const res = await apiFetch('/api/estudios', { headers: authHeaders() });
        if (!res) return;
        if (!res.ok) throw new Error('Error al cargar estudios');
    
        const data = await res.json();
        estudiosDisponibles = data.map(e => ({ ...e, categoria: e.categoria || 'OTROS' }));
    
        buildCategoryButtons('nueva');
        renderStudyList('nueva');
        buildCategoryButtons('edit');
        renderStudyList('edit');
      } catch (err) {
        console.error('cargarEstudios:', err);
      }
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       FILTRADO COMBINADO
       CategorÃ­a + live search (nombre o abreviatura)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function getEstudiosFiltrados(tab) {
      const catActiva    = tab === 'nueva' ? catActivaNueva : catActivaEdit;
      const searchTerm   = (tab === 'nueva' ? searchTermNueva : searchTermEdit).toLowerCase().trim();
      const asignadosIds = new Set(estudiosAsignados.map(e => e.estudio_id));
    
      return estudiosDisponibles.filter(e => {
        // En ediciÃ³n, ocultar estudios ya asignados
        if (tab === 'edit' && asignadosIds.has(e.id)) return false;
        // Filtro de categorÃ­a
        if (catActiva !== 'TODOS' && e.categoria !== catActiva) return false;
        // Live search: nombre o clave externa
        if (searchTerm) {
          const nombre = e.nombre.toLowerCase();
          const clave  = String(e.clave_externa || '');
          if (!nombre.includes(searchTerm) && !clave.includes(searchTerm)) return false;
        }
        return true;
      });
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       BOTONES DE CATEGORÃA
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function buildCategoryButtons(tab) {
      const cats = ['TODOS', ...new Set(estudiosDisponibles.map(e => e.categoria))].sort((a, b) => {
        if (a === 'TODOS') return -1;
        if (b === 'TODOS') return 1;
        return a.localeCompare(b);
      });
      const container = document.getElementById(`cat-filters-${tab}`);
      container.innerHTML = '';
    
      cats.forEach(cat => {
        const b = document.createElement('button');
        b.className = 'cat-btn' + (cat === 'TODOS' ? ' active' : '');
        b.dataset.cat = cat;
        b.textContent = cat;
        b.addEventListener('click', () => filtrarCategoria(b, tab));
        container.appendChild(b);
      });
    }
    
    function filtrarCategoria(btn, tab) {
      const container = document.getElementById(`cat-filters-${tab}`);
      container.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (tab === 'nueva') catActivaNueva = btn.dataset.cat;
      else                 catActivaEdit  = btn.dataset.cat;
      renderStudyList(tab);
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       RENDER LISTA COMPACTA DE ESTUDIOS
       Reemplaza el grid de tarjetas por una lista con scroll interno.
       Texto usando textContent (XSS-safe).
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function renderStudyList(tab) {
      const container    = document.getElementById(`estudios-${tab}`);
      const countEl      = document.getElementById(`estudios-count-${tab}`);
      const selEl        = document.getElementById(`estudios-sel-${tab}`);
      const seleccionados = tab === 'nueva' ? seleccionadosNueva : seleccionadosEdit;
    
      const visible = getEstudiosFiltrados(tab);
    
      const isLocked = tab === 'edit' && ordenActual &&
        (Number(ordenActual.pagado || 0) > 0 || ordenActual.estado === 'completado' || ordenActual.estado === 'cancelado');
    
      container.innerHTML = '';
    
      // Contadores
      if (countEl) countEl.textContent = `${visible.length} estudio${visible.length !== 1 ? 's' : ''}`;
      if (selEl)   selEl.textContent   = seleccionados.length > 0
        ? `${seleccionados.length} seleccionado${seleccionados.length !== 1 ? 's' : ''}`
        : '';
    
      if (visible.length === 0) {
        const p = document.createElement('div');
        p.className = 'estudios-empty';
        p.textContent = 'No se encontraron estudios con esos filtros.';
        container.appendChild(p);
        return;
      }
    
      // Fragmento para inserciÃ³n eficiente
      const frag = document.createDocumentFragment();
    
      visible.forEach(e => {
        const isSel = seleccionados.some(x => x.id === e.id);
        const row   = document.createElement('div');
        row.className = 'estudio-row' + (isSel ? ' selected' : '') + (isLocked ? ' locked' : '');
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', String(isSel));
        row.setAttribute('tabindex', isLocked ? '-1' : '0');
    
        // Checkmark â€” XSS-safe (textContent)
        const check = document.createElement('div');
        check.className = 'row-check';
        check.textContent = isSel ? 'OK' : '';
    
        // CategorÃ­a â€” XSS-safe
        const cat = document.createElement('div');
        cat.className = 'row-cat';
        cat.textContent = e.categoria;
    
        // Clave â€” XSS-safe
        const clave = document.createElement('div');
        clave.className = 'row-clave';
        clave.textContent = e.clave_externa || '';
    
        // Nombre â€” XSS-safe
        const nombre = document.createElement('div');
        nombre.className = 'row-nombre';
        nombre.textContent = e.nombre;
    
        // Precio â€” XSS-safe
        const precio = document.createElement('div');
        precio.className = 'row-precio';
        precio.textContent = '$' + fmt(e.precio);
    
        row.appendChild(check);
        row.appendChild(cat);
        row.appendChild(clave);
        row.appendChild(nombre);
        row.appendChild(precio);
    
        if (!isLocked) {
          row.addEventListener('click', () => toggleEstudio(e, row, tab));
          row.addEventListener('keydown', ev => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); row.click(); }
          });
        }
    
        frag.appendChild(row);
      });
    
      container.appendChild(frag);
    }
    
    function toggleEstudio(estudio, row, tab) {
      const arr = tab === 'nueva' ? seleccionadosNueva : seleccionadosEdit;
      const idx = arr.findIndex(x => x.id === estudio.id);
    
      if (idx !== -1) {
        arr.splice(idx, 1);
        row.classList.remove('selected');
        row.setAttribute('aria-checked', 'false');
        row.querySelector('.row-check').textContent = '';
      } else {
        arr.push(estudio);
        row.classList.add('selected');
        row.setAttribute('aria-checked', 'true');
        row.querySelector('.row-check').textContent = 'OK';
      }
    
      updateSummary(tab);
    
      // Actualizar contadores sin re-renderizar toda la lista
      const countEl = document.getElementById(`estudios-count-${tab}`);
      const selEl   = document.getElementById(`estudios-sel-${tab}`);
      const visible = getEstudiosFiltrados(tab);
      if (countEl) countEl.textContent = `${visible.length} estudio${visible.length !== 1 ? 's' : ''}`;
      if (selEl)   selEl.textContent   = arr.length > 0
        ? `${arr.length} seleccionado${arr.length !== 1 ? 's' : ''}`
        : '';
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       UPDATE SUMMARY
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function updateSummary(tab) {
      const arr   = tab === 'nueva' ? seleccionadosNueva : seleccionadosEdit;
      // round2 para evitar errores de punto flotante en acumulaciÃ³n
      const subtotal = round2(arr.reduce((s, e) => s + e.precio, 0));
      const total = tab === 'nueva' ? renderDiscountSummary(tab, subtotal).total : subtotal;
    
      if (tab === 'nueva') {
        document.getElementById('count-nueva').textContent = arr.length;
        document.getElementById('total-nueva').textContent = fmt(total);
      } else {
        document.getElementById('count-edit').textContent = arr.length;
        document.getElementById('total-edit').textContent = fmt(total);
        document.getElementById('edit-summary').style.display = arr.length > 0 ? 'flex' : 'none';
      }
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       TICKET TÃ‰RMICO â€” Sewoo SLK-T213EB (80mm Â· 203 DPI)
       â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
       buildTicketHtml(opts) â†’ genera el HTML del ticket.
       Centraliza la lÃ³gica para cotizaciÃ³n Y para ticket de orden,
       evitando duplicar cÃ³digo y posibles divergencias entre ambos.
    
       opts = {
         estudios   : Array<{nombre, precio}>   (requerido)
         tipoDoc    : 'COTIZACIÃ“N' | 'ORDEN'    (requerido)
         folio      : string | null             (solo en ORDEN)
         paciente   : string | null             (solo en ORDEN)
         sexo       : string | null             (M/F/O, solo ORDEN)
         fechaNacimiento : string | null        (solo en ORDEN)
         medico     : string | null
         medicoTel  : string | null
         empresa    : { nombre, direccion?, telefono?, correo?, rfc?, ruc?, logo? }
       }
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function buildTicketHtml(opts) {
      const {
        estudios,
        tipoDoc,
        folio      = null,
        paciente   = null,
        sexo       = null,
        fechaNacimiento = null,
        medico     = null,
        medicoTel  = null,
        descuento  = null,
        empresa    = {}
      } = opts;
    
      /* â”€â”€ Fecha y hora en formato compacto para el ancho de 72mm â”€â”€ */
      const ahora = new Date();
      const fecha = ahora.toLocaleDateString('es-MX', {
        day: '2-digit', month: '2-digit', year: 'numeric'
      });
      const hora = ahora.toLocaleTimeString('es-MX', {
        hour: '2-digit', minute: '2-digit', hour12: true
      });
    
      /* â”€â”€ Total con round2 para evitar artefactos de punto flotante â”€â”€ */
      const subtotal = round2(estudios.reduce((s, e) => s + e.precio, 0));
      const descuentoCalc = descuento
        ? calcularDescuentoLocal(subtotal, descuento.tipo, descuento.valor)
        : { monto: 0, total: subtotal };
      const total = descuentoCalc.total;
      const descuentoHtml = descuentoCalc.monto > 0
        ? `<div class="ticket-money-line"><span>SUBTOTAL</span><span>$${fmt(subtotal)}</span></div>
           <div class="ticket-money-line"><span>DESCUENTO</span><span>-$${fmt(descuentoCalc.monto)}</span></div>
           ${descuento?.motivo ? `<div class="ticket-kv"><span class="k">MOTIVO:</span><span class="v">${esc(descuento.motivo)}</span></div>` : ''}`
        : '';
    
      /* â”€â”€ Cabecera de empresa â”€â”€ */
      const logoHtml = empresa.logo
        ? `<div class="ticket-logo-wrap"><img src="${esc(empresa.logo)}" alt="logo" loading="eager"></div>`
        : '';
    
      const nombreEmpresa = empresa.nombre
        ? `<h2>${esc(empresa.nombre)}</h2>` : '';
    
      const infoLines = [
        empresa.direccion ? esc(empresa.direccion) : '',
        empresa.telefono  ? 'Tel: ' + esc(empresa.telefono) : '',
        empresa.correo    ? esc(empresa.correo) : '',
        /* RFC y RUC en una sola lÃ­nea para ahorrar espacio vertical */
        [
          empresa.rfc ? 'RFC: ' + esc(empresa.rfc) : '',
          empresa.ruc ? 'RUC: ' + esc(empresa.ruc) : ''
        ].filter(Boolean).join(' - ')
      ].filter(Boolean).map(l => `<p>${l}</p>`).join('');
    
      /* â”€â”€ Tipo de documento â”€â”€ */
      const doctype = `<div class="ticket-doctype">*** ${esc(tipoDoc)} ***</div>`;
    
      /* â”€â”€ Folio (solo en Ã³rdenes) â”€â”€ */
      const folioHtml = folio
        ? `<div class="ticket-folio">${esc(folio)}</div>` : '';
    
      /* â”€â”€ Datos del paciente (solo en Ã³rdenes) â”€â”€ */
      let pacienteHtml = '';
      if (paciente) {
        const sexoLabel = sexo === 'M' ? 'Masculino' : sexo === 'F' ? 'Femenino' : sexo || '';
        const fechaNacimientoLabel = fechaNacimiento ? formatBirthDate(fechaNacimiento) : '';
        pacienteHtml = `
          <div class="ticket-kv">
            <span class="k">PACIENTE:</span>
            <span class="v">${esc(paciente)}</span>
          </div>
          ${(sexoLabel || fechaNacimientoLabel) ? `
          <div class="ticket-kv">
            ${sexoLabel ? `<span class="k">SEXO:</span><span class="v">${esc(sexoLabel)}</span>` : ''}
            ${(sexoLabel && fechaNacimientoLabel) ? '&nbsp;&nbsp;' : ''}
            ${fechaNacimientoLabel ? `<span class="k">NAC.:</span><span class="v">${esc(fechaNacimientoLabel)}</span>` : ''}
          </div>` : ''}
        `;
      }
    
      /* Medico */
      const medicoHtml = medico
        ? `<div class="ticket-kv">
             <span class="k">MEDICO:</span>
             <span class="v">${esc(medico)}${medicoTel ? ' &middot; ' + esc(medicoTel) : ''}</span>
           </div>`
        : '';
    
      /* â”€â”€ Filas de estudios â”€â”€ */
      /*
        Sewoo SLK-T213EB: ~42 chars por lÃ­nea a 9pt Courier New.
        Nombres largos se quiebran automÃ¡ticamente (word-break: break-word).
        El precio se ancla a la derecha con flex.
      */
      const rowsHtml = estudios.map(e =>
        `<div class="ticket-row">
           <span class="estudio-name">${esc(e.nombre)}</span>
           <span class="estudio-price">$${fmt(e.precio)}</span>
         </div>`
      ).join('');
    
      const indicaciones = estudios
        .filter(e => String(e.indicaciones || '').trim())
        .map(e => `<div class="ticket-indicacion">* ${esc(e.nombre)}: ${esc(String(e.indicaciones).trim())}</div>`)
        .join('');
    
      const indicacionesHtml = indicaciones
        ? `<hr class="ticket-sep">
           <div class="ticket-indicaciones">
             <div class="ticket-indicaciones-title">INDICACIONES</div>
             ${indicaciones}
           </div>`
        : '';
    
      /* Pie de documento */
      const footerText = tipoDoc === 'COTIZACION'
        ? 'Cotizacion sin valor fiscal. Precios sujetos a cambio sin previo aviso.'
        : 'Conserve este documento. Tiempo de entrega sujeto a estudio.';
    
      /* â”€â”€ HTML final â”€â”€ */
      return `
        ${logoHtml}
        <div class="ticket-header">
          ${nombreEmpresa}
          ${infoLines}
        </div>
        ${doctype}
        <hr class="ticket-sep">
        <div class="ticket-kv">
          <span class="k">FECHA:</span><span class="v">${esc(fecha)}</span>
          &nbsp;&nbsp;
          <span class="k">HORA:</span><span class="v">${esc(hora)}</span>
        </div>
        ${folioHtml}
        ${pacienteHtml}
        ${medicoHtml}
        <hr class="ticket-sep">
        ${rowsHtml}
        ${indicacionesHtml}
        <hr class="ticket-sep">
        ${descuentoHtml}
        <div class="ticket-total">
          <span>TOTAL</span>
          <span>$${fmt(total)}</span>
        </div>
        <hr class="ticket-sep">
        <div class="ticket-footer">${esc(footerText)}</div>
      `;
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       HELPER: carga datos de empresa (con cachÃ© de sesiÃ³n simple)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    let _empresaCache = null;
    async function getEmpresa(force = false) {
      if (!force && _empresaCache) return _empresaCache;
      try {
        const r = await apiFetch('/api/empresa', { headers: authHeaders() });
        if (r && r.ok) {
          _empresaCache = await r.json();
          return _empresaCache;
        }
      } catch (_) {}
      return { nombre: 'LABORATORIO' };
    }
    function clearEmpresaCache() {
      _empresaCache = null;
    }
    window.addEventListener('empresa-updated', clearEmpresaCache);
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       HELPER: render ticket â†’ print
       Usa beforeprint/afterprint para limpiar sin race conditions.
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function renderYImprimir(html) {
      let container = document.getElementById('ticket-print');
      if (!container) {
        container = document.createElement('div');
        container.id = 'ticket-print';
        container.setAttribute('aria-hidden', 'true');
        container.style.display = 'none';
        document.body.appendChild(container);
      }

      container.innerHTML = html;

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.print();
          const cleanUp = () => {
            if (container) {
              container.innerHTML = '';
              container.remove();
            }
            window.removeEventListener('afterprint', cleanUp);
          };
          window.addEventListener('afterprint', cleanUp);
        });
      });
    }

    function estimateTicketHeightMm({ estudios = [], empresa = {}, medico = null, medicoTel = null }) {
      const empresaLines = [
        empresa?.nombre,
        empresa?.direccion,
        empresa?.telefono,
        empresa?.correo,
        [empresa?.rfc ? `RFC: ${empresa.rfc}` : '', empresa?.ruc ? `RUC: ${empresa.ruc}` : ''].filter(Boolean).join(' - ')
      ].filter(Boolean).length;

      const estudiosLines = estudios.reduce((sum, estudio) => {
        const nombre = String(estudio?.nombre || '');
        const indicaciones = String(estudio?.indicaciones || '').trim();
        return sum
          + Math.max(1, Math.ceil(nombre.length / 26))
          + (indicaciones ? Math.max(1, Math.ceil(indicaciones.length / 34)) + 1 : 0);
      }, 0);

      const extraBlocks =
        22 +
        (empresaLines * 5) +
        (medico || medicoTel ? 8 : 0) +
        (estudios.length * 2.5) +
        (estudiosLines * 3.8);

      return Math.max(110, Math.min(320, Math.ceil(extraBlocks)));
    }

    function buildTicketPrintStyles(pageHeightMm) {
      return `
        <style>
          @page { size: 80mm ${pageHeightMm}mm; margin: 0; }
          html, body {
            margin: 0;
            padding: 0;
            background: #fff;
            color: #000;
            width: 80mm;
            font-family: 'Courier New', Courier, monospace;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          body {
            min-height: ${pageHeightMm}mm;
          }
          #ticket-print {
            box-sizing: border-box;
            width: 72mm;
            max-width: 72mm;
            margin: 0 auto;
            padding: 2mm 0 8mm 0;
            overflow: hidden;
            word-break: break-word;
            word-wrap: break-word;
            font-size: 9pt;
            line-height: 1.4;
            background: #fff;
            color: #000;
          }
          #ticket-print * {
            box-sizing: border-box;
            color: #000;
            background: #fff;
            box-shadow: none;
            text-shadow: none;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            page-break-inside: avoid;
          }
          #ticket-print .ticket-logo-wrap {
            text-align: center;
            margin-bottom: 3px;
          }
          #ticket-print .ticket-logo-wrap img {
            width: 180px;
            max-height: 56px;
            object-fit: contain;
            image-rendering: -webkit-optimize-contrast;
            image-rendering: crisp-edges;
          }
          #ticket-print .ticket-header {
            text-align: center;
            margin-bottom: 4px;
          }
          #ticket-print .ticket-header h2 {
            font-size: 11pt;
            font-weight: bold;
            margin: 0 0 1px;
            letter-spacing: 0.3px;
            text-transform: uppercase;
          }
          #ticket-print .ticket-header p {
            font-size: 7.5pt;
            margin: 0;
            line-height: 1.3;
          }
          #ticket-print .ticket-folio {
            text-align: center;
            font-size: 10pt;
            font-weight: bold;
            letter-spacing: 0.8px;
            margin: 4px 0;
            border-top: 1px solid #000;
            border-bottom: 1px solid #000;
            padding: 2px 0;
          }
          #ticket-print .ticket-sep {
            border: none;
            border-top: 1px dashed #000;
            margin: 3px 0;
            width: 100%;
          }
          #ticket-print .ticket-kv {
            font-size: 8pt;
            margin-bottom: 1.5px;
            display: flex;
            gap: 3px;
            align-items: baseline;
            flex-wrap: wrap;
          }
          #ticket-print .ticket-kv .k {
            font-weight: bold;
            white-space: nowrap;
            flex-shrink: 0;
          }
          #ticket-print .ticket-kv .v {
            flex: 1 1 auto;
            min-width: 0;
            word-break: break-word;
          }
          #ticket-print .ticket-row {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 4px;
            margin-bottom: 2px;
            font-size: 8.5pt;
            line-height: 1.35;
          }
          #ticket-print .ticket-row .estudio-name {
            flex: 1;
            min-width: 0;
            word-break: break-word;
          }
          #ticket-print .ticket-row .estudio-price {
            white-space: nowrap;
            font-weight: bold;
            flex-shrink: 0;
          }
          #ticket-print .ticket-money-line {
            display: flex;
            justify-content: space-between;
            font-size: 8.5pt;
            line-height: 1.25;
          }
          #ticket-print .ticket-indicaciones {
            margin-top: 6px;
            font-size: 7.5pt;
            line-height: 1.35;
          }
          #ticket-print .ticket-indicaciones-title {
            font-size: 8pt;
            font-weight: bold;
            margin-bottom: 3px;
            letter-spacing: 0.4px;
          }
          #ticket-print .ticket-indicacion {
            margin-bottom: 2px;
            word-break: break-word;
          }
          #ticket-print .ticket-total {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11pt;
            font-weight: bold;
            margin-top: 2px;
            padding-top: 1px;
          }
          #ticket-print .ticket-footer {
            text-align: center;
            font-size: 7pt;
            margin-top: 6px;
            line-height: 1.4;
          }
          #ticket-print .ticket-doctype {
            text-align: center;
            font-size: 9pt;
            font-weight: bold;
            letter-spacing: 1px;
            margin: 3px 0 1px;
            text-transform: uppercase;
          }
        </style>
      `;
    }

    function printTicketPopup({ html, title = 'Imprimir ticket', pageHeightMm = 140 }) {
      const printWindow = window.open('', '_blank', 'width=520,height=760');
      if (!printWindow) {
        throw new Error('El navegador bloqueo la ventana de impresion');
      }
      const styles = buildTicketPrintStyles(pageHeightMm);
      printWindow.document.open();
      printWindow.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title>${styles}</head><body><div id="ticket-print">${html}</div></body></html>`);
      printWindow.document.close();
      printWindow.focus();

      const finish = () => {
        try { printWindow.close(); } catch {}
      };

      printWindow.addEventListener('afterprint', finish, { once: true });
      setTimeout(() => printWindow.print(), 120);
    }

    function sexoPacienteLabel(value) {
      if (value === 'M') return 'Masculino';
      if (value === 'F') return 'Femenino';
      if (value === 'O') return 'Otro';
      return '';
    }

    async function registrarImpresionEtiquetas(folio) {
      try {
        await apiFetch(`/api/orden/${encodeURIComponent(folio)}/etiquetas/registrar-impresion`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' })
        });
      } catch (err) {
        console.error('registrarImpresionEtiquetas:', err);
      }
    }

    function buildLabelSheetHtml({ orden, etiquetas, empresa }) {
      const empresaNombre = esc(empresa?.nombre || 'LABORATORIO');
      const pacienteNombreRaw =
        orden?.paciente_nombre ||
        orden?.paciente?.nombre ||
        orden?.nombre ||
        '';
      const paciente = esc(pacienteNombreRaw || 'Paciente sin nombre');
      const folio = esc(orden?.folio || '');
      const fechaNacimiento = formatBirthDate(orden?.paciente_fecha_nacimiento);
      const sexoPaciente = esc(sexoPacienteLabel(orden?.paciente_sexo) || 'Paciente');
      const fechaOrdenRaw = String(orden?.fecha || '').trim();
      let fechaHoraEtiqueta = esc(fechaOrdenRaw.replace('T', ' ').slice(0, 16));
      if (fechaOrdenRaw) {
        const parsed = new Date(fechaOrdenRaw.includes('T') ? fechaOrdenRaw : fechaOrdenRaw.replace(' ', 'T'));
        if (!Number.isNaN(parsed.getTime())) {
          fechaHoraEtiqueta = esc(
            `${parsed.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' })} ${parsed.toLocaleTimeString('es-MX', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false
            })}`
          );
        }
      }

      return etiquetas.map((item) => {
        const tituloTubo = [item.tipo_tubo, item.color_tapa].filter(Boolean).map(esc).join(' / ') || 'Tubo sin definir';
        const muestra = esc(item.tipo_muestra || 'Muestra no especificada');
        const area = esc(item.area_proceso || 'Sin area');
        const estudios = esc(item.estudios_resumen || 'Sin estudios asociados');
        const indice = Number(item.total_tubos_grupo || 1) > 1
          ? `<div class="lb-chip">Tubo ${esc(String(item.indice_tubo || 1))}/${esc(String(item.total_tubos_grupo || 1))}</div>`
          : `<div class="lb-chip">1 tubo</div>`;

        return `
          <div class="label-page">
            <section class="tube-label">
              <div class="lb-top">
                <div class="lb-top-main">
                  <div class="lb-company">${empresaNombre}</div>
                  <div class="lb-patient">Paciente: ${paciente}</div>
                </div>
                ${indice}
              </div>
              <div class="lb-meta-row">
                <span class="lb-meta lb-folio">Folio: ${folio}</span>
              </div>
              <div class="lb-meta-row">
                <span class="lb-meta">${sexoPaciente}</span>
                <span class="lb-meta lb-meta-time">${fechaHoraEtiqueta}</span>
              </div>
              <div class="lb-meta-row lb-meta-row-full">
                <span class="lb-meta lb-meta-full">Nac: ${esc(fechaNacimiento || 'Sin fecha')}</span>
              </div>
              <div class="lb-box">
                <div class="lb-title">${tituloTubo}</div>
                <div class="lb-sub">Muestra: ${muestra}</div>
                <div class="lb-sub">Area: ${area}</div>
              </div>
              <div class="lb-studies">${estudios}</div>
            </section>
          </div>
        `;
      }).join('');
    }

    async function imprimirEtiquetasPorFolio(folio) {
      const res = await apiFetch(`/api/orden/${encodeURIComponent(folio)}/etiquetas`, {
        headers: authHeaders()
      });
      if (!res) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'No se pudieron cargar las etiquetas');
      }

      const payload = await res.json();
      if (!Array.isArray(payload.etiquetas) || payload.etiquetas.length === 0) {
        showToast('La orden no tiene etiquetas para imprimir', 'AVISO');
        return;
      }

      const printWindow = window.open('', '_blank', 'width=520,height=760');
      if (!printWindow) {
        throw new Error('El navegador bloqueo la ventana de impresion');
      }

      const html = buildLabelSheetHtml(payload);
      const styles = `
        <style>
          @page { size: 38mm 25mm; margin: 0; }
          html, body {
            margin: 0;
            padding: 0;
            background: #fff;
            color: #000;
            font-family: Arial, Helvetica, sans-serif;
            width: 38mm;
            min-width: 38mm;
            max-width: 38mm;
            background: #fff;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          body { overflow: hidden; }
          .label-page {
            width: 38mm;
            height: 25mm;
            min-width: 38mm;
            max-width: 38mm;
            min-height: 25mm;
            max-height: 25mm;
            overflow: hidden;
            page-break-after: always;
            break-after: page;
            display: block;
          }
          .tube-label {
            width: 38mm;
            height: 25mm;
            box-sizing: border-box;
            padding: 1.1mm 1.2mm 1mm 1.2mm;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            overflow: hidden;
            page-break-after: always;
            break-after: page;
          }
          .lb-top {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 0.8mm;
          }
          .lb-top-main {
            display: flex;
            flex-direction: column;
            gap: 0.2mm;
            min-width: 0;
            max-width: 28mm;
          }
          .lb-company {
            font-size: 5.8pt;
            font-weight: 800;
            line-height: 1.05;
            text-transform: uppercase;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .lb-chip {
            border: 1px solid #000;
            border-radius: 999px;
            padding: 0.45mm 1mm;
            font-size: 4.9pt;
            font-weight: 700;
            white-space: nowrap;
          }
          .lb-patient {
            font-size: 5pt;
            font-weight: 700;
            line-height: 1.05;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .lb-meta-row {
            display: flex;
            justify-content: space-between;
            gap: 0.5mm;
            margin-top: 0.15mm;
          }
          .lb-meta {
            font-size: 4.45pt;
            line-height: 1.05;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
            flex: 1 1 0;
          }
          .lb-folio {
            flex-basis: 100%;
            font-size: 4.6pt;
            font-weight: 800;
            overflow: visible;
            text-overflow: clip;
          }
          .lb-meta-row-full {
            display: block;
          }
          .lb-meta-full {
            display: block;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .lb-meta-time {
            flex: 0 0 auto;
            max-width: 11.2mm;
            text-align: right;
          }
          .lb-box {
            border-top: 1px solid #000;
            border-bottom: 1px solid #000;
            padding: 0.35mm 0;
            margin-top: 0.25mm;
          }
          .lb-title {
            font-size: 5.6pt;
            font-weight: 800;
            line-height: 1.02;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          .lb-sub {
            font-size: 4.55pt;
            line-height: 1.02;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .lb-studies {
            font-size: 4.25pt;
            line-height: 1.02;
            margin-top: 0.25mm;
            display: -webkit-box;
            -webkit-line-clamp: 1;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
        </style>
      `;

      printWindow.document.open();
      printWindow.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas ${esc(folio)}</title>${styles}</head><body>${html}</body></html>`);
      printWindow.document.close();
      printWindow.focus();

      const finish = async () => {
        await registrarImpresionEtiquetas(folio);
        printWindow.close();
      };

      printWindow.addEventListener('afterprint', finish, { once: true });
      setTimeout(() => printWindow.print(), 120);
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       GENERAR COTIZACION
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    async function generarCotizacion() {
      if (seleccionadosNueva.length === 0) {
        showToast('Selecciona al menos un estudio para cotizar', 'AVISO');
        return;
      }
    
      const empresa   = await getEmpresa(true);
      const medicoVal = document.getElementById('medico')?.value?.trim()            || null;
      const telVal    = document.getElementById('medico-telefono')?.value?.trim()   || null;
      const subtotalCotizacion = round2(seleccionadosNueva.reduce((s, e) => s + Number(e.precio || 0), 0));
      const descuentoCotizacion = getValidatedDiscountPayload('nueva', subtotalCotizacion);
      if (descuentoCotizacion?.error) return;
    
      const html = buildTicketHtml({
        estudios  : seleccionadosNueva,
        tipoDoc   : 'COTIZACION',
        medico    : medicoVal,
        medicoTel : telVal,
        descuento : descuentoCotizacion,
        empresa
      });
    
      const pageHeightMm = estimateTicketHeightMm({
        estudios: seleccionadosNueva,
        empresa,
        medico: medicoVal,
        medicoTel: telVal
      });

      printTicketPopup({
        html,
        title: 'Cotizacion',
        pageHeightMm
      });
    }
    
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       GUARDAR NUEVA ORDEN
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    async function guardar() {
      const statusEl = document.getElementById('status');
      setStatus(statusEl, '');
    
      const nombre         = document.getElementById('nombre').value.trim();
      const celular        = document.getElementById('celular').value.trim();
      const fechaNacimiento = document.getElementById('fecha-nacimiento').value;
      const edad           = calcularEdadDesdeFecha(fechaNacimiento);
      const sexo           = document.getElementById('sexo').value;
      const sucursal       = document.getElementById('sucursal').value;
      const medico         = document.getElementById('medico').value.trim();
      const medicoTelefono = document.getElementById('medico-telefono').value.trim();
      const subtotalOrden  = round2(seleccionadosNueva.reduce((s, e) => s + Number(e.precio || 0), 0));
      const descuentoOrden = getValidatedDiscountPayload('nueva', subtotalOrden, statusEl);
      if (descuentoOrden?.error) return;
    
      if (!nombre)                         { setStatus(statusEl, 'El nombre del paciente es requerido'); return; }
      if (!fechaNacimiento || !edad)       { setStatus(statusEl, 'Ingresa una fecha de nacimiento valida'); return; }
      if (!sexo)                           { setStatus(statusEl, 'Selecciona el sexo del paciente'); return; }
      if (seleccionadosNueva.length === 0) { setStatus(statusEl, 'Selecciona al menos un estudio'); return; }
    
      const btn = document.getElementById('btn-guardar');
      btn.disabled = true;
      btn.textContent = 'Guardando...';
    
      try {
        const res = await apiFetch('/api/orden', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            nombre, celular, fecha_nacimiento: fechaNacimiento, sexo, sucursal, medico,
            medico_telefono: medicoTelefono || null,
            estudios: seleccionadosNueva.map(e => e.id),
            ...(descuentoOrden ? { descuento: descuentoOrden } : {})
          })
        });
    
        if (!res) return;
    
        const result = await res.json();
        if (!res.ok) { setStatus(statusEl, result.error || 'Error al crear la orden'); return; }
    
        const msg = result.esNuevoPaciente
          ? `OK Orden ${result.folio} creada - Nuevo paciente registrado`
          : `OK Orden ${result.folio} creada`;
    
        setStatus(statusEl, msg, 'success');
        showToast(`Orden ${result.folio} creada`);
        try {
          await imprimirEtiquetasPorFolio(result.folio);
        } catch (printErr) {
          console.error('imprimirEtiquetasPorFolio:', printErr);
          showToast('Orden guardada, pero no se pudieron imprimir las etiquetas', 'AVISO');
        }
    
        // Reset form
        ['nombre', 'celular', 'fecha-nacimiento', 'medico', 'medico-telefono'].forEach(id => {
          document.getElementById(id).value = '';
        });
        document.getElementById('sexo').value = '';
        seleccionadosNueva = [];
        searchTermNueva    = '';
        document.getElementById('search-nueva').value = '';
        setDiscountControls('nueva');
        renderStudyList('nueva');
        updateSummary('nueva');
        // Devolver foco al buscador de estudios para la siguiente orden
        document.getElementById('search-nueva').focus();
    
      } catch (err) {
        console.error('guardar:', err);
        setStatus(statusEl, 'No se pudo conectar con el servidor');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Guardar orden';
      }
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       BUSCAR ORDEN POR FOLIO
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    async function buscarOrden() {
      const folio = document.getElementById('folio-input').value.trim().toUpperCase();
      if (!folio) { showToast('Ingresa un folio', 'AVISO'); return; }
    
      const btn = document.getElementById('btn-buscar');
      btn.disabled = true;
      btn.textContent = 'Buscando...';
    
      try {
        const res = await apiFetch(`/api/orden/${encodeURIComponent(folio)}`, {
          headers: authHeaders()
        });
    
        if (!res) return;
    
        if (res.status === 404) {
          showToast('Orden no encontrada', 'ERROR');
          document.getElementById('result-panel').style.display = 'none';
          document.getElementById('empty-search').style.display = '';
          ordenActual = null;
          return;
        }
    
        if (!res.ok) throw new Error('Error al buscar orden');
    
        const data = await res.json();
        ordenActual       = data.orden;
        estudiosAsignados = data.estudios || [];
        seleccionadosEdit = [];
    
        renderOrden();
        document.getElementById('result-panel').style.display = '';
        document.getElementById('empty-search').style.display = 'none';
        document.getElementById('btn-limpiar-busqueda').style.display = '';
    
      } catch (err) {
        console.error('buscarOrden:', err);
        showToast('Error al buscar la orden', 'ERROR');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Buscar';
      }
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       RENDER ORDEN CARGADA
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function renderOrden() {
      const o          = ordenActual;
      const isEditable = o.estado === 'pendiente' || o.estado === 'en_proceso';
      const canEditTotals = isEditable && Number(o.pagado || 0) <= 0;
      const isLocked   = !isEditable;
    
      const ESTADO_LABELS = {
        pendiente:   'Pendiente',
        en_proceso:  'En proceso',
        completado:  'Completado',
        cancelado:   'Cancelado'
      };
    
      // textContent en lugar de innerHTML â€” XSS-safe
      document.getElementById('folio-display').textContent = o.folio;
      const badge = document.getElementById('estado-badge');
      badge.className = `estado-badge estado-${o.estado}`;
      badge.textContent = ESTADO_LABELS[o.estado] || o.estado;
    
      document.getElementById('e-nombre').value             = o.paciente_nombre  || '';
      document.getElementById('e-celular').value            = o.paciente_celular || '';
      document.getElementById('e-fecha-nacimiento').value   = o.paciente_fecha_nacimiento || '';
      document.getElementById('e-sexo').value               = o.paciente_sexo    || '';
      document.getElementById('e-sucursal').value           = o.sucursal         || '';
      document.getElementById('e-medico').value             = o.medico           || '';
      document.getElementById('e-medico-telefono').value    = o.medico_telefono  || '';
      document.getElementById('e-fecha').value              = o.fecha            || '';
      document.getElementById('e-total').value              = '$' + fmt(o.total);
      setDiscountControls('edit', o);
      const subtotalOrden = round2(o.subtotal || estudiosAsignados.reduce((s, e) => s + Number(e.precio || 0), 0));
      const descuentoOrden = calcularDescuentoLocal(subtotalOrden, o.descuento_tipo, o.descuento_valor);
      const subtotalEditEl = document.getElementById('subtotal-edit-orden');
      const descuentoEditEl = document.getElementById('descuento-monto-edit');
      if (subtotalEditEl) subtotalEditEl.textContent = fmt(subtotalOrden);
      if (descuentoEditEl) descuentoEditEl.textContent = fmt(descuentoOrden.monto);
      renderDiscountPanels();
    
      ['e-nombre', 'e-celular', 'e-fecha-nacimiento', 'e-sexo', 'e-sucursal', 'e-medico', 'e-medico-telefono'].forEach(id => {
        document.getElementById(id).disabled = isLocked;
      });
      document.getElementById('btn-guardar-paciente').disabled = isLocked;
    
      const notice = document.getElementById('readonly-notice');
      if (!canEditTotals) {
        notice.style.display = '';
        document.getElementById('readonly-reason').textContent = getOrderTotalLockReason() || o.estado;
        document.getElementById('add-studies-section').style.display = 'none';
      } else {
        notice.style.display = 'none';
        document.getElementById('add-studies-section').style.display = '';
      }
    
      renderAssignedStudies(canEditTotals);
      renderStudyList('edit');
      updateSummary('edit');
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       RENDER ASSIGNED STUDIES (XSS-safe)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function renderAssignedStudies(isEditable) {
      const container = document.getElementById('assigned-studies');
      container.innerHTML = '';
    
      if (estudiosAsignados.length === 0) {
        const p = document.createElement('p');
        p.style.cssText = 'color:var(--muted);font-size:14px;';
        p.textContent = 'Sin estudios asignados.';
        container.appendChild(p);
        return;
      }
    
      estudiosAsignados.forEach(e => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg);border-radius:8px;margin-bottom:8px;';
    
        const left   = document.createElement('div');
        const catTag = document.createElement('span');
        catTag.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;color:var(--muted);margin-right:8px;';
        catTag.textContent = (e.categoria || 'OTROS') + ' - ';
        const claveTag = document.createElement('span');
        claveTag.style.cssText = 'font-family:"DM Mono",monospace;font-size:11px;font-weight:500;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin-right:8px;';
      claveTag.textContent = e.clave_externa || ''; // textContent â€” XSS-safe
        const name = document.createElement('span');
        name.style.cssText = 'font-size:14px;font-weight:600;';
        name.textContent = e.nombre; // textContent â€” XSS-safe
        left.appendChild(catTag);
        left.appendChild(claveTag);
        left.appendChild(name);
    
        const right = document.createElement('div');
        right.style.cssText = 'display:flex;align-items:center;gap:10px;';
    
        const price = document.createElement('span');
        price.style.cssText = 'font-family:"DM Mono",monospace;font-size:13px;color:var(--muted);';
        price.textContent = '$' + fmt(e.precio);
        right.appendChild(price);
    
        if (isEditable) {
          const btnDel = document.createElement('button');
          btnDel.className = 'btn btn-danger';
          btnDel.style.cssText = 'padding:5px 10px;font-size:12px;';
          btnDel.textContent = 'X';
          btnDel.title = 'Quitar estudio';
          btnDel.addEventListener('click', () => quitarEstudioAsignado(e));
          right.appendChild(btnDel);
        }
    
        row.appendChild(left);
        row.appendChild(right);
        container.appendChild(row);
      });
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       QUITAR ESTUDIO ASIGNADO
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    async function quitarEstudioAsignado(estudio) {
      if (isOrderTotalLocked()) {
        showToast(`No se pueden modificar estudios porque ${getOrderTotalLockReason()}.`, 'AVISO');
        return;
      }
      if (!confirm(`Quitar "${estudio.nombre}" de esta orden?`)) return;
    
      try {
        const res = await apiFetch(`/api/orden/${ordenActual.folio}/estudio/${estudio.id}`, {
          method: 'DELETE',
          headers: authHeaders()
        });
    
        if (!res) return;
    
        if (!res.ok) {
          const data = await res.json();
          showToast(data.error || 'Error al quitar estudio', 'ERROR');
          return;
        }
    
        const data = await res.json().catch(() => ({}));
        estudiosAsignados = estudiosAsignados.filter(e => e.id !== estudio.id);
        ordenActual = data.orden || {
          ...ordenActual,
          total: round2(estudiosAsignados.reduce((s, e) => s + e.precio, 0)),
          subtotal: round2(estudiosAsignados.reduce((s, e) => s + e.precio, 0)),
        };
        document.getElementById('e-total').value = '$' + fmt(ordenActual.total);
    
        renderAssignedStudies(true);
        renderStudyList('edit');
        renderOrden();
        showToast(`"${estudio.nombre}" quitado`, 'OK');
    
      } catch (err) {
        console.error('quitarEstudioAsignado:', err);
        showToast('Error al conectar', 'ERROR');
      }
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       GUARDAR DATOS PACIENTE (incluye medico_telefono en la orden)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    async function guardarPaciente() {
      const statusEl = document.getElementById('status-edit');
      setStatus(statusEl, '');
    
      const nombre         = document.getElementById('e-nombre').value.trim();
      const fechaNacimiento = document.getElementById('e-fecha-nacimiento').value;
      const edad           = calcularEdadDesdeFecha(fechaNacimiento);
      const sexo           = document.getElementById('e-sexo').value;
      const medico         = document.getElementById('e-medico').value.trim();
      const medicoTelefono = document.getElementById('e-medico-telefono').value.trim();
    
      if (!nombre)           { setStatus(statusEl, 'El nombre es requerido'); return; }
      if (!fechaNacimiento || !edad) { setStatus(statusEl, 'Fecha de nacimiento invalida'); return; }
      if (!sexo)             { setStatus(statusEl, 'Selecciona el sexo'); return; }
    
      const btn = document.getElementById('btn-guardar-paciente');
      btn.disabled = true;
      btn.textContent = 'Guardando...';
    
      try {
        // 1. Actualizar datos del paciente
        const resPac = await apiFetch(`/api/pacientes/${ordenActual.paciente_id}`, {
          method: 'PUT',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            nombre,
            celular: document.getElementById('e-celular').value.trim() || null,
            fecha_nacimiento: fechaNacimiento,
            sexo,
          })
        });
    
        if (!resPac) return;
        if (!resPac.ok) {
          const data = await resPac.json();
          setStatus(statusEl, data.error || 'Error al guardar paciente');
          return;
        }
    
        // 2. Actualizar mÃ©dico y telÃ©fono del mÃ©dico en la orden
        const resOrden = await apiFetch(`/api/orden/${ordenActual.folio}/medico`, {
          method: 'PATCH',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            medico:          medico || null,
            medico_telefono: medicoTelefono || null,
          })
        });
    
        if (!resOrden) return;
        if (!resOrden.ok) {
          const data = await resOrden.json();
          // No bloquear si el endpoint no existe aÃºn â€” solo aviso
          console.warn('guardarPaciente/medico:', data.error);
        }
    
        showToast('Datos del paciente actualizados');
    
      } catch (err) {
        console.error('guardarPaciente:', err);
        setStatus(statusEl, 'Error al conectar');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Guardar cambios del paciente';
      }
    }

    async function guardarDescuentoEdit() {
      if (!ordenActual) return;
      const statusEl = document.getElementById('status-edit');
      setStatus(statusEl, '');
      const subtotal = round2(ordenActual.subtotal || estudiosAsignados.reduce((s, e) => s + Number(e.precio || 0), 0));
      if (isOrderTotalLocked()) {
        setStatus(statusEl, `No se puede modificar el descuento porque ${getOrderTotalLockReason()}.`);
        return;
      }
      const descuento = getValidatedDiscountPayload('edit', subtotal, statusEl);
      if (!descuento) return;
      if (descuento.error) return;

      const btn = document.getElementById('btn-guardar-descuento');
      btn.disabled = true;
      btn.textContent = 'Guardando...';

      try {
        const res = await apiFetch(`/api/orden/${ordenActual.folio}/descuento`, {
          method: 'PATCH',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(descuento)
        });

        if (!res) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(statusEl, data.error || 'Error al guardar descuento');
          return;
        }

        ordenActual = data.orden || ordenActual;
        renderOrden();
        showToast('Descuento actualizado');
      } catch (err) {
        console.error('guardarDescuentoEdit:', err);
        setStatus(statusEl, 'Error al conectar');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Guardar descuento';
      }
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       GUARDAR ESTUDIOS (EDICIÃ“N)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    async function guardarEstudiosEdit() {
      if (seleccionadosEdit.length === 0) return;
    
      const statusEl = document.getElementById('status-edit');
      setStatus(statusEl, '');
      if (isOrderTotalLocked()) {
        setStatus(statusEl, `No se pueden modificar estudios porque ${getOrderTotalLockReason()}.`);
        return;
      }
    
      const btn = document.getElementById('btn-guardar-estudios');
      btn.disabled = true;
      btn.textContent = 'Guardando...';
    
      try {
        const res = await apiFetch(`/api/orden/${ordenActual.folio}/estudios`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ estudios: seleccionadosEdit.map(e => e.id) })
        });
    
        if (!res) return;
    
        if (!res.ok) {
          const data = await res.json();
          setStatus(statusEl, data.error || 'Error al agregar estudios');
          return;
        }

        const data = await res.json().catch(() => ({}));
    
        estudiosAsignados = [...estudiosAsignados, ...seleccionadosEdit.map(e => ({ ...e, estudio_id: e.id }))];
        ordenActual = data.orden || {
          ...ordenActual,
          total: round2((ordenActual.total || 0) + seleccionadosEdit.reduce((s, e) => s + e.precio, 0)),
          subtotal: round2((ordenActual.subtotal || ordenActual.total || 0) + seleccionadosEdit.reduce((s, e) => s + e.precio, 0)),
        };
        document.getElementById('e-total').value = '$' + fmt(ordenActual.total);
    
        seleccionadosEdit = [];
        renderAssignedStudies(true);
        renderStudyList('edit');
        updateSummary('edit');
        renderOrden();
        showToast('Estudios agregados a la orden');
    
      } catch (err) {
        console.error('guardarEstudiosEdit:', err);
        setStatus(statusEl, 'Error al conectar');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Guardar cambios de estudios';
      }
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       LIMPIAR BÃšSQUEDA
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    function limpiarBusqueda() {
      document.getElementById('folio-input').value           = '';
      document.getElementById('result-panel').style.display  = 'none';
      document.getElementById('empty-search').style.display  = '';
      document.getElementById('btn-limpiar-busqueda').style.display = 'none';
      ordenActual       = null;
      estudiosAsignados = [];
      seleccionadosEdit = [];
      searchTermEdit    = '';
      if (document.getElementById('search-edit')) {
        document.getElementById('search-edit').value = '';
      }
    }
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       EVENT LISTENERS
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    document.getElementById('btn-guardar').addEventListener('click', guardar);
    document.getElementById('btn-cotizacion').addEventListener('click', generarCotizacion);
    document.getElementById('btn-buscar').addEventListener('click', buscarOrden);
    document.getElementById('btn-limpiar-busqueda').addEventListener('click', limpiarBusqueda);
    document.getElementById('btn-guardar-paciente').addEventListener('click', guardarPaciente);
    document.getElementById('btn-guardar-estudios').addEventListener('click', guardarEstudiosEdit);
    document.getElementById('btn-guardar-descuento')?.addEventListener('click', guardarDescuentoEdit);
    ['descuento-tipo-nueva', 'descuento-valor-nueva', 'descuento-motivo-nueva'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => updateSummary('nueva'));
      document.getElementById(id)?.addEventListener('change', () => updateSummary('nueva'));
    });
    ['descuento-tipo-edit', 'descuento-valor-edit', 'descuento-motivo-edit'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => {
        const subtotal = round2(ordenActual?.subtotal || estudiosAsignados.reduce((s, e) => s + Number(e.precio || 0), 0));
        renderDiscountSummary('edit', subtotal);
      });
      document.getElementById(id)?.addEventListener('change', () => {
        const subtotal = round2(ordenActual?.subtotal || estudiosAsignados.reduce((s, e) => s + Number(e.precio || 0), 0));
        renderDiscountSummary('edit', subtotal);
      });
    });
    document.getElementById('folio-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') buscarOrden();
    });
    
    // Live search â€” Nueva Orden
    document.getElementById('search-nueva').addEventListener('input', e => {
      searchTermNueva = e.target.value;
      renderStudyList('nueva');
    });
    
    // Live search â€” EdiciÃ³n
    document.getElementById('search-edit').addEventListener('input', e => {
      searchTermEdit = e.target.value;
      renderStudyList('edit');
    });
    
    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       INIT
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    window.switchTab = switchTab;
      renderDiscountPanels();
      updateSummary('nueva');
      cargarEstudios();
  }

  async function mountNuevaOrden(containerId, { embedded = false } = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (embedded) setDashboardStylesEnabled(true);

    if (container.dataset.loaded === '1') {
      return;
    }

    const template = document.getElementById(TEMPLATE_ID);
    if (!template) throw new Error('No se encontró la plantilla integrada de nueva orden');
    container.innerHTML = template.innerHTML;
    container.dataset.loaded = '1';

    if (embedded) {
      const topbar = container.querySelector('.topbar');
      if (topbar) topbar.remove();
      const localToast = container.querySelector('#toast');
      if (localToast) localToast.remove();
      const page = container.querySelector('.nueva-orden-page');
      if (page) {
        page.style.padding = '0';
        page.style.minHeight = 'auto';
      }
    }

    initNuevaOrdenApp();
  }

  window.initDashboardNuevaOrdenView = function () {
    return mountNuevaOrden('dashboard-nueva-orden-root', { embedded: true });
  };

  window.setNuevaOrdenStylesEnabled = setDashboardStylesEnabled;
})();


