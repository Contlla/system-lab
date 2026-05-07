(function () {
'use strict';
/* ═══════════════════════════════════════════════════════════════
   SEGURIDAD — AUTH inmediata antes de DOMContentLoaded

   NOTA sobre sessionStorage vs localStorage:
   - sessionStorage es correcto aquí: el token vive sólo en la
     pestaña activa, no persiste entre sesiones, y no es accesible
     desde otros orígenes. La mitigación principal contra XSS es
     la función esc() estricta + textContent en toda inserción
     de datos dinámicos, ya que ningún almacenamiento en JS es
     inmune a un XSS real: la defensa primaria es evitar el XSS.
   - Se añade expiración de token en cliente (TOKEN_TTL_MS).
   - Limpieza automática en 401/403 via apiFetch.
═══════════════════════════════════════════════════════════════ */

  const TOKEN_TTL_MS  = 8 * 60 * 60 * 1000; // 8 horas
  const token         = sessionStorage.getItem('token');
  const tokenIssuedAt = Number(sessionStorage.getItem('tokenIssuedAt') || 0);

  // Verificar token y TTL
  const tokenExpired = tokenIssuedAt && (Date.now() - tokenIssuedAt > TOKEN_TTL_MS);

  if (!token || token === 'undefined' || tokenExpired) {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('role');
    sessionStorage.removeItem('permissions');
    sessionStorage.removeItem('tokenIssuedAt');
    window.location.replace('/index.html');
  }

  function getTokenPayload() {
    try {
      return JSON.parse(atob(token.split('.')[1]));
    } catch {
      return {};
    }
  }

  const authUser = getTokenPayload();

  function getCurrentPermissions() {
    if (Array.isArray(authUser.permissions)) return authUser.permissions;
    try {
      const stored = JSON.parse(sessionStorage.getItem('permissions') || '[]');
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  function can(permission) {
    return getCurrentPermissions().includes(permission);
  }

/* ═══════════════════════════════════════════════════════════════
   HELPERS GLOBALES
═══════════════════════════════════════════════════════════════ */

  /**
   * SEGURO FRENTE A XSS — Sanitizador para innerHTML de tickets.
   * Todos los datos de la API que se inserten en innerHTML DEBEN
   * pasar por esta función sin excepción.
   * Cubre: &, <, >, ", ', ` y el backtick para plantillas.
   */
  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;')
      .replace(/`/g,  '&#96;');
  }

  function parseMoneyInput(value) {
    const raw = String(value ?? '').trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  /**
   * ARITMÉTICA SEGURA — Trabaja en centavos (enteros) para evitar
   * errores de punto flotante. p.ej. 10.00 - 9.99 = 0.01 exacto.
   * Uso: sumar/restar siempre con centsAdd/centsRound.
   */
  function toCents(amount) {
    // Redondear al centavo más cercano antes de convertir
    return Math.round(Number(amount) * 100);
  }

  function fromCents(cents) {
    return cents / 100;
  }

  function centsAdd(a, b)  { return toCents(a) + toCents(b); }
  function centsSub(a, b)  { return toCents(a) - toCents(b); }

  /** Formatea un número como moneda MXN */
  function fmt(n) {
    return '$' + (Number(n) || 0).toLocaleString('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /** Muestra un toast de notificación temporal */
  function showToast(msg, icon = '✅', durationMs = 3000) {
    document.getElementById('toast-msg').textContent  = msg;
    document.getElementById('toast-icon').textContent = icon;
    const t = document.getElementById('toast');
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), durationMs);
  }

  /** Cierra sesión, limpiando todo el storage */
  function getOrdenDiscountSummary(orden = {}, estudios = []) {
    const subtotalEstudios = (estudios || []).reduce((acc, e) => acc + Number(e.precio || 0), 0);
    const subtotalOrden = Number(orden.subtotal || 0) > 0 ? Number(orden.subtotal) : subtotalEstudios;
    let descuentoMonto = Math.max(0, Number(orden.descuento_monto || 0));

    if (
      descuentoMonto <= 0 &&
      orden.descuento_tipo &&
      orden.descuento_tipo !== 'ninguno' &&
      String(orden.descuento_motivo || '').trim()
    ) {
      descuentoMonto = Math.max(0, Math.round((subtotalOrden - Number(orden.total || 0)) * 100) / 100);
    }

    return {
      subtotal: subtotalOrden,
      descuento: descuentoMonto,
      motivo: String(orden.descuento_motivo || '').trim(),
    };
  }

  function logout() {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('role');
    sessionStorage.removeItem('permissions');
    sessionStorage.removeItem('tokenIssuedAt');
    window.location.replace('/index.html');
  }

  /** Actualiza un elemento de estado */
  function setStatus(id, text, type = 'error') {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className   = 'status-msg ' + type;
  }

  /**
   * Establece estado loading en un botón.
   * Retorna una función para restaurar el estado.
   */
  function setBtnLoading(btn, loadingText = '') {
    btn.disabled = true;
    btn.classList.add('loading');
    const textEl = btn.querySelector('.btn-text');
    const orig   = textEl ? textEl.textContent : btn.textContent;
    if (textEl && loadingText) textEl.textContent = loadingText;
    return function restore(newText) {
      btn.disabled = false;
      btn.classList.remove('loading');
      if (textEl) textEl.textContent = newText || orig;
    };
  }

/* ═══════════════════════════════════════════════════════════════
   SEGURIDAD — WRAPPER apiFetch
   - Inyecta Authorization header
   - Manejo automático de 401/403 → logout + limpieza
   - Detección de errores de red (offline)
   - Timeout configurable para evitar requests colgados
═══════════════════════════════════════════════════════════════ */
  async function apiFetch(url, options = {}, timeoutMs = 12000) {
    if (window.LabApi?.apiFetch) {
      return window.LabApi.apiFetch(url, options);
    }
    const controller = new AbortController();
    const timerId    = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        Authorization: 'Bearer ' + token,
        ...(options.headers || {}),
      };
      const res = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        logout();
        return null;
      }
      return res;

    } catch (err) {
      if (err.name === 'AbortError') {
        throw new TypeError('timeout');
      }
      throw err; // re-lanzar para que el caller maneje
    } finally {
      clearTimeout(timerId);
    }
  }

/* ═══════════════════════════════════════════════════════════════
   HELPERS DE FECHA — Robusto para fechas SQLite
═══════════════════════════════════════════════════════════════ */

  function fechaHoy() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function parseFechaSQLite(fechaStr) {
    if (!fechaStr) return null;
    const normalizado = String(fechaStr).replace(' ', 'T');
    const d = new Date(normalizado);
    return isNaN(d.getTime()) ? null : d;
  }

  function horaDesde(fechaStr) {
    const d = parseFechaSQLite(fechaStr);
    if (!d) return fechaStr || '—';
    try {
      return new Intl.DateTimeFormat('es-MX', {
        hour: 'numeric', minute: '2-digit', hour12: true,
      }).format(d);
    } catch (_) {
      return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    }
  }

  function fechaHoraDesde(fechaStr) {
    const d = parseFechaSQLite(fechaStr);
    if (!d) return fechaStr || '—';
    try {
      return new Intl.DateTimeFormat('es-MX', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      }).format(d);
    } catch (_) {
      return d.toLocaleString('es-MX');
    }
  }

/* ═══════════════════════════════════════════════════════════════
   DETECCIÓN OFFLINE
═══════════════════════════════════════════════════════════════ */
  function updateOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    if (!navigator.onLine) {
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }
  }
  window.addEventListener('online',  updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);
  updateOfflineBanner();

/* ═══════════════════════════════════════════════════════════════
   LÓGICA PRINCIPAL — DOMContentLoaded
═══════════════════════════════════════════════════════════════ */
  (function () {

    const canViewCuts = can('caja.history');
    const canCreateCut = can('caja.cut');
    const canViewAnalytics = can('caja.analytics');

    if (!canViewCuts) {
      const tabCortes = document.querySelector('.tab-btn[data-tab="cortes"]');
      if (tabCortes) tabCortes.style.display = 'none';
    }
    if (!canCreateCut) {
      const btnCorte = document.getElementById('btn-corte');
      if (btnCorte) btnCorte.style.display = 'none';
    }
    if (!canViewAnalytics) {
      const panelComparativa = document.getElementById('panel-comparativa');
      if (panelComparativa) panelComparativa.style.display = 'none';
    }

    /* ── TABS ── */
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'cortes' && !canViewCuts) return;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'historial') cargarHistorial();
        if (btn.dataset.tab === 'cortes') {
          cargarCortes();
          if (canViewAnalytics) cargarComparativa();
        }
      });
    });

    /* ═══════════════════════════
       RESUMEN DEL DÍA
    ═══════════════════════════ */
    async function cargarResumenDia() {
      try {
        const res = await apiFetch('/api/caja/historial?fecha=' + fechaHoy());
        if (!res) return;
        const data = await res.json();
        const t = data.totales;

        document.getElementById('sc-total').textContent         = fmt(t.total_general);
        document.getElementById('sc-efectivo').textContent      = fmt(t.total_efectivo);
        document.getElementById('sc-tarjeta').textContent       = fmt(t.total_tarjeta);
        document.getElementById('sc-transferencia').textContent = fmt(t.total_transferencia);
        document.getElementById('sc-num-pagos').textContent     =
          `${t.num_pagos} pago${t.num_pagos !== 1 ? 's' : ''}`;

        const subTitle = document.getElementById('sc-sub-corte');
        if (subTitle) {
          subTitle.textContent = data.desde_corte
            ? `Desde corte de las ${horaDesde(data.desde_corte)}`
            : 'Acumulado del día';
        }

        document.getElementById('cp-efectivo').textContent = fmt(t.total_efectivo);
        document.getElementById('cp-tarjeta').textContent  = fmt(t.total_tarjeta);
        document.getElementById('cp-transfer').textContent = fmt(t.total_transferencia);
        document.getElementById('cp-num').textContent      = t.num_pagos;
        document.getElementById('cp-total').textContent    = fmt(t.total_general);

        const cpDesde = document.getElementById('cp-desde');
        if (cpDesde) {
          cpDesde.textContent = data.desde_corte
            ? `Período: desde las ${horaDesde(data.desde_corte)}`
            : 'Período: inicio del día';
        }

        renderPagosRecientes(data.pagos);

      } catch (err) {
        console.error('cargarResumenDia:', err);
        if (err.message === 'timeout' || err.message === 'Failed to fetch') {
          showToast('Sin conexión — el resumen no pudo actualizarse', '⚠️');
        }
      }
    }

    /* ═══════════════════════════
       PAGOS RECIENTES
    ═══════════════════════════ */
    function renderPagosRecientes(pagos) {
      const wrap = document.getElementById('pagos-recientes-wrap');
      wrap.textContent = '';

      if (!pagos || pagos.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        const ico  = document.createElement('div'); ico.className  = 'empty-icon';  ico.textContent = '💳';
        const tit  = document.createElement('div'); tit.className  = 'empty-title'; tit.textContent = 'Sin pagos hoy';
        const sub  = document.createElement('div'); sub.className  = 'empty-sub';   sub.textContent = 'Los pagos del día aparecerán aquí';
        empty.appendChild(ico); empty.appendChild(tit); empty.appendChild(sub);
        wrap.appendChild(empty);
        return;
      }

      const list = document.createElement('div');
      list.className = 'pagos-recientes';

      pagos.slice(0, 20).forEach(p => {
        const item    = document.createElement('div');
        item.className = 'pago-item';

        const left    = document.createElement('div');
        const folioEl = document.createElement('div');
        folioEl.className   = 'pago-folio';
        folioEl.textContent = p.folio_orden;

        const nombreEl = document.createElement('div');
        nombreEl.className   = 'pago-nombre';
        nombreEl.textContent = p.paciente_nombre || '—';
        left.appendChild(folioEl);
        left.appendChild(nombreEl);

        const right   = document.createElement('div');
        right.style.cssText = 'display:flex;align-items:center;gap:10px;';

        const montoEl = document.createElement('div');
        montoEl.className   = 'pago-monto';
        montoEl.textContent = fmt(p.monto);

        const badgeEl = document.createElement('span');
        // SEGURIDAD: badge className usa allowlist de valores de la API,
        // no concatenación directa en HTML.
        const metodoSafe = ['efectivo','tarjeta','transferencia'].includes(p.metodo) ? p.metodo : 'efectivo';
        badgeEl.className   = `badge badge-${metodoSafe}`;
        badgeEl.textContent = p.metodo;

        const btnTk = document.createElement('button');
        btnTk.className   = 'pago-btn-ticket';
        btnTk.textContent = '🖨️';
        btnTk.title       = 'Imprimir ticket';
        btnTk.addEventListener('click', () => imprimirTicketPorFolio(p.folio_orden));

        right.appendChild(montoEl);
        right.appendChild(badgeEl);
        right.appendChild(btnTk);
        item.appendChild(left);
        item.appendChild(right);
        list.appendChild(item);
      });

      wrap.appendChild(list);
    }

    /* ═══════════════════════════════════════════════════════════════

       BUSCAR ORDEN PARA COBRAR
    ═══════════════════════════════════════════════════════════════ */
    let ordenActual    = null;
    let metodoPago     = 'efectivo';
    let splitPagos     = [];   // Pagos mixtos acumulados (sólo en frontend, aún no enviados)
    let _historialData = null;
    let _cortesData    = null;

    async function buscarOrden() {
      // SEGURIDAD: Sanitizar el folio antes de usarlo en URL
      const folioRaw = document.getElementById('folio-input').value.trim().toUpperCase();
      // Solo letras, números y guiones — rechazar caracteres inesperados
      const folio = folioRaw.replace(/[^A-Z0-9\-]/g, '');
      if (!folio) { setStatus('cobro-status', 'Ingresa un folio'); return; }

      const btnBuscar = document.getElementById('btn-buscar-orden');
      const restore   = setBtnLoading(btnBuscar, 'Buscando...');

      setStatus('cobro-status', '');
      document.getElementById('orden-info').style.display = 'none';
      ordenActual = null;
      splitPagos  = [];

      try {
        const res = await apiFetch('/api/caja/orden/' + encodeURIComponent(folio));
        if (!res) return;

        if (res.status === 404) { setStatus('cobro-status', '❌ Orden no encontrada'); return; }
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setStatus('cobro-status', d.error || 'Error ' + res.status);
          return;
        }

        const data  = await res.json();
        ordenActual = data;
        renderOrdenCard(data);
        renderSplitUI();
        document.getElementById('orden-info').style.display = 'block';

      } catch (err) {
        if (err.message === 'timeout') {
          setStatus('cobro-status', '⚠️ Tiempo de espera agotado — verifica tu conexión');
        } else {
          setStatus('cobro-status', '⚠️ Error de conexión — intenta de nuevo');
        }
        console.error('buscarOrden:', err);
      } finally {
        restore('Buscar');
      }
    }

    /* ═══════════════════════════
       RENDER ORDEN CARD
       (100% textContent — sin innerHTML con datos dinámicos)
    ═══════════════════════════ */
    function renderOrdenCard(data) {
      const { orden, estudios, pagos } = data;
      const card = document.getElementById('orden-card');
      card.textContent = '';

      const folioDv = document.createElement('div');
      folioDv.className   = 'orden-folio';
      folioDv.textContent = orden.folio;

      const pacDv = document.createElement('div');
      pacDv.className   = 'orden-paciente';
      pacDv.textContent = orden.paciente_nombre;

      const estList = document.createElement('div');
      estList.className = 'estudios-list';
      (estudios || []).forEach(e => {
        const row = document.createElement('div');
        row.className = 'estudio-item';
        const nm = document.createElement('span'); nm.textContent = '• ' + e.nombre;
        const pr = document.createElement('span'); pr.textContent = fmt(e.precio);
        row.appendChild(nm); row.appendChild(pr);
        estList.appendChild(row);
      });

      // Saldo efectivo restante = saldo de API menos pagos mixtos aún no enviados
      const saldoPendiente = getSaldoPendiente();

      const descuentoResumen = getOrdenDiscountSummary(orden, estudios);
      const descuentoMonto = descuentoResumen.descuento;
      const subtotalOrden = descuentoResumen.subtotal;

      const rows = [];
      if (descuentoMonto > 0) {
        rows.push(['Subtotal', fmt(subtotalOrden), '']);
        rows.push(['Descuento', '-' + fmt(descuentoMonto), 'val-green']);
        if (descuentoResumen.motivo) rows.push(['Motivo', descuentoResumen.motivo, '']);
      }
      rows.push(
        ['Total orden', fmt(orden.total),         ''],
        ['Pagado',      fmt(orden.pagado),         'val-green'],
        ['Saldo',       fmt(orden.saldo),          orden.saldo > 0 ? 'val-red' : 'val-green'],
      );

      const table = document.createElement('div');
      table.style.marginTop = '10px';

      rows.forEach(([lbl, val, cls]) => {
        const row = document.createElement('div');
        row.className = 'orden-row';
        const l = document.createElement('span'); l.className = 'lbl'; l.textContent = lbl;
        const v = document.createElement('span'); v.className = `val ${cls}`; v.textContent = val;
        row.appendChild(l); row.appendChild(v);
        table.appendChild(row);
      });

      // Pagos ya registrados en la API
      if (pagos && pagos.length > 0) {
        const ph = document.createElement('div');
        ph.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-top:10px;margin-bottom:4px;';
        ph.textContent = 'Pagos registrados';
        table.appendChild(ph);

        pagos.forEach(p => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;font-size:12px;padding:3px 0;';
          const l = document.createElement('span');
          l.style.color = 'var(--muted)';
          l.textContent = `${p.metodo} · ${horaDesde(p.fecha)}`;
          const v = document.createElement('span');
          v.style.fontWeight = '600';
          v.textContent      = fmt(p.monto);
          row.appendChild(l); row.appendChild(v);
          table.appendChild(row);
        });
      }

      if (orden.saldo <= 0) {
        const alerta = document.createElement('div');
        alerta.style.cssText = 'margin-top:10px;padding:8px;background:var(--green-bg);border-radius:6px;font-size:12px;font-weight:700;color:var(--green-dark);text-align:center;';
        alerta.textContent = '✅ Esta orden ya está completamente pagada';
        card.appendChild(folioDv); card.appendChild(pacDv);
        card.appendChild(estList); card.appendChild(table);
        card.appendChild(alerta);
        return;
      }

      card.appendChild(folioDv); card.appendChild(pacDv);
      card.appendChild(estList); card.appendChild(table);
    }

    /* ═══════════════════════════════════════════════════════════════
       MÉTODO DE PAGO — Selección
    ═══════════════════════════════════════════════════════════════ */
    document.querySelectorAll('.metodo-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.metodo-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        metodoPago = btn.dataset.metodo;

        const refField = document.getElementById('referencia-field');
        const refLabel = document.getElementById('referencia-label');
        if (metodoPago !== 'efectivo') {
          refField.style.display = 'flex';
          refLabel.textContent = metodoPago === 'tarjeta'
            ? 'Número de autorización (opcional)'
            : 'Referencia de transferencia (opcional)';
        } else {
          refField.style.display = 'none';
          document.getElementById('referencia-input').value = '';
        }
        actualizarCambioYBotones();
      });
    });

    document.getElementById('monto-input').addEventListener('input', actualizarCambioYBotones);

    /* ═══════════════════════════════════════════════════════════════
       LÓGICA DE PAGOS MIXTOS — Split Payments
    ═══════════════════════════════════════════════════════════════ */

    /**
     * Retorna el saldo pendiente en centavos, restando los pagos
     * mixtos acumulados en el frontend (aún no enviados a la API).
     * Trabajamos en centavos para evitar errores de punto flotante.
     */
    function getSaldoPendienteCents() {
      if (!ordenActual) return 0;
      const saldoApiCents = toCents(ordenActual.orden.saldo);
      const pagosCents    = splitPagos.reduce((acc, p) => acc + toCents(p.monto), 0);
      return Math.max(0, saldoApiCents - pagosCents);
    }

    function getSaldoPendiente() {
      return fromCents(getSaldoPendienteCents());
    }

    function getTotalSplitCents() {
      return splitPagos.reduce((acc, p) => acc + toCents(p.monto), 0);
    }

    /** Actualiza toda la UI de pagos mixtos */
    function renderSplitUI() {
      if (!ordenActual) return;

      const saldoApiCents      = toCents(ordenActual.orden.saldo);
      const saldoPendienteCents = getSaldoPendienteCents();
      const totalSplitCents    = getTotalSplitCents();
      const saldoPendiente     = fromCents(saldoPendienteCents);
      const hasSplitPagos      = splitPagos.length > 0;
      const ordenPagada        = saldoApiCents <= 0;

      // ── Barra de progreso ──
      const progressWrap  = document.getElementById('saldo-progress-wrap');
      const progressFill  = document.getElementById('saldo-progress-fill');
      const progressPct   = document.getElementById('saldo-progress-pct');

      if (hasSplitPagos && !ordenPagada) {
        progressWrap.style.display = 'block';
        const pct = Math.min(100, Math.round((totalSplitCents / saldoApiCents) * 100));
        progressFill.style.width = pct + '%';
        progressPct.textContent  = pct + '%';
      } else {
        progressWrap.style.display = 'none';
      }

      // ── Chips de pagos parciales ──
      const chipsList = document.getElementById('split-pagos-lista');
      chipsList.textContent = '';

      if (hasSplitPagos) {
        chipsList.style.display = 'flex';
        splitPagos.forEach((p, idx) => {
          const chip = document.createElement('div');
          chip.className = 'split-pago-chip';

          const left = document.createElement('div');
          left.className = 'chip-left';

          const badge = document.createElement('span');
          const metodoSafe = ['efectivo','tarjeta','transferencia'].includes(p.metodo) ? p.metodo : 'efectivo';
          badge.className   = `chip-metodo-badge ${metodoSafe}`;
          badge.textContent = p.metodo.toUpperCase();

          const monto = document.createElement('span');
          monto.className   = 'chip-monto';
          monto.textContent = fmt(p.monto);

          left.appendChild(badge);
          left.appendChild(monto);

          if (p.referencia) {
            const ref = document.createElement('span');
            ref.className   = 'chip-ref';
            ref.textContent = '· ' + p.referencia;
            left.appendChild(ref);
          }

          const btnRemove = document.createElement('button');
          btnRemove.className   = 'chip-remove';
          btnRemove.textContent = '✕';
          btnRemove.title       = 'Quitar este pago';
          btnRemove.addEventListener('click', () => {
            splitPagos.splice(idx, 1);
            renderSplitUI();
            actualizarCambioYBotones();
          });

          chip.appendChild(left);
          chip.appendChild(btnRemove);
          chipsList.appendChild(chip);
        });
      } else {
        chipsList.style.display = 'none';
      }

      // ── Panel saldo restante ──
      const srbBox   = document.getElementById('saldo-restante-box');
      const srbLabel = document.getElementById('srb-label');
      const srbValue = document.getElementById('srb-value');

      if (hasSplitPagos && !ordenPagada) {
        srbBox.style.display = 'flex';
        srbBox.className     = 'saldo-restante-box';
        srbLabel.textContent = 'Saldo restante';
        srbValue.textContent = fmt(saldoPendiente);
      } else {
        srbBox.style.display = 'none';
      }

      // ── Título de sección ──
      const secTitle = document.getElementById('split-section-title');
      secTitle.textContent = hasSplitPagos ? 'Agregar otro pago' : 'Método de pago';

      // ── Monto sugerido ──
      if (!ordenPagada) {
        document.getElementById('monto-input').value = saldoPendiente > 0
          ? saldoPendiente.toFixed(2)
          : '';
      }

      // ── Botón limpiar split ──
      document.getElementById('btn-limpiar-split-wrap').style.display =
        hasSplitPagos ? 'block' : 'none';

      // Actualizar botones y cambio
      actualizarCambioYBotones();

      // Ocultar add-pago-section si la orden ya está pagada
      document.getElementById('add-pago-section').style.display =
        ordenPagada ? 'none' : 'block';
    }

    /**
     * Actualiza la caja de cambio y el estado de los botones
     * Agregar pago / Finalizar cobro.
     * SEGURIDAD: todo el cálculo se hace en centavos (enteros).
     */
    function actualizarCambioYBotones() {
      if (!ordenActual) return;

      const saldoPendienteCents = getSaldoPendienteCents();
      const montoInputRaw       = parseMoneyInput(document.getElementById('monto-input').value) || 0;
      // SEGURIDAD: rechazar montos negativos o cero en la UI
      const montoInput          = Math.max(0, montoInputRaw);
      const montoInputCents     = toCents(montoInput);
      const ordenPagada         = toCents(ordenActual.orden.saldo) <= 0;

      const cambioBox    = document.getElementById('cambio-box');
      const btnCobrar    = document.getElementById('btn-cobrar');
      const btnAgregar   = document.getElementById('btn-agregar-pago');

      if (ordenPagada) {
        // Orden ya estaba pagada
        cambioBox.classList.remove('show');
        btnCobrar.disabled  = true;
        btnAgregar.style.display = 'none';
        btnCobrar.style.display  = 'inline-flex';
        return;
      }

      // Calcular cambio sólo para efectivo y sólo cuando el monto supera el saldo pendiente
      const cambioEfectivoCents = (metodoPago === 'efectivo')
        ? Math.max(0, montoInputCents - saldoPendienteCents)
        : 0;

      if (cambioEfectivoCents > 0) {
        document.getElementById('cambio-amount').textContent = fmt(fromCents(cambioEfectivoCents));
        cambioBox.classList.add('show');
      } else {
        cambioBox.classList.remove('show');
      }

      // Estado de los botones:
      // Saldo pendiente queda en 0 con este pago → mostrar sólo "Registrar Pago"
      // Saldo pendiente no queda en 0 → mostrar "Agregar pago" y desactivar "Registrar Pago"
      const saldoDespuesCents = Math.max(0, saldoPendienteCents - montoInputCents);
      const cubreConCambio    = montoInputCents >= saldoPendienteCents;

      if (cubreConCambio || saldoPendienteCents === 0) {
        // El monto cubre el saldo (con posible cambio)
        btnAgregar.style.display = 'none';
        btnCobrar.style.display  = 'inline-flex';
        btnCobrar.disabled       = montoInput <= 0;

      } else {
        // Todavía queda saldo por cubrir: permitir agregar pago parcial
        const montoValido = montoInput > 0 && montoInputCents <= saldoPendienteCents;
        btnAgregar.style.display = 'inline-flex';
        btnAgregar.disabled      = !montoValido;
        btnCobrar.style.display  = 'none';
      }
    }

    /**
     * Agrega un pago parcial a la lista local (no envía a la API todavía).
     * SEGURIDAD: valida monto en centavos, no permite negativos ni superar el saldo.
     */
    function agregarPagoParcial() {
      if (!ordenActual) return;

      const montoRaw   = parseMoneyInput(document.getElementById('monto-input').value);
      const referencia = document.getElementById('referencia-input').value.trim();

      // SEGURIDAD: validar monto en centavos (enteros), evitar punto flotante
      const montoCents         = montoRaw === null ? 0 : toCents(montoRaw);
      const saldoPendienteCents = getSaldoPendienteCents();

      if (montoCents <= 0) {
        setStatus('cobro-status', 'Ingresa un monto mayor a $0.00'); return;
      }
      if (montoCents > saldoPendienteCents) {
        setStatus('cobro-status',
          `El monto (${fmt(montoRaw)}) supera el saldo pendiente (${fmt(getSaldoPendiente())})`);
        return;
      }
      if (montoCents < 1) { // menos de 1 centavo
        setStatus('cobro-status', 'El monto mínimo es $0.01'); return;
      }

      splitPagos.push({
        metodo:     metodoPago,
        monto:      fromCents(montoCents), // guardar en pesos, pero calculado desde centavos
        referencia: referencia || '',
      });

      // Limpiar campo de referencia
      document.getElementById('referencia-input').value = '';
      document.getElementById('monto-input').value      = '';
      setStatus('cobro-status', '');
      renderSplitUI();
    }

    /**
     * REGISTRAR PAGO — Envía todos los pagos mixtos a la API en secuencia.
     * SEGURIDAD:
     * - Montos recalculados desde centavos (nunca se toma el valor raw del input para la API)
     * - Double-submit protegido con btn.disabled
     * - El monto enviado es Math.min(monto, saldoRestante) calculado en el servidor también
     */
    async function registrarPago() {
      if (!ordenActual) return;

      // Tomar el último pago desde el input actual (el que cubre el saldo)
      const montoFinalRaw  = parseMoneyInput(document.getElementById('monto-input').value);
      const referencia     = document.getElementById('referencia-input').value.trim();
      const saldoPendiente = getSaldoPendienteCents();

      if (montoFinalRaw === null || montoFinalRaw <= 0) {
        setStatus('cobro-status', 'Ingresa un monto válido'); return;
      }

      // SEGURIDAD: El monto enviado a la API es min(montoInput, saldoPendiente),
      // calculado en centavos. El cambio sólo se muestra en UI, nunca se envía.
      const montoCents         = toCents(montoFinalRaw);
      const montoAEnviarCents  = Math.min(montoCents, saldoPendiente);

      if (montoAEnviarCents < 1) {
        setStatus('cobro-status', 'El monto mínimo es $0.01'); return;
      }

      // Construir la lista final de pagos a enviar
      const pagosAEnviar = [
        ...splitPagos.map(p => ({
          metodo:    p.metodo,
          monto:     fromCents(toCents(p.monto)), // sanitizar a centavos y volver
          referencia: p.referencia || '',
        })),
        {
          metodo:    metodoPago,
          monto:     fromCents(montoAEnviarCents),
          referencia: referencia || '',
        },
      ];

      const folio = ordenActual.orden.folio;

      setStatus('cobro-status', '');

      const btnCobrar = document.getElementById('btn-cobrar');
      const restore   = setBtnLoading(btnCobrar, 'Procesando...');

      try {
        // Verificar conexión antes de intentar
        if (!navigator.onLine) {
          throw new TypeError('offline');
        }

        // Enviar pagos en secuencia
        let folioActual = folio;
        for (const pago of pagosAEnviar) {
          const res = await apiFetch('/api/caja/pago', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              folio:     folioActual,
              monto:     pago.monto,
              metodo:    pago.metodo,
              referencia: pago.referencia,
            }),
          });
          if (!res) return; // logout fue llamado

          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setStatus('cobro-status', data.error || `Error al registrar pago (${res.status})`);
            return;
          }
        }

        const pagoCount = pagosAEnviar.length;
        showToast(
          pagoCount === 1
            ? `Pago de ${fmt(pagosAEnviar[0].monto)} registrado ✔`
            : `${pagoCount} pagos mixtos registrados ✔`
        );

        // Limpiar estado split
        splitPagos = [];

        // Refrescar orden
        await buscarOrdenSilente(folio);
        await cargarResumenDia();
        setStatus('cobro-status', '');

        // Imprimir ticket automáticamente
        await imprimirTicketPorFolio(folio);

      } catch (err) {
        console.error('registrarPago:', err);
        if (err.message === 'offline') {
          setStatus('cobro-status', '⚠️ Sin conexión — verifica el WiFi e intenta de nuevo', 'warn');
        } else if (err.message === 'timeout') {
          setStatus('cobro-status', '⚠️ Tiempo de espera agotado — intenta de nuevo');
        } else {
          setStatus('cobro-status', '⚠️ Error de conexión — intenta de nuevo');
        }
      } finally {
        restore('✅ Registrar Pago');
      }
    }

    async function buscarOrdenSilente(folio) {
      try {
        const res = await apiFetch('/api/caja/orden/' + encodeURIComponent(folio));
        if (!res || !res.ok) return;
        const data   = await res.json();
        ordenActual  = data;
        renderOrdenCard(data);
        renderSplitUI();
      } catch (_) {}
    }

    /* ═══════════════════════════
       TICKET DE PAGO
       FIX XSS: esc() en TODOS los datos dinámicos de la API.
    ═══════════════════════════ */
    async function imprimirTicketPorFolio(folio) {
      try {
        const res = await apiFetch('/api/caja/orden/' + encodeURIComponent(folio));
        if (!res || !res.ok) return;
        const data = await res.json();
        generarTicketHTML(data);   /* renderYImprimir ya está dentro */
      } catch (err) {
        console.error('imprimirTicketPorFolio:', err);
      }
    }

    /* ═══════════════════════════════════════════════════════════════
       TICKET HELPERS — Sewoo SLK-T213EB
       ─────────────────────────────────────────────────────────────
       renderYImprimir(html)   → inyecta HTML y llama window.print()
                                  con doble rAF para garantizar que el
                                  DOM esté pintado antes de enviar a la
                                  impresora vía USB/Serial.
       ticketCompanyHTML(emp)  → cabecera de empresa reutilizable.
       generarTicketHTML(data) → ticket de pago de orden.
    ═══════════════════════════════════════════════════════════════ */
    function ensureTicketPrintHost() {
      const realDocument = window.document;
      let style = realDocument.getElementById('cj-ticket-print-style');
      if (!style) {
        style = realDocument.createElement('style');
        style.id = 'cj-ticket-print-style';
        style.textContent = `
          #cj-ticket-print-global { display: none; }
          @page { size: 80mm auto; margin: 0; }
          @media print {
            body > *:not(#cj-ticket-print-global) { display: none !important; }
            #cj-ticket-print-global {
              display: block !important;
              position: static !important;
              width: 72mm !important;
              min-width: 72mm !important;
              max-width: 72mm !important;
              margin: 0 !important;
              padding: 2mm 0 8mm 0 !important;
              background: #fff !important;
              color: #000 !important;
              overflow: hidden !important;
              page-break-after: always;
              font-family: 'Courier New', 'Liberation Mono', monospace;
              font-size: 9pt;
              line-height: 1.4;
              word-break: break-word;
              word-wrap: break-word;
            }
            #cj-ticket-print-global * {
              color: #000 !important;
              background: #fff !important;
              box-shadow: none !important;
              text-shadow: none !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            #cj-ticket-print-global .t-center { text-align: center; }
            #cj-ticket-print-global .t-right { text-align: right; }
            #cj-ticket-print-global .t-bold { font-weight: 700; }
            #cj-ticket-print-global .t-large { font-size: 11pt; font-weight: bold; }
            #cj-ticket-print-global .t-xlarge { font-size: 13pt; font-weight: bold; }
            #cj-ticket-print-global .t-muted { color: #333 !important; }
            #cj-ticket-print-global .t-line { border-top: 1px dashed #000; margin: 3px 0; height: 0; }
            #cj-ticket-print-global .t-sep { letter-spacing: 1px; }
            #cj-ticket-print-global .t-no-break { break-inside: avoid; page-break-inside: avoid; }
            #cj-ticket-print-global .t-logo {
              width: 180px;
              max-height: 56px;
              object-fit: contain;
              display: block;
              margin: 0 auto 3px;
              image-rendering: -webkit-optimize-contrast;
              image-rendering: crisp-edges;
            }
            #cj-ticket-print-global .t-block-title {
              margin: 2px 0 2px;
              font-size: 8pt;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.3px;
            }
            #cj-ticket-print-global .t-meta,
            #cj-ticket-print-global .t-money,
            #cj-ticket-print-global .t-list {
              width: 100%;
              border-collapse: collapse;
            }
            #cj-ticket-print-global .t-meta td,
            #cj-ticket-print-global .t-money td,
            #cj-ticket-print-global .t-list td {
              vertical-align: top;
              padding: 1px 0;
              font-size: 8.5pt;
              line-height: 1.35;
            }
            #cj-ticket-print-global .t-meta td:first-child,
            #cj-ticket-print-global .t-money td:first-child { width: 44%; }
            #cj-ticket-print-global .t-meta td:last-child,
            #cj-ticket-print-global .t-money td:last-child,
            #cj-ticket-print-global .t-list td:last-child {
              text-align: right;
              white-space: nowrap;
            }
            #cj-ticket-print-global .t-list td:first-child {
              width: auto;
              padding-right: 6px;
              word-break: break-word;
            }
            #cj-ticket-print-global .t-total {
              font-size: 11pt;
              font-weight: 700;
            }
            #cj-ticket-print-global .t-status-paid {
              margin-top: 4px;
              text-align: center;
              font-size: 10pt;
              font-weight: 700;
              letter-spacing: 1px;
            }
            #cj-ticket-print-global .t-doctype {
              text-align: center;
              font-size: 9pt;
              font-weight: bold;
              text-transform: uppercase;
              letter-spacing: 0.8px;
              margin: 2px 0;
            }
          }
        `;
        realDocument.head.appendChild(style);
      }

      let container = realDocument.getElementById('cj-ticket-print-global');
      if (!container) {
        container = realDocument.createElement('div');
        container.id = 'cj-ticket-print-global';
        realDocument.body.appendChild(container);
      }
      return container;
    }

    function renderYImprimir(html) {
      const container = ensureTicketPrintHost();
      container.innerHTML = html;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const cleanUp = () => {
            container.innerHTML = '';
            window.removeEventListener('afterprint', cleanUp);
          };
          window.addEventListener('afterprint', cleanUp);
          window.print();
          setTimeout(cleanUp, 60000);
        });
      });
    }

    function ticketCompanyHTML(emp = {}) {
      const logo = emp.logo
        ? `<div class="t-center t-no-break"><img src="${esc(emp.logo)}" alt="logo" class="t-logo"></div>`
        : '';
      const lines = [
        emp.direccion ? esc(emp.direccion) : '',
        emp.telefono  ? 'Tel: ' + esc(emp.telefono) : '',
        emp.correo    ? esc(emp.correo) : '',
        [emp.ruc ? 'RUC: ' + esc(emp.ruc) : '', emp.rfc ? 'RFC: ' + esc(emp.rfc) : '']
          .filter(Boolean).join(' · ')
      ].filter(Boolean).map(l => `<div class="t-center" style="font-size:8pt;">${l}</div>`).join('');
      return `
        ${logo}
        <div class="t-center t-large">${esc(emp.nombre || 'LABORATORIO')}</div>
        ${lines}
      `;
    }

    function generarTicketHTML(data) {
      const { orden, estudios, pagos, empresa } = data;
      const emp = empresa || {};

      const ultimoPago  = pagos && pagos.length > 0 ? pagos[pagos.length - 1] : null;
      const fechaTicket = ultimoPago
        ? fechaHoraDesde(ultimoPago.fecha)
        : fechaHoraDesde(orden.fecha);

      const linea = '<div class="t-line"></div>';

      let estudiosHTML     = '';
      let indicacionesHTML = '';
      (estudios || []).forEach(e => {
        estudiosHTML += `<tr><td>${esc(e.nombre)}</td><td>${esc(fmt(e.precio))}</td></tr>`;
        if (e.indicaciones) {
          indicacionesHTML += `<div style="font-size:8pt;margin:1px 0;">* ${esc(e.nombre)}: ${esc(e.indicaciones)}</div>`;
        }
      });

      const descuentoResumen = getOrdenDiscountSummary(orden, estudios);
      const descuentoMonto = descuentoResumen.descuento;
      const subtotalOrden = descuentoResumen.subtotal;
      const descuentoMotivo = descuentoResumen.motivo;
      const descuentoHTML = descuentoMonto > 0
        ? `<tr><td>SUBTOTAL:</td><td>${esc(fmt(subtotalOrden))}</td></tr>
           <tr><td>DESCUENTO:</td><td>-${esc(fmt(descuentoMonto))}</td></tr>
           ${descuentoMotivo ? `<tr><td colspan="2" class="t-muted" style="font-size:8pt;">Motivo: ${esc(descuentoMotivo)}</td></tr>` : ''}`
        : '';

      let pagosHTML = '';
      (pagos || []).forEach(p => {
        pagosHTML += `
          <tr>
            <td>${esc(p.metodo.toUpperCase())}</td>
            <td>${esc(fmt(p.monto))}</td>
          </tr>
          <tr>
            <td colspan="2" class="t-right t-muted" style="font-size:8pt;">${esc(fechaHoraDesde(p.fecha))}</td>
          </tr>`;
      });

      const html = `
        <div class="t-no-break">
          ${ticketCompanyHTML(emp)}
          ${linea}
          <div class="t-doctype">TICKET DE PAGO</div>
          <div class="t-center" style="font-size:8pt;">${esc(fechaTicket)}</div>
        </div>
        ${linea}
        <table class="t-meta t-no-break">
          <tr><td>Folio:</td><td>${esc(orden.folio)}</td></tr>
          <tr><td>Paciente:</td><td>${esc(orden.paciente_nombre)}</td></tr>
        </table>
        ${linea}
        <div class="t-block-title">Estudios</div>
        <table class="t-list t-no-break"><tbody>${estudiosHTML}</tbody></table>
        ${linea}
        <table class="t-money t-no-break">
          ${descuentoHTML}
          <tr class="t-total"><td>TOTAL ORDEN:</td><td>${esc(fmt(orden.total))}</td></tr>
        </table>
        <div class="t-block-title">Pagos</div>
        <table class="t-money t-no-break"><tbody>${pagosHTML}</tbody></table>
        ${linea}
        <table class="t-money t-no-break">
          <tr class="t-total"><td>SALDO:</td><td>${esc(fmt(orden.saldo))}</td></tr>
        </table>
        ${orden.saldo <= 0 ? '<div class="t-status-paid">*** PAGADO ***</div>' : ''}
        ${indicacionesHTML ? `${linea}<div class="t-block-title">INDICACIONES:</div>${indicacionesHTML}` : ''}
        ${linea}
        <div class="t-center" style="font-size:8pt;">Gracias por su visita</div>
        <div class="t-center t-sep" style="font-size:8pt;">- - - - - - - - - - - - -</div>
      `;

      renderYImprimir(html);
    }

    /* ═══════════════════════════

       HISTORIAL
    ═══════════════════════════ */
    async function cargarHistorial() {
      const fecha = document.getElementById('hist-fecha').value || fechaHoy();

      try {
        const res = await apiFetch('/api/caja/historial?fecha=' + fecha);
        if (!res) return;
        const data = await res.json();

        const t = data.totales;
        document.getElementById('hist-resumen').style.display = t.num_pagos > 0 ? 'block' : 'none';
        document.getElementById('hr-total').textContent    = fmt(t.total_general);
        document.getElementById('hr-efectivo').textContent = fmt(t.total_efectivo);
        document.getElementById('hr-tarjeta').textContent  = fmt(t.total_tarjeta);
        document.getElementById('hr-transfer').textContent = fmt(t.total_transferencia);
        document.getElementById('hr-num').textContent      = t.num_pagos;

        const tbody = document.getElementById('hist-tbody');
        tbody.textContent = '';

        if (!data.pagos || data.pagos.length === 0) {
          const tr = document.createElement('tr');
          const td = document.createElement('td');
          td.colSpan = tbody.closest('table').querySelectorAll('thead th').length || 8;
          const empty = document.createElement('div'); empty.className = 'empty';
          const ico = document.createElement('div'); ico.className = 'empty-icon'; ico.textContent = '📋';
          const tit = document.createElement('div'); tit.className = 'empty-title'; tit.textContent = 'Sin pagos en esta fecha';
          empty.appendChild(ico); empty.appendChild(tit);
          td.appendChild(empty);
          tr.appendChild(td); tbody.appendChild(tr);
          return;
        }

        data.pagos.forEach((p, i) => {
          const tr = document.createElement('tr');

          [
            { text: i + 1,                    cls: 'mono' },
            { text: p.folio_orden,            cls: 'mono' },
            { text: p.paciente_nombre || '—', cls: '' },
          ].forEach(({ text, cls }) => {
            const td = document.createElement('td');
            td.textContent = text;
            if (cls) td.className = cls;
            tr.appendChild(td);
          });

          const tdMet  = document.createElement('td');
          const badge  = document.createElement('span');
          const metSafe = ['efectivo','tarjeta','transferencia'].includes(p.metodo) ? p.metodo : 'efectivo';
          badge.className   = `badge badge-${metSafe}`;
          badge.textContent = p.metodo;
          tdMet.appendChild(badge);
          tr.appendChild(tdMet);

          const tdMonto = document.createElement('td');
          tdMonto.style.fontWeight = '700';
          tdMonto.textContent      = fmt(p.monto);
          tr.appendChild(tdMonto);

          const tdCaj = document.createElement('td');
          tdCaj.textContent = p.cajero;
          tr.appendChild(tdCaj);

          const tdHora = document.createElement('td');
          tdHora.className   = 'mono';
          tdHora.textContent = horaDesde(p.fecha);
          tr.appendChild(tdHora);

          const tdTk  = document.createElement('td');
          const btnTk = document.createElement('button');
          btnTk.className   = 'pago-btn-ticket';
          btnTk.textContent = '🖨️';
          btnTk.addEventListener('click', () => imprimirTicketPorFolio(p.folio_orden));
          tdTk.appendChild(btnTk);
          tr.appendChild(tdTk);

          tbody.appendChild(tr);
        });

        _historialData = data;

      } catch (err) {
        console.error('cargarHistorial:', err);
        showToast('Error al cargar el historial', '❌');
      }
    }

    /* ═══════════════════════════
       EXPORTAR CSV
    ═══════════════════════════ */
    function exportarCSV() {
      const data = _historialData;
      if (!data || !data.pagos || data.pagos.length === 0) {
        showToast('No hay datos para exportar', '⚠️'); return;
      }

      const csvEsc = v => {
        const s = String(v === null || v === undefined ? '' : v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
          ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const header = ['#', 'Folio', 'Paciente', 'Método', 'Monto', 'Cajero', 'Hora'];
      const rows   = data.pagos.map((p, i) => [
        i + 1, p.folio_orden, p.paciente_nombre || '',
        p.metodo, p.monto, p.cajero, horaDesde(p.fecha),
      ]);

      const csv  = [header, ...rows].map(r => r.map(csvEsc).join(',')).join('\n');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `pagos-${data.fecha || fechaHoy()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }

    /* ═══════════════════════════

       CORTES — LISTADO CON FILTROS
    ═══════════════════════════ */
    async function cargarCortes() {
      if (!canViewCuts) return;
      const desde = document.getElementById('corte-desde').value;
      const hasta = document.getElementById('corte-hasta').value;

      let url = '/api/caja/cortes';
      const qs = [];
      if (desde) qs.push('desde=' + encodeURIComponent(desde));
      if (hasta) qs.push('hasta=' + encodeURIComponent(hasta));
      if (qs.length) url += '?' + qs.join('&');

      try {
        const res = await apiFetch(url);
        if (!res) return;
        const cortes = await res.json();

        const tbody = document.getElementById('cortes-tbody');
        tbody.textContent = '';

        if (!cortes || cortes.length === 0) {
          const tr = document.createElement('tr');
          const td = document.createElement('td');
          td.colSpan = tbody.closest('table').querySelectorAll('thead th').length || 10;
          const empty = document.createElement('div'); empty.className = 'empty';
          const ico = document.createElement('div'); ico.className = 'empty-icon'; ico.textContent = '📅';
          const tit = document.createElement('div'); tit.className = 'empty-title'; tit.textContent = 'Sin cortes en este período';
          empty.appendChild(ico); empty.appendChild(tit);
          td.appendChild(empty);
          tr.appendChild(td); tbody.appendChild(tr);
          document.getElementById('cortes-resumen-filtro').style.display = 'none';
          return;
        }

        const sumaTotal    = cortes.reduce((a, c) => a + c.total_general, 0);
        const sumaEfectivo = cortes.reduce((a, c) => a + c.total_efectivo, 0);
        const sumaTarjeta  = cortes.reduce((a, c) => a + c.total_tarjeta, 0);
        const sumaTransfer = cortes.reduce((a, c) => a + c.total_transferencia, 0);

        document.getElementById('crf-num').textContent      = cortes.length;
        document.getElementById('crf-total').textContent    = fmt(sumaTotal);
        document.getElementById('crf-efectivo').textContent = fmt(sumaEfectivo);
        document.getElementById('crf-tarjeta').textContent  = fmt(sumaTarjeta);
        document.getElementById('crf-transfer').textContent = fmt(sumaTransfer);
        document.getElementById('cortes-resumen-filtro').style.display = 'block';

        cortes.forEach((c, i) => {
          const tr = document.createElement('tr');
          const periodoStr = `${horaDesde(c.fecha_inicio)} – ${horaDesde(c.fecha_fin)}`;

          [
            { text: i + 1,                             cls: 'mono' },
            { text: c.fecha_fin?.split(' ')[0] || '—', cls: 'mono' },
            { text: periodoStr,                         cls: 'mono' },
            { text: c.cajero,                           cls: '' },
            { text: fmt(c.total_efectivo),              cls: '' },
            { text: fmt(c.total_tarjeta),               cls: '' },
            { text: fmt(c.total_transferencia),         cls: '' },
            { text: fmt(c.total_general),               cls: '' },
            { text: c.num_pagos,                        cls: '' },
          ].forEach(({ text, cls }) => {
            const td = document.createElement('td');
            td.textContent = text;
            if (cls) td.className = cls;
            tr.appendChild(td);
          });

          const tdAcc  = document.createElement('td');
          const accWrap = document.createElement('div');
          accWrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
          const btnVer = document.createElement('button');
          btnVer.className     = 'btn btn-ghost';
          btnVer.style.cssText = 'font-size:12px;padding:5px 10px;';
          btnVer.textContent   = '🔍 Ver';
          btnVer.addEventListener('click', () => abrirDetalleCorte(c.id));
          accWrap.appendChild(btnVer);
          tdAcc.appendChild(accWrap);
          tr.appendChild(tdAcc);

          tbody.appendChild(tr);
        });

        _cortesData = cortes;

      } catch (err) {
        console.error('cargarCortes:', err);
      }
    }

    /* ═══════════════════════════
       MODAL DETALLE DE CORTE
    ═══════════════════════════ */
    let _corteDetalleActual = null;

    async function abrirDetalleCorte(id) {
      if (!canViewCuts) return;
      try {
        const res = await apiFetch('/api/caja/cortes/' + encodeURIComponent(id));
        if (!res) return;
        if (!res.ok) { showToast('Error al cargar detalle', '❌'); return; }

        const data = await res.json();
        _corteDetalleActual = data;

        const { corte, pagos } = data;

        document.getElementById('mdc-titulo').textContent =
          `📋 Corte #${corte.id} — ${corte.fecha_fin?.split(' ')[0] || ''}`;
        document.getElementById('mdc-efectivo').textContent = fmt(corte.total_efectivo);
        document.getElementById('mdc-tarjeta').textContent  = fmt(corte.total_tarjeta);
        document.getElementById('mdc-transfer').textContent = fmt(corte.total_transferencia);
        document.getElementById('mdc-total').textContent    = fmt(corte.total_general);
        document.getElementById('mdc-num').textContent      = corte.num_pagos + ' pagos';
        document.getElementById('mdc-periodo').textContent  =
          `⏱ Período: ${fechaHoraDesde(corte.fecha_inicio)} → ${fechaHoraDesde(corte.fecha_fin)}`;
        document.getElementById('mdc-cajero').textContent   = `👤 Cajero: ${corte.cajero}`;
        document.getElementById('mdc-obs').textContent      =
          corte.observaciones ? `📝 ${corte.observaciones}` : '';

        const tbody = document.getElementById('mdc-tbody');
        tbody.textContent = '';

        if (!pagos || pagos.length === 0) {
          document.getElementById('mdc-empty').style.display = 'block';
        } else {
          document.getElementById('mdc-empty').style.display = 'none';

          pagos.forEach((p, i) => {
            const tr = document.createElement('tr');

            [
              { text: i + 1,                    cls: 'mono' },
              { text: p.folio_orden,            cls: 'mono' },
              { text: p.paciente_nombre || '—', cls: '' },
            ].forEach(({ text, cls }) => {
              const td = document.createElement('td');
              td.textContent = text;
              if (cls) td.className = cls;
              tr.appendChild(td);
            });

            const tdMet  = document.createElement('td');
            const badge  = document.createElement('span');
            const metSafe = ['efectivo','tarjeta','transferencia'].includes(p.metodo) ? p.metodo : 'efectivo';
            badge.className   = `badge badge-${metSafe}`;
            badge.textContent = p.metodo;
            tdMet.appendChild(badge);
            tr.appendChild(tdMet);

            const tdMonto = document.createElement('td');
            tdMonto.style.fontWeight = '700';
            tdMonto.textContent      = fmt(p.monto);
            tr.appendChild(tdMonto);

            const tdHora = document.createElement('td');
            tdHora.className   = 'mono';
            tdHora.textContent = horaDesde(p.fecha);
            tr.appendChild(tdHora);

            const tdTk  = document.createElement('td');
            const btnTk = document.createElement('button');
            btnTk.className   = 'pago-btn-ticket';
            btnTk.textContent = '🖨️';
            btnTk.title       = 'Reimprimir ticket';
            btnTk.addEventListener('click', () => imprimirTicketPorFolio(p.folio_orden));
            tdTk.appendChild(btnTk);
            tr.appendChild(tdTk);

            tbody.appendChild(tr);
          });
        }

        document.getElementById('modal-detalle-corte').classList.add('open');

      } catch (err) {
        console.error('abrirDetalleCorte:', err);
        showToast('Error de conexión', '❌');
      }
    }

    function cerrarDetalleCorte() {
      document.getElementById('modal-detalle-corte').classList.remove('open');
    }

    /* ═══════════════════════════
       COMPARATIVA — GRÁFICA
    ═══════════════════════════ */
    let _chartInstance = null;

    async function cargarComparativa() {
      if (!canViewAnalytics) return;
      const dias = parseInt(document.getElementById('comp-dias').value, 10) || 30;
      try {
        const res = await apiFetch('/api/caja/comparativa?dias=' + dias);
        if (!res) return;
        const rows = await res.json();

        const canvas    = document.getElementById('comp-chart');
        const empty     = document.getElementById('comp-empty');
        const tablaWrap = document.getElementById('comp-tabla-wrap');

        if (!rows || rows.length === 0) {
          canvas.style.display    = 'none';
          tablaWrap.style.display = 'none';
          empty.style.display     = 'block';
          return;
        }

        canvas.style.display    = 'block';
        tablaWrap.style.display = 'block';
        empty.style.display     = 'none';

        const labels   = rows.map(r => r.fecha);
        const efectivo = rows.map(r => r.total_efectivo);
        const tarjeta  = rows.map(r => r.total_tarjeta);
        const transfer = rows.map(r => r.total_transferencia);

        if (_chartInstance) _chartInstance.destroy();

        _chartInstance = new Chart(canvas, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label: 'Efectivo',      data: efectivo, backgroundColor: 'rgba(46,204,113,0.75)', borderRadius: 4 },
              { label: 'Tarjeta',       data: tarjeta,  backgroundColor: 'rgba(52,152,219,0.75)', borderRadius: 4 },
              { label: 'Transferencia', data: transfer, backgroundColor: 'rgba(155,89,182,0.75)', borderRadius: 4 },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: true,
            plugins: {
              legend: { position: 'top' },
              tooltip: {
                callbacks: {
                  label: ctx =>
                    ` ${ctx.dataset.label}: $${Number(ctx.raw).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`,
                },
              },
            },
            scales: {
              x: { stacked: true, ticks: { font: { size: 11 } } },
              y: {
                stacked: true,
                ticks: {
                  callback: v => '$' + Number(v).toLocaleString('es-MX', { minimumFractionDigits: 0 }),
                  font:     { size: 11 },
                },
              },
            },
          },
        });

        const tbody = document.getElementById('comp-tbody');
        tbody.textContent = '';
        rows.forEach(r => {
          const tr = document.createElement('tr');
          [
            { text: r.fecha,                    cls: 'mono' },
            { text: r.num_cortes,               cls: '' },
            { text: fmt(r.total_efectivo),      cls: '' },
            { text: fmt(r.total_tarjeta),       cls: '' },
            { text: fmt(r.total_transferencia), cls: '' },
            { text: fmt(r.total_general),       cls: '' },
          ].forEach(({ text, cls }) => {
            const td = document.createElement('td');
            td.textContent = text;
            if (cls) td.className = cls;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });

      } catch (err) {
        console.error('cargarComparativa:', err);
      }
    }

    /* ═══════════════════════════
       MODAL CORTE DE CAJA
    ═══════════════════════════ */
    function abrirModalCorte() {
      if (!canCreateCut) return;
      const cpTotal = document.getElementById('cp-total').textContent;
      if (cpTotal === '—') cargarResumenDia();
      document.getElementById('modal-corte').classList.add('open');
    }

    function cerrarModalCorte() {
      document.getElementById('modal-corte').classList.remove('open');
    }

    async function confirmarCorte() {
      if (!canCreateCut) return;
      const obs = document.getElementById('corte-obs').value.trim();
      const btn = document.getElementById('btn-confirmar-corte');
      const restore = setBtnLoading(btn, 'Generando...');

      try {
        if (!navigator.onLine) throw new TypeError('offline');

        const res = await apiFetch('/api/caja/corte', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ observaciones: obs }),
        });
        if (!res) return;

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          if (res.status === 400 && data.error && data.error.includes('ceros')) {
            cerrarModalCorte();
            showToast('⚠️ La caja ya está en $0.00 — no hay pagos nuevos', '⚠️');
          } else {
            showToast(data.error || `Error al generar corte (${res.status})`, '❌');
          }
          return;
        }

        cerrarModalCorte();
        showToast('Corte generado correctamente ✔');
        imprimirCorte(data);
        cargarCortes();
        cargarResumenDia();

      } catch (err) {
        console.error('confirmarCorte:', err);
        if (err.message === 'offline') {
          showToast('Sin conexión — no se pudo generar el corte', '❌');
        } else {
          showToast('Error de conexión — intenta de nuevo', '❌');
        }
      } finally {
        restore('🖨️ Generar e Imprimir Corte');
      }
    }

    /* ═══════════════════════════
       EVENT LISTENERS
    ═══════════════════════════ */

    document.getElementById('btn-buscar-orden').addEventListener('click', buscarOrden);
    document.getElementById('folio-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') buscarOrden();
    });

    document.getElementById('folio-input').addEventListener('input', e => {
      if (!e.target.value.trim()) {
        ordenActual = null;
        splitPagos  = [];
        document.getElementById('orden-info').style.display = 'none';
        document.getElementById('orden-card').textContent   = '';
        setStatus('cobro-status', '');
      }
    });

    // Botones split payment
    document.getElementById('btn-agregar-pago').addEventListener('click', agregarPagoParcial);
    document.getElementById('btn-cobrar').addEventListener('click', registrarPago);

    document.getElementById('btn-limpiar-split').addEventListener('click', () => {
      splitPagos = [];
      renderSplitUI();
      showToast('Pagos parciales eliminados', '🗑');
    });

    document.getElementById('btn-ticket-pre').addEventListener('click', () => {
      if (ordenActual) imprimirTicketPorFolio(ordenActual.orden.folio);
    });

    document.getElementById('btn-refresh-pagos').addEventListener('click', cargarResumenDia);

    document.getElementById('btn-hist-buscar').addEventListener('click', cargarHistorial);
    document.getElementById('hist-fecha').addEventListener('change', cargarHistorial);
    document.getElementById('btn-export-hist').addEventListener('click', exportarCSV);

    document.getElementById('btn-corte').addEventListener('click', abrirModalCorte);
    document.getElementById('modal-corte-close').addEventListener('click', cerrarModalCorte);
    document.getElementById('modal-corte-cancel').addEventListener('click', cerrarModalCorte);
    document.getElementById('btn-confirmar-corte').addEventListener('click', confirmarCorte);

    document.getElementById('modal-corte').addEventListener('click', e => {
      if (e.target === e.currentTarget) cerrarModalCorte();
    });

    document.getElementById('btn-filtrar-cortes').addEventListener('click', cargarCortes);
    document.getElementById('btn-limpiar-cortes').addEventListener('click', () => {
      document.getElementById('corte-desde').value = '';
      document.getElementById('corte-hasta').value = '';
      cargarCortes();
    });

    document.getElementById('mdc-close').addEventListener('click', cerrarDetalleCorte);
    document.getElementById('mdc-cancel').addEventListener('click', cerrarDetalleCorte);
    document.getElementById('mdc-reimprimir').addEventListener('click', reimprimirCorteActual);

    document.getElementById('modal-detalle-corte').addEventListener('click', e => {
      if (e.target === e.currentTarget) cerrarDetalleCorte();
    });

    document.getElementById('comp-dias').addEventListener('change', cargarComparativa);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        cerrarModalCorte();
        cerrarDetalleCorte();
      }
    });

    /* ═══════════════════════════

       IMPRIMIR CORTE DE CAJA
    ═══════════════════════════ */
    function imprimirCorte(data) {
      const { corte, pagos, empresa } = data;
      const emp = empresa || {};
      const linea = '<div class="t-line"></div>';

      let pagosHTML = '';
      (pagos || []).forEach((p, i) => {
        pagosHTML += `
          <tr>
            <td>${i + 1}. ${esc(p.folio_orden)} ${esc(p.paciente_nombre || '')}</td>
            <td>${esc(p.metodo.toUpperCase())} ${esc(fmt(p.monto))}</td>
          </tr>`;
      });

      const html = `
        <div class="t-no-break">
          ${ticketCompanyHTML(emp)}
          ${linea}
          <div class="t-doctype">CORTE DE CAJA</div>
          <div class="t-center" style="font-size:8pt;">${esc(fechaHoraDesde(corte.fecha_fin))}</div>
        </div>
        ${linea}
        <table class="t-meta t-no-break">
          <tr><td>Corte #:</td><td>${esc(String(corte.id))}</td></tr>
          <tr><td>Cajero:</td><td>${esc(corte.cajero)}</td></tr>
          <tr><td>Período:</td><td>${esc(horaDesde(corte.fecha_inicio))} – ${esc(horaDesde(corte.fecha_fin))}</td></tr>
          <tr><td>Pagos:</td><td>${esc(String(corte.num_pagos))}</td></tr>
        </table>
        ${linea}
        <table class="t-money t-no-break">
          <tr><td>Efectivo:</td><td>${esc(fmt(corte.total_efectivo))}</td></tr>
          <tr><td>Tarjeta:</td><td>${esc(fmt(corte.total_tarjeta))}</td></tr>
          <tr><td>Transferencia:</td><td>${esc(fmt(corte.total_transferencia))}</td></tr>
        </table>
        ${linea}
        <table class="t-money t-no-break">
          <tr class="t-total"><td>TOTAL:</td><td>${esc(fmt(corte.total_general))}</td></tr>
        </table>
        ${corte.observaciones ? `${linea}<div style="font-size:8pt;">${esc(corte.observaciones)}</div>` : ''}
        ${pagosHTML ? `${linea}<div class="t-block-title">Detalle de pagos</div><table class="t-list"><tbody>${pagosHTML}</tbody></table>` : ''}
        ${linea}
        <div class="t-center" style="font-size:8pt;">- - - - - - - - - - - -</div>
      `;

      renderYImprimir(html);
    }

    /* ═══════════════════════════
       REIMPRIMIR CORTE ACTUAL
    ═══════════════════════════ */
    function reimprimirCorteActual() {
      if (!_corteDetalleActual) {
        showToast('No hay corte cargado para reimprimir', '⚠️');
        return;
      }
      imprimirCorte(_corteDetalleActual);
    }

    /* ═══════════════════════════
       INIT
    ═══════════════════════════ */
    document.getElementById('hist-fecha').value = fechaHoy();
    cargarResumenDia();

  })();
})();
