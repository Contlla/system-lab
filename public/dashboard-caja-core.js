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
  document.addEventListener('DOMContentLoaded', () => {

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
