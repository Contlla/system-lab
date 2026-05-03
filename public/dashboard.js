/* ── AUTH ── */

const token = sessionStorage.getItem('token');

if (!token || token === 'undefined') { sessionStorage.clear(); window.location.replace('/index.html'); }

function logout() {
  if (window.LabApi?.logout) return window.LabApi.logout();
  sessionStorage.clear();
  window.location.replace('/index.html');
}

function getTokenPayload() {
  try { return JSON.parse(atob(token.split('.')[1])); } catch { return {}; }
}

const authUser = getTokenPayload();

function getCurrentRole() {
  return String(authUser.role || sessionStorage.getItem('role') || '').trim();
}

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

function withAuthToken(url) {
  const value = String(url || '');
  if (!value || value === '#') return '#';
  return value;
}

try {
  const p = authUser;

  // Verificar expiración del JWT antes de cualquier render
  if (p.exp && Date.now() / 1000 > p.exp) {
    sessionStorage.clear();
    window.location.replace('/index.html');
  }

  const u = p.usuario || '?';
  document.getElementById('sb-avatar').textContent = u[0].toUpperCase();
  document.getElementById('sb-username').textContent = u;
  document.getElementById('sb-role').textContent = p.role || '';

  const viewPermissions = {
    'inicio': 'dashboard.view',
    'nueva-orden': 'ordenes.create',
    'buscar': 'ordenes.view',
    'pacientes': 'pacientes.view',
    'agenda': 'agenda.view',
    'carga-resultados': 'resultados.view',
    'proforma': 'ordenes.view',
    'caja': 'caja.view',
    'catalogo': 'estudios.manage',
    'empresa': 'empresa.manage',
    'usuarios': 'usuarios.manage',
  };

  document.querySelectorAll('.nav-item[data-view]').forEach((item) => {
    const permission = viewPermissions[item.dataset.view];
    if (permission && !can(permission)) item.style.display = 'none';
  });

  document.querySelectorAll('.sidebar-section-label').forEach((lbl) => {
    let hasVisibleItems = false;
    let sib = lbl.nextElementSibling;
    while (sib && sib.classList.contains('nav-item')) {
      if (sib.style.display !== 'none') hasVisibleItems = true;
      sib = sib.nextElementSibling;
    }
    if (!hasVisibleItems) lbl.style.display = 'none';
  });

  // Ocultar sección Configuración para roles no-admin
  const esAdmin = can('estudios.manage') || can('empresa.manage') || can('usuarios.manage');
  if (!esAdmin) {
    // Ocultar label "Configuración" y sus nav-items
    document.querySelectorAll('.sidebar-section-label').forEach(lbl => {
      if (lbl.textContent.trim() === 'Configuración') {
        lbl.style.display = 'none';
        let sib = lbl.nextElementSibling;
        while (sib && sib.classList.contains('nav-item')) {
          sib.style.display = 'none';
          sib = sib.nextElementSibling;
        }
      }
    });
  }
} catch (e) { }

/* ── HELPERS ── */

function toast(msg, e = '✔') {
  const t = document.getElementById('toast');
  t.textContent = e + ' ' + msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function fmt(n) { return (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function fmtDate(f) {
  if (!f) return '—';
  try {
    // Parseo seguro: extrae partes para evitar que Safari/Node traten la cadena como UTC
    const s = String(f).substring(0, 10); // "YYYY-MM-DD"
    const [y, m, d] = s.split('-').map(Number);
    if (!y || !m || !d) return s;
    return new Date(y, m - 1, d).toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return String(f).substring(0, 10); }
}

function getCat(n) {
  n = (n || '').toLowerCase();
  if (['glucosa', 'colesterol', 'triglicéridos', 'urea', 'creatinina', 'ácido úrico'].some(k => n.includes(k))) return 'BIOQUÍMICA';
  if (['biometría', 'hemoglobina', 'hematocrito', 'plaquetas'].some(k => n.includes(k))) return 'HEMATOLOGÍA';
  if (['pcr', 'fr', 'aso'].some(k => n.includes(k))) return 'INMUNOLOGÍA';
  if (['orina', 'urocultivo'].some(k => n.includes(k))) return 'UROANÁLISIS';
  return 'OTROS';
}

function badge(estado) {
  const m = { pendiente: { c: 'badge-pendiente', t: 'Pendiente' }, en_proceso: { c: 'badge-en_proceso', t: 'En proceso' }, completado: { c: 'badge-completado', t: 'Completado' }, cancelado: { c: 'badge-cancelado', t: 'Cancelado' } };
  const x = m[estado] || { c: 'badge-pendiente', t: estado };
  return `<span class="badge ${x.c}">${x.t}</span>`;
}

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(url, opts = {}) {
  if (window.LabApi?.apiFetch) return window.LabApi.apiFetch(url, opts);
  const headers = { Authorization: 'Bearer ' + token };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body || undefined, signal: opts.signal });
  if (r.status === 401 || r.status === 403) { logout(); throw Object.assign(new Error('auth'), { isAuth: true }); }
  return r;
}

/* ── NAVIGATION ── */

const VIEWS = {
  'inicio': ['🏠 Inicio', 'Inicio'],
  'nueva-orden': ['➕ Nueva Orden', 'Nueva Orden'],
  'buscar': ['🔍 Buscar Orden', 'Buscar Orden'],
  'pacientes': ['👥 Pacientes', 'Pacientes'],
  'carga-resultados': ['📤 Resultados', 'Resultados'],
  'proforma': ['🧻 Orden de Estudios', 'Orden de Estudios'],
  'caja': ['🏦 Caja', 'Caja'],
  'agenda': ['📅 Agenda', 'Agenda'],
  'catalogo': ['🧪 Catálogo de Estudios', 'Catálogo de Estudios'],
  'empresa': ['🏢 Empresa', 'Empresa'],
  'usuarios': ['👤 Usuarios', 'Usuarios'],
};

function goTo(v) {
  const activeViewEl = document.querySelector('.view.active');
  const activeView = activeViewEl ? activeViewEl.id.replace(/^view-/, '') : '';
  if (activeView === 'empresa' && typeof window.empPuedeSalirVista === 'function') {
    const leavingEmpresa = v !== 'empresa';
    const reloadingEmpresa = v === 'empresa';
    if ((leavingEmpresa || reloadingEmpresa) && !window.empPuedeSalirVista(v)) return;
  }
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const vEl = document.getElementById('view-' + v);
  const nEl = document.querySelector(`.nav-item[data-view="${v}"]`);
  if (vEl) vEl.classList.add('active');
  if (nEl) nEl.classList.add('active');
  const meta = VIEWS[v] || [v, v];
  document.getElementById('topbar-title').textContent = meta[0];
  document.getElementById('tb-page').textContent = meta[1];
  document.getElementById('content-area').scrollTop = 0;
  if (typeof window.setNuevaOrdenStylesEnabled === 'function') {
    window.setNuevaOrdenStylesEnabled(v === 'nueva-orden');
  }
  if (v === 'inicio') loadDashboard();
  if (v === 'nueva-orden' && typeof window.initDashboardNuevaOrdenView === 'function') window.initDashboardNuevaOrdenView();
  if (v === 'buscar') bqIniciarVista();
  if (v === 'caja' && typeof window.cjIniciarVista === 'function') window.cjIniciarVista();
  if (v === 'empresa') empIniciarVista();
  if (v === 'catalogo') cargarCatalogo();
  if (v === 'agenda') initAgenda();
  if (v === 'pacientes') pacIniciarVista();
  if (v === 'carga-resultados') resIniciarVista();
  if (v === 'usuarios' && typeof window.usrIniciarVista === 'function') window.usrIniciarVista();
}

/* ── INICIO ── */

let _dashCache = null, _dashCacheTs = 0;

async function loadDashboard() {
  const now = Date.now();
  // Mostrar esqueleto de carga solo si no hay cache válido
  if (now - _dashCacheTs > 30000) {
    ['m-ord', 'm-ing', 'm-pac', 'm-comp', 'm-saldo'].forEach(id => {
      const el = document.getElementById(id);
      el.textContent = '…';
      el.style.opacity = '0.4';
    });
  }
  // Usar cache si tiene menos de 30 s
  if (_dashCache && now - _dashCacheTs < 30000) {
    _renderDashboard(_dashCache);
    return;
  }
  try {
    const r = await api('/api/dashboard');
    if (!r.ok) return;
    const d = await r.json();
    _dashCache = d;
    _dashCacheTs = Date.now();
    _renderDashboard(d);
  } catch (e) { if (!e.isAuth) console.error(e); }
}

function _renderDashboard(d) {
  ['m-ord', 'm-ing', 'm-pac', 'm-comp', 'm-saldo'].forEach(id => {
    document.getElementById(id).style.opacity = '1';
  });
  document.getElementById('m-ord').textContent = d.ordenesHoy ?? 0;
  document.getElementById('m-ing').textContent = '$' + fmt(d.ingresos ?? 0);
  document.getElementById('m-pac').textContent = d.pacientes ?? 0;
  document.getElementById('m-comp').textContent = d.completadosHoy ?? 0;
  document.getElementById('m-saldo').textContent = '$' + fmt(d.saldoPorCobrar ?? 0);
  const tbody = document.getElementById('dash-tbody');
  tbody.innerHTML = '';
  const ords = d.ultimasOrdenes || [];
  if (!ords.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">Sin órdenes registradas</td></tr>`;
    return;
  }
  ords.forEach(o => {
    const tr = document.createElement('tr');
    const tdFolio = document.createElement('td');
    tdFolio.style.cssText = "font-family:'DM Mono',monospace;font-size:12px;";
    tdFolio.textContent = o.folio || '—';
    const tdPac = document.createElement('td');
    tdPac.textContent = o.paciente_nombre || '—';
    // Hacer la fila clickeable para ir a Buscar Orden con el folio
    if (o.folio) {
      tr.style.cursor = 'pointer';
      tr.title = 'Ver orden ' + o.folio;
      tr.addEventListener('click', () => {
        goTo('buscar');
        bqPreFill(o.folio);
      });
    }
    const tdEstado = document.createElement('td');
    tdEstado.innerHTML = badge(o.estado); // badge() solo produce clases CSS controladas
    const tdTotal = document.createElement('td');
    tdTotal.textContent = '$' + fmt(o.total);
    const tdFecha = document.createElement('td');
    tdFecha.style.cssText = 'color:var(--muted);font-size:12px;';
    tdFecha.textContent = fmtDate(o.fecha);
    tr.append(tdFolio, tdPac, tdEstado, tdTotal, tdFecha);
    tbody.appendChild(tr);
  });
}

/* ── PROFORMA ── */

let pfOrdenActual = null;
let pfEstudiosActuales = [];
let pfEmpresaActual = {};

async function pfGenerar() {
  const folio = document.getElementById('pf-folio').value.trim().toUpperCase();
  const errEl = document.getElementById('pf-err');
  const content = document.getElementById('pf-content');
  errEl.style.display = 'none';
  if (!folio) { errEl.textContent = 'Ingresa un folio'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('pf-btn');
  btn.disabled = true; btn.textContent = 'Buscando...';
  content.innerHTML = '<div class="spinner"></div>';
  try {
    const [rO, rE] = await Promise.all([api(`/api/resultados/orden/${folio}`), api('/api/empresa')]);
    if (rO.status === 404) {
      errEl.textContent = `No se encontro "${folio}"`; errEl.style.display = 'block';
      content.innerHTML = '<div class="empty-state"><div class="icon">🔍</div><div>Orden no encontrada</div></div>';
      return;
    }
    if (!rO.ok) throw new Error();
    const { orden, estudios } = await rO.json();
    const emp = rE.ok ? await rE.json() : {};
    const fechaEntrega = document.getElementById('pf-entrega').value;
    pfOrdenActual = orden;
    pfEstudiosActuales = estudios || [];
    pfEmpresaActual = emp || {};
    pfRender(orden, estudios, emp, fechaEntrega);
  } catch (e) {
    if (e.isAuth) return;
    content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>Error al cargar</div></div>';
  } finally {
    btn.disabled = false; btn.textContent = '🔍 Buscar orden';
  }
}

function pfCleanText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F\uFEFF\u200B-\u200D]/g, ' ')
    .replace(/\uFFFD/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pfCleanPhone(value) {
  return pfCleanText(value).replace(/[^0-9+()\-. ext]/gi, '').trim();
}

function pfRender(orden, estudios, emp, fechaEntrega) {
  const empresaNombre = pfCleanText(emp.nombre) || 'Laboratorio Clinico';
  const empresaDireccion = pfCleanText(emp.direccion);
  const empresaRuc = pfCleanText(emp.ruc);
  const empresaRfc = pfCleanText(emp.rfc);
  const empresaTelefono = pfCleanPhone(emp.telefono);
  const empresaCorreo = pfCleanText(emp.correo);
  const sub = [empresaDireccion, empresaRuc ? 'RUC: ' + empresaRuc : null, empresaRfc ? 'RFC: ' + empresaRfc : null, empresaTelefono ? 'Tel: ' + empresaTelefono : null, empresaCorreo].filter(Boolean).join(' | ');
  const logoHtml = emp.logo
    ? `<div class="pf-logo-box" style="padding:0;overflow:hidden;background:white;"><img src="${emp.logo}" alt="Logo empresa" style="width:100%;height:100%;object-fit:cover;display:block;"></div>`
    : `<div class="pf-logo-box">🧪</div>`;
  // Compatibilidad: se mantiene solo el nuevo encabezado de empresa.
  const filas = estudios.map((e, i) => `
    <tr>
      <td style="width:28px;color:var(--muted);font-family:'DM Mono',monospace;font-size:11px;">${String(i + 1).padStart(2, '0')}</td>
      <td><div class="pf-cat-tag">${e.categoria || 'OTROS'}</div><div style="font-weight:600;font-size:13px;">${escapeHTML(e.nombre)}</div></td>
      <td style="text-align:right;font-weight:600;">$${fmt(e.precio)}</td>
    </tr>`).join('');
  const entregaVal = fechaEntrega || '';
  const entregaFmt = entregaVal ? (() => {
    const [y, m, d] = entregaVal.split('-');
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return `${parseInt(d)} de ${meses[parseInt(m) - 1]} de ${y}`;
  })() : null;
  const entregaBadge = `
    <div class="pf-entrega-badge" style="margin-top:10px;padding:8px 12px;background:linear-gradient(135deg,#eafaf1 0%,#d5f5e3 100%);border:1.5px solid #a9dfbf;border-radius:9px;display:${entregaFmt ? 'flex' : 'none'};align-items:center;gap:10px;" id="pf-entrega-badge-block">
      <span class="pf-eb-icon" style="font-size:18px;">📅</span>
      <div>
        <div class="pf-eb-lbl" style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.6px;color:#1e8449;margin-bottom:2px;">Fecha estimada de entrega de resultados</div>
        <div class="pf-eb-val pf-entrega-badge-txt" style="font-size:13px;font-weight:800;color:#145a32;">${entregaFmt || ''}</div>
      </div>
    </div>`;
  function buildDoc(copia) {
    return `
    <div class="pf-copy ${copia ? 'pf-copy-b' : 'pf-copy-a'}">
      <div class="pf-header">
        <div style="display:flex;align-items:center;gap:12px;">
          ${logoHtml}
          <div><div class="pf-emp-name">${emp.nombre || 'Mi Laboratorio'}</div><div class="pf-emp-sub">${sub || 'Laboratorio Clínico'}</div></div>
        </div>
        <div style="text-align:right;">
          <div class="pf-doc-title">Orden de Estudios</div>
          <div class="pf-folio">${orden.folio}</div>
          <div class="pf-fecha">${fmtDate(orden.fecha)}</div>
        </div>
      </div>
      <div class="pf-info-grid">
        <div class="pf-info-box">
          <div class="pf-box-title">👤 Paciente</div>
          <div class="pf-row"><span class="pf-key">Nombre</span><span class="pf-val">${orden.paciente_nombre}</span></div>
          ${orden.paciente_edad ? `<div class="pf-row"><span class="pf-key">Edad</span><span class="pf-val">${orden.paciente_edad} años</span></div>` : ''}
          ${orden.paciente_sexo ? `<div class="pf-row"><span class="pf-key">Sexo</span><span class="pf-val">${orden.paciente_sexo === 'M' ? 'Masculino' : orden.paciente_sexo === 'F' ? 'Femenino' : 'Otro'}</span></div>` : ''}
        </div>
        <div class="pf-info-box">
          <div class="pf-box-title">📋 Orden</div>
          <div class="pf-row"><span class="pf-key">Folio</span><span class="pf-val" style="font-family:'DM Mono',monospace;font-size:11px;">${orden.folio}</span></div>
          <div class="pf-row"><span class="pf-key">Sucursal</span><span class="pf-val">${orden.sucursal}</span></div>
          ${orden.medico ? `<div class="pf-row"><span class="pf-key">Médico</span><span class="pf-val">${orden.medico}</span></div>` : ''}
          <div class="pf-row"><span class="pf-key">Fecha</span><span class="pf-val">${fmtDate(orden.fecha)}</span></div>
        </div>
      </div>
      <div class="pf-table-wrap">
        <table class="pf-table">
          <thead><tr><th style="width:28px;">#</th><th>Estudio</th><th style="width:100px;">Precio</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
      <div class="pf-totales">
        <div class="pf-totales-box">
          <div class="pf-total-row"><span class="pf-total-key">Subtotal (${estudios.length} estudio${estudios.length !== 1 ? 's' : ''})</span><span class="pf-total-val">$${fmt(orden.total)}</span></div>
          <div class="pf-total-row pa"><span class="pf-total-key">Pagado</span><span class="pf-total-val">$${fmt(orden.pagado)}</span></div>
          <div class="pf-total-row sa"><span class="pf-total-key">Saldo</span><span class="pf-total-val">$${fmt(orden.saldo)}</span></div>
          <div class="pf-total-row hi"><span class="pf-total-key">TOTAL</span><span class="pf-total-val">$${fmt(orden.total)}</span></div>
        </div>
      </div>
      ${entregaBadge}
      <div class="pf-footer" style="margin-top:14px;">
        <div class="pf-footer-note">Conserve este documento para recoger sus resultados.<br>${[empresaNombre, empresaTelefono, empresaCorreo].filter(Boolean).join(' | ')}</div>
        <div><div class="pf-firma-line"></div><div class="pf-firma-label">Firma / Sello del laboratorio</div></div>
      </div>
    </div>`;
  }
  document.getElementById('pf-content').innerHTML = `
    <div class="pf-toolbar" style="display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap;">
      <span style="font-size:13px;font-weight:700;font-family:'DM Mono',monospace;">${orden.folio}</span>
      <span style="flex:1"></span>
      <button class="btn btn-ghost btn-sm" onclick="pfImprimir()">🖨️ Imprimir / PDF</button>
      <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${orden.folio}').then(()=>toast('Folio copiado','📋'))">📋 Copiar folio</button>
    </div>
    <div id="pf-doc">
      ${buildDoc(false)}
      <hr class="pf-copy-divider">
      ${buildDoc(true)}
    </div>`;
  return document.getElementById('pf-doc')?.innerHTML || '';
}

document.getElementById('pf-btn').addEventListener('click', pfGenerar);
document.getElementById('pf-folio').addEventListener('keydown', e => { if (e.key === 'Enter') pfGenerar(); });

// Actualizar badge de entrega en tiempo real cuando cambia el input
document.getElementById('pf-entrega').addEventListener('change', function () {
  const val = this.value;
  if (pfOrdenActual) {
    pfRender(pfOrdenActual, pfEstudiosActuales, pfEmpresaActual, val);
    return;
  }
  const badges = document.querySelectorAll('.pf-entrega-badge');
  const txts = document.querySelectorAll('.pf-entrega-badge-txt');
  if (!badges.length) return;
  if (val) {
    const [y, m, d] = val.split('-');
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const fmt2 = `${parseInt(d)} de ${meses[parseInt(m) - 1]} de ${y}`;
    badges.forEach(b => b.style.display = 'flex');
    txts.forEach(t => t.textContent = fmt2);
  } else {
    badges.forEach(b => b.style.display = 'none');
    txts.forEach(t => t.textContent = '');
  }
});

// Funcion global de impresion
window.pfImprimir = function () {
  const fechaEntrega = document.getElementById('pf-entrega').value;
  let printableHTML = '';
  if (pfOrdenActual) {
    printableHTML = pfRender(pfOrdenActual, pfEstudiosActuales, pfEmpresaActual, fechaEntrega);
  } else {
    document.getElementById('pf-entrega').dispatchEvent(new Event('change'));
    printableHTML = document.getElementById('pf-doc')?.innerHTML || '';
  }
  const printHost = pfEnsurePrintHost();
  printHost.innerHTML = printableHTML;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const cleanUp = () => {
        printHost.innerHTML = '';
        window.removeEventListener('afterprint', cleanUp);
      };
      window.addEventListener('afterprint', cleanUp);
      window.print();
      setTimeout(cleanUp, 60000);
    });
  });
};

function pfEnsurePrintHost() {
  let style = document.getElementById('pf-print-host-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'pf-print-host-style';
    style.textContent = `
      #pf-print-host { display: none; }
      @media print {
        body > *:not(#pf-print-host) { display: none !important; }
        #pf-print-host {
          display: block !important;
          background: white !important;
          color: #111827 !important;
          width: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        #pf-print-host .pf-copy {
          display: block !important;
          height: calc((297mm - 12mm) / 2 - 8mm) !important;
          overflow: hidden !important;
          box-sizing: border-box !important;
        }
        #pf-print-host .pf-copy-divider {
          border-top: 1.5px dashed #888 !important;
          margin: 3mm 0 !important;
          position: relative !important;
          height: 8mm !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          page-break-inside: avoid !important;
        }
        #pf-print-host .pf-copy-divider::before { display: none !important; }
        #pf-print-host .pf-copy-divider::after {
          content: '\\2702  CORTAR AQUI  -  Original: Laboratorio  |  Copia: Paciente  \\2702' !important;
          font-size: 7px !important;
          font-weight: 800 !important;
          letter-spacing: 1px !important;
          color: #888 !important;
          background: white !important;
          padding: 0 10px !important;
          display: block !important;
          white-space: nowrap !important;
        }
      }
    `;
    document.head.appendChild(style);
  }
  let host = document.getElementById('pf-print-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'pf-print-host';
    document.body.appendChild(host);
  }
  return host;
}

/* ── VIEWER ── */

async function abrirViewer(url, nombre) {
  const modal = document.getElementById('viewer-modal');
  document.getElementById('viewer-title').textContent = nombre || 'Resultado';
  const dl = document.getElementById('viewer-dl');
  const body = document.getElementById('viewer-body');
  body.innerHTML = '';
  let objectUrl = '';
  try {
    objectUrl = window.LabApi?.apiBlobUrl
      ? await window.LabApi.apiBlobUrl(url)
      : withAuthToken(url);
  } catch (err) {
    body.textContent = 'No se pudo cargar el archivo';
    modal.classList.add('open');
    return;
  }
  dl.href = objectUrl;
  dl.download = nombre || 'resultado';
  if ((nombre || '').toLowerCase().endsWith('.pdf')) {
    const f = document.createElement('iframe'); f.src = objectUrl; f.title = nombre; body.appendChild(f);
  } else if (/\.(jpe?g|png|webp|tiff?|bmp)$/i.test(nombre || '')) {
    const i = document.createElement('img'); i.src = objectUrl; i.alt = nombre; body.appendChild(i);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'viewer-unsupported';
    const icon = document.createElement('div');
    icon.style.fontSize = '44px';
    icon.textContent = '?';
    const msg = document.createElement('div');
    msg.textContent = 'Vista previa no disponible';
    const link = document.createElement('a');
    link.className = 'btn-vdl';
    link.href = objectUrl;
    link.download = nombre || 'archivo';
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.marginTop = '8px';
    link.textContent = '⬇️ Descargar';
    wrap.append(icon, msg, link);
    body.appendChild(wrap);
  }
  modal.classList.add('open');
  document.addEventListener('keydown', onVKey);
}

function cerrarViewer() {
  document.getElementById('viewer-modal').classList.remove('open');
  document.getElementById('viewer-body').innerHTML = '';
  document.removeEventListener('keydown', onVKey);
}

function onVKey(e) { if (e.key === 'Escape') cerrarViewer(); }

document.getElementById('viewer-modal').addEventListener('click', function (e) { if (e.target === this) cerrarViewer(); });

/* ════════════════════════════════════════
   AGENDA — JAVASCRIPT
════════════════════════════════════════ */

/* ── Estado global ── */

let agFecha = new Date().toISOString().split('T')[0];
let agCitas = [];
let agBloqueos = [];
let agTecnicos = [];
let agEstudios = [];   // catálogo completo
let agMcSel = [];   // estudios seleccionados en modal cita
let agEditId = null; // null=crear, number=editar
let agDetalleCita = null;

const DIAS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function agFmtFecha(iso) {
  const d = new Date(iso + 'T12:00:00');
  return `${DIAS_ES[d.getDay()]}, ${d.getDate()} de ${MESES_ES[d.getMonth()]} ${d.getFullYear()}`;
}

/* ── Inicialización ── */

async function initAgenda() {
  agFecha = agFecha || new Date().toISOString().split('T')[0];
  document.getElementById('ag-date-picker').value = agFecha;
  document.getElementById('ag-date-label').textContent = agFmtFecha(agFecha);
  await Promise.all([agCargarTecnicosGlobal(), agCargarEstudios()]);
  agRefresh();
}

async function agCargarTecnicosGlobal() {
  try {
    const r = await api('/api/agenda/tecnicos');
    if (!r.ok) return;
    agTecnicos = await r.json();
    const sel = document.getElementById('ag-tec-sel');
    sel.innerHTML = '<option value="">Todos los técnicos</option>';
    const suc = document.getElementById('ag-suc-sel').value;
    agTecnicos.filter(t => !suc || t.sucursal === suc).forEach(t => {
      sel.innerHTML += `<option value="${t.id}">${t.nombre} (${t.sucursal})</option>`;
    });
  } catch (e) { if (e.isAuth) return; }
}

async function agCargarEstudios() {
  try {
    const r = await api('/api/estudios');
    if (!r.ok) return;
    agEstudios = await r.json();
  } catch (e) { if (e.isAuth) return; }
}

/* ── Navegación de fecha ── */

function agMoverDia(delta) {
  const d = new Date(agFecha + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  agCambiarFecha(d.toISOString().split('T')[0]);
}

function agHoy() { agCambiarFecha(new Date().toISOString().split('T')[0]); }

function agCambiarFecha(iso) {
  agFecha = iso;
  document.getElementById('ag-date-picker').value = iso;
  document.getElementById('ag-date-label').textContent = agFmtFecha(iso);
  agRefresh();
}

/* ── Refresh principal ── */

async function agRefresh() {
  const suc = document.getElementById('ag-suc-sel').value;
  const tec = document.getElementById('ag-tec-sel').value;
  document.getElementById('ag-tl-body').innerHTML = '<div class="spinner"></div>';
  document.getElementById('ag-list-body').innerHTML = '';
  // Actualizar técnicos del select según sucursal
  const tecSel = document.getElementById('ag-tec-sel');
  const prevTec = tecSel.value;
  tecSel.innerHTML = '<option value="">Todos los técnicos</option>';
  agTecnicos.filter(t => !suc || t.sucursal === suc).forEach(t => {
    tecSel.innerHTML += `<option value="${t.id}"${t.id == prevTec ? ' selected' : ''}>${t.nombre}</option>`;
  });
  document.getElementById('ag-tl-title').textContent = `Agenda — ${suc} — ${agFmtFecha(agFecha)}`;
  try {
    let citaUrl = `/api/agenda/citas?fecha=${agFecha}&sucursal=${suc}`;
    if (tec) citaUrl += `&tecnico_id=${tec}`;
    let blqUrl = `/api/agenda/bloqueos?fecha=${agFecha}&sucursal=${suc}`;
    const [rC, rB] = await Promise.all([api(citaUrl), api(blqUrl)]);
    agCitas = rC.ok ? await rC.json() : [];
    agBloqueos = rB.ok ? await rB.json() : [];
    agRenderTimeline();
    agRenderStats();
    agRenderList();
  } catch (e) {
    if (e.isAuth) return;
    document.getElementById('ag-tl-body').innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>Error al cargar agenda</div></div>';
  }
}

/* ── Timeline ── */

function agRenderTimeline() {
  const body = document.getElementById('ag-tl-body');
  body.innerHTML = '';
  // Horas 07:00–20:00
  for (let h = 7; h <= 19; h++) {
    for (let hm = 0; hm < 2; hm++) {
      const minBase = h * 60 + hm * 30;
      const horaStr = String(h).padStart(2, '0') + ':' + (hm === 0 ? '00' : '30');
      const horaFin = String(Math.floor((minBase + 30) / 60)).padStart(2, '0') + ':' + String((minBase + 30) % 60).padStart(2, '0');
      const slot = document.createElement('div');
      slot.className = 'ag-slot';
      const lblHour = document.createElement('div');
      lblHour.className = 'ag-slot-hour';
      lblHour.textContent = hm === 0 ? horaStr : '';
      const line = document.createElement('div');
      line.className = 'ag-slot-line' + (hm === 1 ? ' half' : '');
      // Bloqueos en este slot
      agBloqueos.filter(b => solapanFront(horaStr, horaFin, b.hora_inicio, b.hora_fin)).forEach(b => {
        const blq = document.createElement('div');
        blq.className = 'ag-bloqueo';
        const icon = document.createElement('span');
        icon.style.fontSize = '14px';
        icon.textContent = '🚫';
        const txt = document.createElement('span');
        txt.className = 'ag-bloqueo-txt';
        txt.textContent = `${b.motivo || 'Bloqueado'} (${b.hora_inicio}-${b.hora_fin})`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = 'margin-left:auto;background:none;border:none;cursor:pointer;font-size:11px;color:var(--muted);';
        btn.textContent = 'x';
        btn.addEventListener('click', () => eliminarBloqueo(b.id));
        blq.append(icon, txt, btn);
        line.appendChild(blq);
      });
      // Citas en este slot (solo las que empiezan aquí para no duplicar)
      agCitas.filter(c => c.hora_inicio === horaStr || (solapanFront(horaStr, horaFin, c.hora_inicio, c.hora_fin) && c.hora_inicio > (h * 60 + hm * 30 - 30 >= 0 ? String(Math.floor((h * 60 + hm * 30 - 1) / 60)).padStart(2, '0') + ':' + String((h * 60 + hm * 30 - 1) % 60).padStart(2, '0') : '00:00'))).forEach(c => {
        if (agCitas.some(x => x.id === c.id && x.hora_inicio < horaStr)) return; // ya renderizado
        const div = document.createElement('div');
        div.className = `ag-cita ag-cita-${c.estado}`;
        div.innerHTML = `
          <div class="ag-cita-top">
            <span class="ag-cita-hora">${c.hora_inicio}–${c.hora_fin}</span>
            <span class="ag-pill ag-pill-${c.estado}">${c.estado.replace('_', ' ')}</span>
            ${c.orden_folio ? `<span style="font-size:10px;font-family:'DM Mono',monospace;color:var(--green-dark);">📋 ${c.orden_folio}</span>` : ''}
          </div>
          <div class="ag-cita-pac">${c.paciente_nombre}</div>
          ${c.estudios_nombres ? `<div class="ag-cita-est">🧪 ${c.estudios_nombres}</div>` : ''}
          ${c.tecnico_nombre ? `<div class="ag-cita-est">👤 ${c.tecnico_nombre}</div>` : ''}
        `;
        div.addEventListener('click', () => abrirDetalleCita(c));
        line.appendChild(div);
      });
      slot.appendChild(lblHour);
      slot.appendChild(line);
      body.appendChild(slot);
    }
  }
}

function solapanFront(i1, f1, i2, f2) {
  const t = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  return t(i1) < t(f2) && t(f1) > t(i2);
}

/* ── Stats ── */

function agRenderStats() {
  const contar = (est) => agCitas.filter(c => c.estado === est).length;
  document.getElementById('ag-stat-total').textContent = agCitas.length;
  document.getElementById('ag-stat-conf').textContent = contar('confirmada');
  document.getElementById('ag-stat-curso').textContent = contar('en_curso');
  document.getElementById('ag-stat-comp').textContent = contar('completada');
  document.getElementById('ag-stat-cancel').textContent = contar('cancelada') + contar('no_asistio');
}

/* ── Lista rápida ── */

function agRenderList() {
  const body = document.getElementById('ag-list-body');
  const proximas = agCitas.filter(c => !['completada', 'cancelada', 'no_asistio'].includes(c.estado))
    .sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));
  if (!proximas.length) {
    body.innerHTML = '<div class="empty-state" style="padding:24px;"><div class="icon" style="font-size:28px;">🎉</div><div>Sin citas pendientes</div></div>';
    return;
  }
  body.innerHTML = '';
  const fragment = document.createDocumentFragment();
  proximas.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'ag-list-row';
    row.addEventListener('click', () => abrirDetalleCita(c));
    const pac = document.createElement('div');
    pac.className = 'ag-list-pac';
    pac.textContent = c.paciente_nombre || 'Paciente sin nombre';
    const meta = document.createElement('div');
    meta.className = 'ag-list-meta';
    const hora = document.createElement('span');
    hora.className = 'ag-list-hora';
    hora.textContent = `${c.hora_inicio} - ${c.hora_fin}`;
    const estado = document.createElement('span');
    estado.className = `ag-pill ag-pill-${c.estado}`;
    estado.textContent = String(c.estado || '').replaceAll('_', ' ');
    meta.append(hora, estado);
    row.append(pac, meta);
    if (c.estudios_nombres) {
      const estudios = document.createElement('div');
      estudios.style.fontSize = '10px';
      estudios.style.color = 'var(--muted)';
      estudios.textContent = `🧪 ${c.estudios_nombres}`;
      row.appendChild(estudios);
    }
    fragment.appendChild(row);
  });
  body.appendChild(fragment);
}

/* ═══════════════════════════
   MODAL NUEVA / EDITAR CITA
═══════════════════════════ */

function abrirModalCita(citaParaEditar = null) {
  agEditId = citaParaEditar?.id || null;
  agMcSel = [];
  document.getElementById('mc-err').style.display = 'none';
  document.getElementById('mc-title').textContent = agEditId ? '✏️ Editar cita' : '📅 Nueva cita';
  const hoy = new Date().toISOString().split('T')[0];
  const suc = document.getElementById('ag-suc-sel').value;
  if (citaParaEditar) {
    document.getElementById('mc-pac-nombre').value = citaParaEditar.paciente_nombre || '';
    document.getElementById('mc-pac-cel').value = citaParaEditar.paciente_celular || '';
    document.getElementById('mc-sucursal').value = citaParaEditar.sucursal || suc;
    document.getElementById('mc-fecha').value = citaParaEditar.fecha || hoy;
    document.getElementById('mc-duracion').value = citaParaEditar.duracion_min || 30;
    document.getElementById('mc-hora-inicio').value = citaParaEditar.hora_inicio || '';
    document.getElementById('mc-hora-fin').value = citaParaEditar.hora_fin || '';
    document.getElementById('mc-notas').value = citaParaEditar.notas || '';
    try {
      const ids = JSON.parse(citaParaEditar.estudios_ids || '[]');
      agMcSel = agEstudios.filter(e => ids.includes(e.id));
    } catch { agMcSel = []; }
  } else {
    document.getElementById('mc-pac-nombre').value = '';
    document.getElementById('mc-pac-cel').value = '';
    document.getElementById('mc-sucursal').value = suc;
    document.getElementById('mc-fecha').value = agFecha >= hoy ? agFecha : hoy;
    document.getElementById('mc-duracion').value = '30';
    document.getElementById('mc-hora-inicio').value = '';
    document.getElementById('mc-hora-fin').value = '';
    document.getElementById('mc-notas').value = '';
  }
  mcCargarTecnicos(citaParaEditar?.tecnico_id);
  mcRenderEstudios();
  mcCargarSlots();
  document.getElementById('modal-cita').classList.add('open');
  setTimeout(() => document.getElementById('mc-pac-nombre').focus(), 80);
}

function cerrarModalCita() {
  document.getElementById('modal-cita').classList.remove('open');
  agEditId = null;
}

async function mcCargarTecnicos(selId = null) {
  const suc = document.getElementById('mc-sucursal').value;
  const sel = document.getElementById('mc-tecnico');
  sel.innerHTML = '<option value="">Sin asignar</option>';
  agTecnicos.filter(t => t.sucursal === suc).forEach(t => {
    sel.innerHTML += `<option value="${t.id}"${t.id == selId ? ' selected' : ''}>${t.nombre}</option>`;
  });
}

function mcRenderEstudios() {
  const cont = document.getElementById('mc-estudios-lista');
  cont.innerHTML = agEstudios.map(e => {
    const sel = agMcSel.some(x => x.id === e.id);
    return `<button type="button" class="mc-slot-btn${sel ? ' selected' : ''}" onclick="mcToggleEstudio(${e.id})" title="${e.categoria}">${escapeHTML(e.nombre)}<br><span style="font-size:9px;opacity:0.7;">$${fmt(e.precio)}</span></button>`;
  }).join('');
}

function mcToggleEstudio(id) {
  const e = agEstudios.find(x => x.id === id);
  if (!e) return;
  const idx = agMcSel.findIndex(x => x.id === id);
  if (idx !== -1) agMcSel.splice(idx, 1);
  else agMcSel.push(e);
  mcRenderEstudios();
  // Recalcular duración sugerida
  const totalMin = agMcSel.length * 15 || 30;
  const opciones = [15, 30, 45, 60, 90, 120];
  const dur = opciones.find(o => o >= totalMin) || 120;
  document.getElementById('mc-duracion').value = dur;
  mcCargarSlots();
}

async function mcCargarSlots() {
  const fecha = document.getElementById('mc-fecha').value;
  const suc = document.getElementById('mc-sucursal').value;
  const tec = document.getElementById('mc-tecnico').value;
  const dur = document.getElementById('mc-duracion').value;
  const wrap = document.getElementById('mc-slots-wrap');
  const prevIni = document.getElementById('mc-hora-inicio').value;
  if (!fecha || !suc) {
    wrap.innerHTML = '<div class="mc-slot-loading">Selecciona fecha y sucursal</div>';
    return;
  }
  wrap.innerHTML = '<div class="mc-slot-loading">Cargando horarios…</div>';
  try {
    let url = `/api/agenda/disponibilidad?fecha=${fecha}&sucursal=${suc}&duracion=${dur}`;
    if (tec) url += `&tecnico_id=${tec}`;
    // Excluir la cita que se está editando (el backend la excluye por estado)
    const r = await api(url);
    if (!r.ok) throw new Error();
    const slots = await r.json();
    const libres = slots.filter(s => s.libre);
    if (!libres.length) {
      wrap.innerHTML = '<div class="mc-slot-loading" style="color:var(--red);">Sin horarios disponibles para este día</div>';
      return;
    }
    document.getElementById('mc-hora-inicio').value = '';
    document.getElementById('mc-hora-fin').value = '';
    wrap.innerHTML = '<div class="mc-slots">' +
      slots.map(s => `
        <button type="button"
          class="mc-slot-btn${s.hora_inicio === prevIni ? ' selected' : ''}"
          ${!s.libre ? 'disabled' : ''}
          onclick="mcSelSlot('${s.hora_inicio}','${s.hora_fin}',this)"
        >${s.hora_inicio}</button>`).join('') + '</div>';
    if (prevIni) {
      document.getElementById('mc-hora-inicio').value = prevIni;
      // Recalc fin
      const dur2 = Number(document.getElementById('mc-duracion').value);
      const [hh, mm] = prevIni.split(':').map(Number);
      const finMin = hh * 60 + mm + dur2;
      document.getElementById('mc-hora-fin').value = String(Math.floor(finMin / 60)).padStart(2, '0') + ':' + String(finMin % 60).padStart(2, '0');
    }
  } catch (e) {
    if (e.isAuth) return;
    wrap.innerHTML = '<div class="mc-slot-loading" style="color:var(--red);">Error al cargar horarios</div>';
  }
}

function mcSelSlot(ini, fin, btn) {
  document.querySelectorAll('#mc-slots-wrap .mc-slot-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('mc-hora-inicio').value = ini;
  document.getElementById('mc-hora-fin').value = fin;
}

async function guardarCita() {
  document.getElementById('mc-err').style.display = 'none';
  const btn = document.getElementById('mc-btn-save');
  const nombre = document.getElementById('mc-pac-nombre').value.trim();
  const suc = document.getElementById('mc-sucursal').value;
  const fecha = document.getElementById('mc-fecha').value;
  const ini = document.getElementById('mc-hora-inicio').value;
  const fin = document.getElementById('mc-hora-fin').value;
  if (!nombre) { document.getElementById('mc-err').textContent = 'Nombre del paciente requerido'; document.getElementById('mc-err').style.display = 'block'; return; }
  if (!fecha) { document.getElementById('mc-err').textContent = 'Fecha requerida'; document.getElementById('mc-err').style.display = 'block'; return; }
  if (!ini) { document.getElementById('mc-err').textContent = 'Selecciona un horario'; document.getElementById('mc-err').style.display = 'block'; return; }
  const body = {
    sucursal: suc,
    tecnico_id: document.getElementById('mc-tecnico').value || null,
    paciente_nombre: nombre,
    paciente_celular: document.getElementById('mc-pac-cel').value.trim() || null,
    fecha, hora_inicio: ini, hora_fin: fin,
    duracion_min: Number(document.getElementById('mc-duracion').value),
    estudios_ids: agMcSel.map(e => e.id),
    estudios_nombres: agMcSel.map(e => e.nombre),
    notas: document.getElementById('mc-notas').value.trim() || null,
  };
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const method = agEditId ? 'PUT' : 'POST';
    const url = agEditId ? `/api/agenda/citas/${agEditId}` : '/api/agenda/citas';
    const r = await api(url, { method, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) { document.getElementById('mc-err').textContent = data.error || 'Error al guardar'; document.getElementById('mc-err').style.display = 'block'; return; }
    toast(agEditId ? 'Cita actualizada' : 'Cita creada ✔', '📅');
    cerrarModalCita();
    agRefresh();
  } catch (e) { if (e.isAuth) return; document.getElementById('mc-err').textContent = 'Error de conexión'; document.getElementById('mc-err').style.display = 'block'; }
  finally {
    btn.disabled = false; btn.textContent = '💾 Guardar cita';
  }
}

/* ═══════════════════════
   MODAL DETALLE CITA
═══════════════════════ */

function abrirDetalleCita(cita) {
  agDetalleCita = typeof cita === 'string' ? JSON.parse(cita) : cita;
  const c = agDetalleCita;
  document.getElementById('cd-title').textContent = `📋 ${c.paciente_nombre}`;
  document.getElementById('cd-estado-sel').value = c.estado;
  const tieneOrden = !!c.orden_folio;
  const btnOrden = document.getElementById('cd-btn-orden');
  btnOrden.disabled = tieneOrden;
  btnOrden.textContent = tieneOrden ? `📋 ${c.orden_folio}` : '🧾 Crear orden';
  document.getElementById('cd-info').innerHTML = `
    <div class="cd-row"><span class="cd-key">Fecha</span><span class="cd-val">${agFmtFecha(c.fecha)}</span></div>
    <div class="cd-row"><span class="cd-key">Horario</span><span class="cd-val">${c.hora_inicio} – ${c.hora_fin}</span></div>
    <div class="cd-row"><span class="cd-key">Sucursal</span><span class="cd-val">${c.sucursal}</span></div>
    ${c.tecnico_nombre ? `<div class="cd-row"><span class="cd-key">Técnico</span><span class="cd-val">${c.tecnico_nombre}</span></div>` : ''}
    ${c.paciente_celular ? `<div class="cd-row"><span class="cd-key">Celular</span><span class="cd-val">${c.paciente_celular}</span></div>` : ''}
    ${c.estudios_nombres ? `<div class="cd-row"><span class="cd-key">Estudios</span><span class="cd-val" style="max-width:240px;text-align:right;">${c.estudios_nombres}</span></div>` : ''}
    ${c.notas ? `<div class="cd-row"><span class="cd-key">Notas</span><span class="cd-val">${c.notas}</span></div>` : ''}
    <div class="cd-row"><span class="cd-key">Estado</span><span class="ag-pill ag-pill-${c.estado}">${c.estado.replace('_', ' ')}</span></div>
    <div class="cd-row"><span class="cd-key">Creada por</span><span class="cd-val">${c.creado_por}</span></div>
  `;
  document.getElementById('modal-cita-detalle').classList.add('open');
}

function cerrarModalDetalle() {
  document.getElementById('modal-cita-detalle').classList.remove('open');
  agDetalleCita = null;
}

async function cambiarEstadoCita() {
  if (!agDetalleCita) return;
  const estado = document.getElementById('cd-estado-sel').value;
  try {
    const r = await api(`/api/agenda/citas/${agDetalleCita.id}/estado`, { method: 'PATCH', body: JSON.stringify({ estado }) });
    if (!r.ok) { const d = await r.json(); toast(d.error || 'Error', '❌'); return; }
    toast(`Estado actualizado: ${estado.replace('_', ' ')}`, '✔');
    cerrarModalDetalle();
    agRefresh();
  } catch (e) { if (e.isAuth) return; toast('Error de conexión', '❌'); }
}

function editarCitaActual() {
  if (!agDetalleCita) return;
  cerrarModalDetalle();
  abrirModalCita(agDetalleCita);
}

async function cancelarCitaActual() {
  if (!agDetalleCita) return;
  if (!confirm(`¿Cancelar la cita de "${agDetalleCita.paciente_nombre}"?`)) return;
  try {
    const r = await api(`/api/agenda/citas/${agDetalleCita.id}`, { method: 'DELETE' });
    if (!r.ok) { const d = await r.json(); toast(d.error || 'Error', '❌'); return; }
    toast('Cita cancelada', '❌');
    cerrarModalDetalle();
    agRefresh();
  } catch (e) { if (e.isAuth) return; }
}

async function crearOrdenDesdeCita() {
  if (!agDetalleCita) return;
  const btn = document.getElementById('cd-btn-orden');
  btn.disabled = true; btn.textContent = 'Creando…';
  try {
    const r = await api(`/api/agenda/citas/${agDetalleCita.id}/orden`, { method: 'POST', body: JSON.stringify({ sucursal: agDetalleCita.sucursal }) });
    const d = await r.json();
    if (!r.ok) { toast(d.error || 'Error al crear orden', '❌'); btn.disabled = false; btn.textContent = '🧾 Crear orden'; return; }
    toast(`Orden creada: ${d.folio}`, '📋');
    cerrarModalDetalle();
    agRefresh();
  } catch (e) { if (e.isAuth) return; btn.disabled = false; btn.textContent = '🧾 Crear orden'; }
}

/* ═══════════════════════
   MODAL BLOQUEO
═══════════════════════ */

function abrirModalBloqueo() {
  document.getElementById('blq-err').style.display = 'none';
  document.getElementById('blq-suc').value = document.getElementById('ag-suc-sel').value;
  document.getElementById('blq-fecha').value = agFecha;
  document.getElementById('blq-motivo').value = '';
  document.getElementById('blq-ini').value = '12:00';
  document.getElementById('blq-fin').value = '13:00';
  // Técnicos en bloqueo
  const sel = document.getElementById('blq-tec');
  sel.innerHTML = '<option value="">Todos</option>';
  const suc = document.getElementById('ag-suc-sel').value;
  agTecnicos.filter(t => t.sucursal === suc).forEach(t => {
    sel.innerHTML += `<option value="${t.id}">${t.nombre}</option>`;
  });
  document.getElementById('modal-bloqueo').classList.add('open');
}

function cerrarModalBloqueo() {
  document.getElementById('modal-bloqueo').classList.remove('open');
}

async function guardarBloqueo() {
  document.getElementById('blq-err').style.display = 'none';
  const body = {
    sucursal: document.getElementById('blq-suc').value,
    tecnico_id: document.getElementById('blq-tec').value || null,
    fecha: document.getElementById('blq-fecha').value,
    hora_inicio: document.getElementById('blq-ini').value,
    hora_fin: document.getElementById('blq-fin').value,
    motivo: document.getElementById('blq-motivo').value.trim() || null,
  };
  if (!body.fecha || !body.hora_inicio || !body.hora_fin) {
    document.getElementById('blq-err').textContent = 'Completa todos los campos requeridos'; document.getElementById('blq-err').style.display = 'block'; return;
  }
  try {
    const r = await api('/api/agenda/bloqueos', { method: 'POST', body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { document.getElementById('blq-err').textContent = d.error || 'Error'; document.getElementById('blq-err').style.display = 'block'; return; }
    toast('Horario bloqueado', '🚫');
    cerrarModalBloqueo();
    agRefresh();
  } catch (e) { if (e.isAuth) return; document.getElementById('blq-err').textContent = 'Error de conexión'; document.getElementById('blq-err').style.display = 'block'; }
}

async function eliminarBloqueo(id) {
  if (!confirm('¿Eliminar este bloqueo?')) return;
  try {
    const r = await api(`/api/agenda/bloqueos/${id}`, { method: 'DELETE' });
    if (!r.ok) { toast('Error al eliminar bloqueo', '❌'); return; }
    toast('Bloqueo eliminado', '✔');
    agRefresh();
  } catch (e) { if (e.isAuth) return; }
}

// Cerrar modales de agenda con Escape
document.getElementById('modal-cita').addEventListener('click', function (e) { if (e.target === this) cerrarModalCita(); });
document.getElementById('modal-cita-detalle').addEventListener('click', function (e) { if (e.target === this) cerrarModalDetalle(); });
document.getElementById('modal-bloqueo').addEventListener('click', function (e) { if (e.target === this) cerrarModalBloqueo(); });

/* ── EMPRESA ── */

(function () {
  // Estado local, aislado del scope global
  let empLogoBase64 = null;  // base64 actual en pantalla (null = sin logo)
  let empOriginalData = {};    // snapshot del último guardado exitoso
  const MIME_VALIDOS = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
  function empEl(id) { return document.getElementById(id); }
  function empSetStatus(text, type = 'error') {
    const el = empEl('emp-status');
    el.textContent = text;
    el.className = type;
  }
  function empUpdatePreview() {
    empEl('emp-prev-nombre').textContent = empEl('emp-nombre').value.trim() || 'Nombre de la empresa';
    empEl('emp-prev-dir').textContent = empEl('emp-direccion').value.trim() || '—';
    empEl('emp-prev-ruc').textContent = empEl('emp-ruc').value.trim() || '—';
    empEl('emp-prev-rfc').textContent = empEl('emp-rfc').value.trim() || '—';
    empEl('emp-prev-tel').textContent = empEl('emp-telefono').value.trim() || '—';
    empEl('emp-prev-correo').textContent = empEl('emp-correo').value.trim() || '—';
  }
  ['emp-nombre', 'emp-direccion', 'emp-ruc', 'emp-rfc', 'emp-telefono', 'emp-correo'].forEach(id => {
    empEl(id).addEventListener('input', empUpdatePreview);
  });
  function empMostrarLogo(src) {
    empEl('emp-logo-img').src = src;
    empEl('emp-logo-img').style.display = 'block';
    empEl('emp-logo-placeholder').style.display = 'none';
    empEl('emp-prev-img').src = src;
    empEl('emp-prev-img').style.display = 'block';
    empEl('emp-prev-placeholder').style.display = 'none';
    empEl('emp-btn-remove-logo').style.display = 'inline-block';
  }
  function empQuitarLogo() {
    empLogoBase64 = null;
    empEl('emp-logo-img').src = '';
    empEl('emp-logo-img').style.display = 'none';
    empEl('emp-logo-placeholder').style.display = '';
    empEl('emp-prev-img').src = '';
    empEl('emp-prev-img').style.display = 'none';
    empEl('emp-prev-placeholder').style.display = '';
    empEl('emp-btn-remove-logo').style.display = 'none';
    empEl('emp-logo-input').value = '';
  }
  empEl('emp-btn-remove-logo').addEventListener('click', empQuitarLogo);
  empEl('emp-logo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Bug fix: validar MIME real antes de procesar
    if (!MIME_VALIDOS.includes(file.type)) {
      empSetStatus('Formato no válido. Usa JPG, PNG, WebP o SVG.', 'error');
      empEl('emp-logo-input').value = '';
      return;
    }
    // Bug fix: validar tamaño (2 MB)
    if (file.size > 2 * 1024 * 1024) {
      empSetStatus('El logo no puede superar 2 MB', 'error');
      empEl('emp-logo-input').value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      empLogoBase64 = ev.target.result;
      empMostrarLogo(empLogoBase64);
      empSetStatus('');
    };
    reader.onerror = () => empSetStatus('Error al leer el archivo', 'error');
    reader.readAsDataURL(file);
  });
  async function empCargar() {
    empEl('emp-loading').style.display = 'block';
    empEl('emp-form-body').style.display = 'none';
    try {
      const r = await api('/api/empresa');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      empEl('emp-nombre').value = d.nombre || '';
      empEl('emp-direccion').value = d.direccion || '';
      empEl('emp-ruc').value = d.ruc || '';
      empEl('emp-rfc').value = d.rfc || '';
      empEl('emp-telefono').value = d.telefono || '';
      empEl('emp-correo').value = d.correo || '';
      if (d.logo) { empLogoBase64 = d.logo; empMostrarLogo(d.logo); }
      else empQuitarLogo();
      empOriginalData = { ...d };
      empUpdatePreview();
    } catch (e) {
      if (e.isAuth) return;
      empSetStatus('No se pudieron cargar los datos de la empresa', 'error');
    } finally {
      empEl('emp-loading').style.display = 'none';
      empEl('emp-form-body').style.display = 'block';
    }
  }
  function empValidar() {
    const nombre = empEl('emp-nombre').value.trim();
    const correo = empEl('emp-correo').value.trim();
    const ruc = empEl('emp-ruc').value.trim();
    const rfc = empEl('emp-rfc').value.trim();
    if (!nombre) {
      empSetStatus('El nombre de la empresa es requerido', 'error');
      empEl('emp-nombre').focus();
      return false;
    }
    if (nombre.length > 120) {
      empSetStatus('El nombre no puede superar 120 caracteres', 'error');
      empEl('emp-nombre').focus();
      return false;
    }
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      empSetStatus('El correo electrónico no es válido', 'error');
      empEl('emp-correo').focus();
      return false;
    }
    if (ruc && !/^[\d\-]{5,20}$/.test(ruc)) {
      empSetStatus('El RUC solo debe contener números y guiones (5–20 caracteres)', 'error');
      empEl('emp-ruc').focus();
      return false;
    }
    if (rfc && !/^[A-Za-z0-9\-]{5,20}$/.test(rfc)) {
      empSetStatus('El RFC no es válido (5–20 caracteres alfanuméricos)', 'error');
      empEl('emp-rfc').focus();
      return false;
    }
    return true;
  }
  async function empGuardar() {
    empSetStatus('');
    if (!empValidar()) return;
    const btn = empEl('emp-btn-guardar');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const r = await api('/api/empresa', {
        method: 'PUT',
        body: JSON.stringify({
          nombre: empEl('emp-nombre').value.trim(),
          direccion: empCleanText(empEl('emp-direccion').value),
          ruc: empEl('emp-ruc').value.trim(),
          rfc: empEl('emp-rfc').value.trim(),
          telefono: empEl('emp-telefono').value.trim(),
          correo: empEl('emp-correo').value.trim(),
          logo: empLogoBase64 || null,
        })
      });
      const result = await r.json();
      if (!r.ok) { empSetStatus(result.error || 'Error al guardar', 'error'); return; }
      empOriginalData = { ...result };
      window.dispatchEvent(new CustomEvent('empresa-updated', { detail: result }));
      toast('Datos de empresa guardados', '✔');
      empSetStatus('');
    } catch (e) {
      if (e.isAuth) return;
      empSetStatus('No se pudo conectar con el servidor', 'error');
    } finally {
      btn.disabled = false; btn.textContent = '💾 Guardar cambios';
    }
  }
  function empCancelar() {
    empEl('emp-nombre').value = empOriginalData.nombre || '';
    empEl('emp-direccion').value = empOriginalData.direccion || '';
    empEl('emp-ruc').value = empOriginalData.ruc || '';
    empEl('emp-rfc').value = empOriginalData.rfc || '';
    empEl('emp-telefono').value = empOriginalData.telefono || '';
    empEl('emp-correo').value = empOriginalData.correo || '';
    // Bug fix: restaurar también el logo visual
    if (empOriginalData.logo) {
      empLogoBase64 = empOriginalData.logo;
      empMostrarLogo(empOriginalData.logo);
    } else {
      empQuitarLogo();
    }
    empSetStatus('');
    empUpdatePreview();
    toast('Cambios descartados', '↩️');
  }
  empEl('emp-btn-guardar').addEventListener('click', empGuardar);
  empEl('emp-btn-cancelar').addEventListener('click', empCancelar);
  // Exponer función de carga para que goTo la llame
  window.empIniciarVista = empCargar;
})();

/* ════════════════════════════════════════════════════
   MÓDULO: RESULTADOS / CARGA (inline)
════════════════════════════════════════════════════ */

(function () {
  'use strict';
  /* ── Estado ── */
  let resOrdenActual = null;
  let resEstudios = [];
  let resArchivos = [];
  let resPendingFiles = [];
  let resAllOrdenes = [];
  let resAllCompletados = [];
  let resOrdenCompActual = null;
  let resSearchTimer = null;
  let resCompSearchTimer = null;
  let resListController = null;
  let resCompController = null;
  let resTabActual = 'carga';
  let resInicializado = false;
  const RES_TIPOS_VALIDOS = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/bmp'];
  const RES_EXT_VALIDAS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.tiff', '.bmp'];
  const RES_STATUS = Object.freeze({
    PENDIENTE: 'pendiente',
    EN_PROCESO: 'en_proceso',
    COMPLETADO: 'completado',
    CANCELADO: 'cancelado'
  });
  /* ── Helpers ── */
  function escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function safeRelativeUrl(url) {
    const value = String(url || '');
    return value.startsWith('/') ? withAuthToken(value) : '#';
  }
  function isAbortError(err) {
    return err?.name === 'AbortError';
  }
  function resFileIcon(file) {
    if (!file) return '📄';
    return (file.type === 'application/pdf' || (file.name || '').endsWith('.pdf')) ? '📄' : '🖼️';
  }
  function resArchivoLabel(archivo) {
    return archivo?.estudio_nombre
      ? `${archivo.estudio_nombre} · ${archivo.archivo_nombre || 'Archivo'}`
      : (archivo?.archivo_nombre || 'Archivo');
  }
  function resFmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function resFmtMoney(value) {
    return '$' + Number(value || 0).toFixed(2);
  }
  function resGetCat(nombre) {
    const cats = {
      'BIOQUÍMICA': ['glucosa', 'colesterol', 'triglicéridos', 'urea', 'creatinina', 'ácido úrico'],
      'HEMATOLOGÍA': ['biometría', 'hemoglobina', 'hematocrito', 'plaquetas'],
      'INMUNOLOGÍA': ['pcr', 'fr', 'aso'],
      'UROANÁLISIS': ['orina', 'urocultivo'],
      'MICROBIOLOGÍA': ['coprocultivo', 'coproparasitoscópico'],
    };
    const n = (nombre || '').toLowerCase();
    for (const [cat, keys] of Object.entries(cats)) {
      if (keys.some(k => n.includes(k))) return cat;
    }
    return 'OTROS';
  }
  function resResolveCat(estudio) {
    return estudio?.categoria || resGetCat(estudio?.nombre);
  }
  function resEstadoBadge(estado) {
    const map = {
      [RES_STATUS.PENDIENTE]: { cls: 'badge-pendiente', txt: '⏳ Pendiente' },
      [RES_STATUS.EN_PROCESO]: { cls: 'badge-en_proceso', txt: '🔬 En proceso' },
      [RES_STATUS.COMPLETADO]: { cls: 'badge-completado', txt: '✅ Completado' },
    };
    const m = map[estado] || { cls: 'badge-pendiente', txt: estado };
    return `<span class="badge ${m.cls}">${m.txt}</span>`;
  }
  /* ── Tabs ── */
  window.resSwitchTab = function (tab) {
    resTabActual = tab;
    const esCarga = tab === 'carga';
    document.getElementById('res-section-carga').style.display = esCarga ? '' : 'none';
    document.getElementById('res-section-completados').style.display = esCarga ? 'none' : '';
    const tabCarga = document.getElementById('res-tab-carga');
    const tabComp = document.getElementById('res-tab-completados');
    // Usar className en vez de cssText+= para evitar acumulación de estilos
    tabCarga.style.background = esCarga ? 'white' : 'transparent';
    tabCarga.style.color = esCarga ? 'var(--text)' : 'var(--muted)';
    tabCarga.style.boxShadow = esCarga ? 'var(--shadow-sm)' : 'none';
    tabComp.style.background = !esCarga ? 'white' : 'transparent';
    tabComp.style.color = !esCarga ? 'var(--green-dark)' : 'var(--muted)';
    tabComp.style.boxShadow = !esCarga ? 'var(--shadow-sm)' : 'none';
    if (!esCarga) resCargarCompletados(document.getElementById('res-search-completados').value);
  };
  function resResetSeleccionCarga() {
    resOrdenActual = null;
    resEstudios = [];
    resArchivos = [];
    resPendingFiles = [];
    document.querySelectorAll('#res-patient-list .patient-row').forEach((row) => row.classList.remove('active'));
    document.getElementById('res-right-empty').style.display = '';
    document.getElementById('res-orden-section').style.display = 'none';
    document.getElementById('res-estudios-list').innerHTML = '';
    document.getElementById('res-progress-wrap').innerHTML = '';
    document.getElementById('res-save-summary').textContent = '—';
  }
  /* ══ CARGA DE RESULTADOS ══ */
  /* ── Cargar lista de pendientes ── */
  async function resCargarLista(buscar = '') {
    const container = document.getElementById('res-patient-list');
    container.innerHTML = '<div class="spinner"></div>';
    if (resListController) resListController.abort();
    const controller = new AbortController();
    resListController = controller;
    try {
      const params = new URLSearchParams({ buscar, limit: 60 });
      const r = await api(`/api/resultados/pendientes?${params}`, { signal: controller.signal });
      if (!r.ok) throw new Error();
      resAllOrdenes = await r.json();
      resRenderLista(resAllOrdenes, buscar);
    } catch (err) {
      if (isAbortError(err)) return;
      if (err.isAuth) return;
      container.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Error al cargar pacientes</div>';
    } finally {
      if (resListController === controller) resListController = null;
    }
  }
  function resRenderLista(ordenes, buscar = '') {
    const container = document.getElementById('res-patient-list');
    const countEl = document.getElementById('res-list-count');
    container.innerHTML = '';
    const q = (buscar || '').toLowerCase().trim();
    const filtradas = q
      ? ordenes.filter(o =>
        o.paciente_nombre.toLowerCase().includes(q) ||
        o.folio.toLowerCase().includes(q) ||
        (o.paciente_celular || '').toLowerCase().includes(q)
      )
      : ordenes;
    countEl.textContent = filtradas.length + ' orden' + (filtradas.length !== 1 ? 'es' : '');
    if (!filtradas.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${q ? '🔍' : '🎉'}</div>${q ? 'Sin resultados para esa búsqueda' : 'Sin órdenes pendientes'}</div>`;
      return;
    }
    const fragment = document.createDocumentFragment();
    filtradas.forEach(o => {
      const row = document.createElement('div');
      row.className = 'patient-row' + (resOrdenActual?.id === o.id ? ' active' : '');
      row.dataset.id = o.id;
      const fecha = o.fecha ? o.fecha.substring(0, 10) : '—';
      row.innerHTML = `
        <div class="p-name">${escapeHTML(o.paciente_nombre)}</div>
        <div class="p-meta">
          <span class="p-folio">${escapeHTML(o.folio)}</span>
          <span class="p-date">${escapeHTML(fecha)}</span>
          ${resEstadoBadge(o.estado)}
        </div>`;
      row.addEventListener('click', () => resSeleccionarOrden(o));
      fragment.appendChild(row);
    });
    container.appendChild(fragment);
  }
  /* ── Seleccionar orden ── */
  async function resSeleccionarOrden(orden) {
    document.querySelectorAll('#res-patient-list .patient-row').forEach(r => r.classList.remove('active'));
    const row = document.querySelector(`#res-patient-list .patient-row[data-id="${orden.id}"]`);
    if (row) row.classList.add('active');
    resOrdenActual = orden;
    resPendingFiles = [];
    resArchivos = [];
    document.getElementById('res-right-empty').style.display = 'none';
    document.getElementById('res-orden-section').style.display = '';
    document.getElementById('res-estudios-list').innerHTML = '<div class="spinner"></div>';
    try {
      const r = await api(`/api/resultados/orden/${encodeURIComponent(orden.folio)}`);
      if (!r.ok) throw new Error();
      const data = await r.json();
      resEstudios = data.estudios;
      resArchivos = Array.isArray(data.archivos) ? data.archivos : [];
      resOrdenActual = data.orden;
      resRenderOrdenInfo();
      resRenderEstudios();
    } catch (err) {
      if (err.isAuth) return;
      document.getElementById('res-estudios-list').innerHTML =
        '<div class="empty-state"><div class="icon">⚠️</div>Error al cargar estudios</div>';
    }
  }
  /* ── Render info de orden ── */
  function resRenderOrdenInfo() {
    const o = resOrdenActual;
    document.getElementById('res-orden-info').innerHTML = `
      <div class="inf-item"><span class="inf-lbl">Folio</span><span class="inf-val inf-folio">${escapeHTML(o.folio)}</span></div>
      <div class="inf-item"><span class="inf-lbl">Paciente</span><span class="inf-val">${escapeHTML(o.paciente_nombre)}</span></div>
      <div class="inf-item"><span class="inf-lbl">Médico</span><span class="inf-val">${escapeHTML(o.medico || '—')}</span></div>
      <div class="inf-item"><span class="inf-lbl">Sucursal</span><span class="inf-val">${escapeHTML(o.sucursal)}</span></div>
      <div class="inf-item"><span class="inf-lbl">Estado</span><span class="inf-val">${resEstadoBadge(o.estado)}</span></div>
      <div class="inf-item"><span class="inf-lbl">Archivos guardados</span><span class="inf-val">${resArchivos.length}</span></div>`;
  }
  /* ── Render barra de progreso ── */
  function resRenderProgress() {
    const total = resEstudios.length || 1;
    const archivosGuardados = resArchivos.length;
    const archivosPendientes = resPendingFiles.length;
    const pct = Math.min(100, Math.round(((archivosGuardados + archivosPendientes) / total) * 100));
    document.getElementById('res-progress-wrap').innerHTML = `
      <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px;">
        <span>Archivos listos para la orden</span>
        <span><strong>${archivosGuardados}</strong> guardados · <strong>${archivosPendientes}</strong> en cola</span>
      </div>
      <div style="height:6px;background:var(--border);border-radius:99px;overflow:hidden;">
        <div style="height:100%;border-radius:99px;background:var(--green);width:${pct}%;transition:width 0.4s ease;"></div>
      </div>`;
    const saveSum = document.getElementById('res-save-summary');
    saveSum.innerHTML = archivosPendientes > 0
      ? `Hay <strong>${archivosPendientes}</strong> archivo${archivosPendientes !== 1 ? 's' : ''} pendiente${archivosPendientes !== 1 ? 's' : ''} por guardar`
      : (archivosGuardados > 0
        ? `Puedes marcar la orden como <strong>completada</strong> cuando la revisión final esté lista`
        : `Aún no hay archivos cargados para esta orden`);
  }
  /* ── Render estudios con zonas de drop ── */
  function resRenderEstudios() {
    const container = document.getElementById('res-estudios-list');
    container.innerHTML = '';
    const panel = document.createElement('div');
    panel.style.display = 'grid';
    panel.style.gap = '14px';

    const estudiosCard = document.createElement('div');
    estudiosCard.className = 'res-estudio-item';
    estudiosCard.innerHTML = `
      <div class="res-estudio-head">
        <div class="res-estudio-head-left">
          <span class="res-estudio-num">01</span>
          <div>
            <div class="res-estudio-cat">ESTUDIOS DE LA ORDEN</div>
            <div class="res-estudio-nombre">${resEstudios.length} estudio${resEstudios.length !== 1 ? 's' : ''} registrado${resEstudios.length !== 1 ? 's' : ''}</div>
          </div>
        </div>
        <div class="res-file-status ${resEstudios.length ? 'ok' : 'empty'}">${resEstudios.length ? '✔ Orden lista para revisión' : '— Sin estudios'}</div>
      </div>
      <div class="res-upload-zone">
        <div style="display:grid;gap:8px;">
          ${resEstudios.map((e, idx) => `
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:#fbfdff;">
              <div>
                <div class="res-estudio-cat">${escapeHTML(resResolveCat(e))}</div>
                <div class="res-estudio-nombre" style="font-size:14px;">${String(idx + 1).padStart(2, '0')} · ${escapeHTML(e.nombre)}</div>
              </div>
              <div style="font-size:12px;color:var(--muted);font-weight:700;">${resFmtMoney(e.precio || 0)}</div>
            </div>
          `).join('')}
        </div>
      </div>`;
    panel.appendChild(estudiosCard);

    const cargaCard = document.createElement('div');
    cargaCard.className = 'res-estudio-item tiene-archivo';
    cargaCard.innerHTML = `
      <div class="res-estudio-head">
        <div class="res-estudio-head-left">
          <span class="res-estudio-num">02</span>
          <div>
            <div class="res-estudio-cat">ARCHIVOS DE RESULTADOS</div>
            <div class="res-estudio-nombre">Sube uno o varios archivos para toda la orden</div>
          </div>
        </div>
        <div class="res-file-status ${resArchivos.length || resPendingFiles.length ? 'ok' : 'empty'}">
          ${resArchivos.length + resPendingFiles.length} archivo${(resArchivos.length + resPendingFiles.length) !== 1 ? 's' : ''}
        </div>
      </div>
      <div class="res-upload-zone">
        ${resBuildDropArea('orden', 'Agregar archivos a la orden')}
        <div id="res-files-queue" style="margin-top:12px;"></div>
        <div id="res-files-saved" style="margin-top:12px;"></div>
      </div>`;
    panel.appendChild(cargaCard);

    container.appendChild(panel);
    resWireDrop('orden');
    resRenderArchivoPanels();
    resRenderProgress();
  }
  function resRenderArchivoPanels() {
    const queueWrap = document.getElementById('res-files-queue');
    const savedWrap = document.getElementById('res-files-saved');
    if (!queueWrap || !savedWrap) return;

    queueWrap.innerHTML = resPendingFiles.length
      ? `<div style="font-size:12px;font-weight:800;color:var(--muted);margin-bottom:8px;">Archivos en cola</div>
         <div style="display:grid;gap:8px;">
           ${resPendingFiles.map((file, index) => `
             <div class="res-file-preview">
               <span class="res-file-icon">${resFileIcon(file)}</span>
               <div class="res-file-info">
                 <div class="res-file-name">${escapeHTML(file.name)}</div>
                 <div class="res-file-size">${resFmtSize(file.size)}</div>
               </div>
               <button class="res-btn-remove-file" data-index="${index}">✕</button>
             </div>
           `).join('')}
         </div>`
      : '';

    savedWrap.innerHTML = resArchivos.length
      ? `<div style="font-size:12px;font-weight:800;color:var(--muted);margin-bottom:8px;">Archivos guardados</div>
         <div style="display:grid;gap:8px;">
           ${resArchivos.map((archivo) => {
             const nombre = escapeHTML(archivo.archivo_nombre || 'Resultado');
             const url = escapeHTML(safeRelativeUrl(archivo.archivo_url));
             const meta = archivo.estudio_nombre ? ` · ${escapeHTML(archivo.estudio_nombre)}` : '';
             const qrSrc = resSafeQrDataUrl(archivo.qr_base64);
             const qrHtml = qrSrc
               ? `<img class="res-qr-thumb" src="${escapeHTML(qrSrc)}" alt="QR de resultado">`
               : '<div class="res-qr-thumb res-qr-thumb-empty">QR</div>';
             return `
               <div class="res-existing-file" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                 <div style="display:flex;align-items:center;gap:10px;min-width:220px;flex:1;">
                   <span style="font-size:20px;">${(archivo.archivo_nombre || '').toLowerCase().endsWith('.pdf') ? '📄' : '🖼️'}</span>
                   <div>
                     <div class="res-existing-file-link" title="${nombre}">${nombre}</div>
                     <div style="font-size:11px;color:var(--muted);font-weight:600;">${escapeHTML((archivo.fecha || '').substring(0, 10) || 'Sin fecha')}${meta}</div>
                   </div>
                 </div>
                 <div class="res-qr-inline">${qrHtml}</div>
                 <div class="res-file-actions">
                   <button class="res-btn-file-action res-btn-view" data-url="${url}" data-nombre="${nombre}">👁️ Ver</button>
                   <a class="res-btn-file-action res-btn-download" href="#" data-url="${url}" data-nombre="${nombre}">⬇️ Descargar</a>
                   <button class="res-btn-file-action res-btn-qr" data-archivo="${archivo.id}">QR</button>
                   <button class="res-btn-file-action res-btn-copy-link" data-archivo="${archivo.id}">Copiar enlace</button>
                   <button class="res-btn-delete-file" data-archivo="${archivo.id}">🗑️</button>
                 </div>
               </div>`;
           }).join('')}
         </div>`
      : '<div style="font-size:12px;color:var(--muted);font-weight:600;">Todavía no hay archivos guardados para esta orden.</div>';

    queueWrap.querySelectorAll('.res-btn-remove-file').forEach((btn) => {
      btn.addEventListener('click', () => {
        resPendingFiles.splice(Number(btn.dataset.index), 1);
        resRenderArchivoPanels();
        resRenderProgress();
      });
    });
    savedWrap.querySelectorAll('.res-btn-view').forEach((btn) => {
      btn.addEventListener('click', () => resAbrirViewer(btn.dataset.url, btn.dataset.nombre));
    });
    savedWrap.querySelectorAll('.res-btn-download').forEach((link) => {
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        try {
          const blobUrl = await window.LabApi.apiBlobUrl(link.dataset.url);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = link.dataset.nombre || 'resultado';
          a.click();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
        } catch {
          toast('No se pudo descargar el archivo', '❌');
        }
      });
    });
    savedWrap.querySelectorAll('.res-btn-qr').forEach((btn) => {
      btn.addEventListener('click', () => {
        const archivo = resArchivos.find((item) => String(item.id) === String(btn.dataset.archivo));
        resImprimirQrResultado(archivo, resOrdenActual);
      });
    });
    savedWrap.querySelectorAll('.res-btn-copy-link').forEach((btn) => {
      btn.addEventListener('click', () => {
        const archivo = resArchivos.find((item) => String(item.id) === String(btn.dataset.archivo));
        resCopiarLinkResultado(archivo);
      });
    });
    savedWrap.querySelectorAll('.res-btn-delete-file').forEach((btn) => {
      btn.addEventListener('click', () => resEliminarArchivo(btn.dataset.archivo));
    });
  }
  function resBuildDropArea(targetId, label) {
    return `
      <div class="res-drop-area" id="res-drop-${targetId}">
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.tiff,.bmp" data-target="${targetId}" multiple>
        <div class="res-drop-label"><strong>${label}</strong> — arrastra o haz clic<br><span style="font-size:11px;">PDF · JPG · PNG · WEBP · TIFF</span></div>
      </div>`;
  }
  function resWireDrop(targetId) {
    const drop = document.getElementById(`res-drop-${targetId}`);
    if (!drop) return;
    const input = drop.querySelector('input[type="file"]');
    if (input) input.addEventListener('change', e => {
      const files = Array.from(e.target.files || []);
      if (files.length) resHandleFiles(files);
      e.target.value = '';
    });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) resHandleFiles(files);
    });
  }
  function resHandleFiles(files) {
    const validos = [];
    files.forEach((file) => {
      const permitido = RES_TIPOS_VALIDOS.includes(file.type) ||
        RES_EXT_VALIDAS.some(ext => file.name.toLowerCase().endsWith(ext));
      if (!permitido) return;
      if (file.size > 20 * 1024 * 1024) return;
      validos.push(file);
    });
    if (!validos.length) {
      toast('Solo se permiten PDF o imagenes de hasta 20 MB', '❌');
      return;
    }
    resPendingFiles.push(...validos);
    resRenderArchivoPanels();
    resRenderProgress();
  }
  /* ── Eliminar archivo existente ── */
  async function resEliminarArchivo(archivoId) {
    if (!confirm('¿Eliminar este archivo de resultado?')) return;
    try {
      const r = await api(`/api/resultados/archivo/${archivoId}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) { toast(data?.error || 'Error al eliminar archivo', '❌'); return; }
      resArchivos = resArchivos.filter((archivo) => String(archivo.id) !== String(archivoId));
      if (resOrdenActual && data?.estado) resOrdenActual.estado = data.estado;
      resRenderOrdenInfo();
      resRenderArchivoPanels();
      resRenderProgress();
      resCargarLista(document.getElementById('res-search-paciente').value);
      if (resTabActual === 'completados') {
        resCargarCompletados(document.getElementById('res-search-completados').value);
      }
      toast('Archivo eliminado', '🗑️');
    } catch (err) {
      if (err.isAuth) return;
      toast('Error al conectar', '❌');
    }
  }
  /* ── Guardar todos los archivos pendientes ── */
  async function resGuardarTodos() {
    if (!resPendingFiles.length) { toast('No hay archivos nuevos para guardar', '⚠️'); return; }
    const btn = document.getElementById('res-btn-save-all');
    btn.disabled = true; btn.textContent = 'Subiendo…';
    const fd = new FormData();
    fd.append('orden_id', resOrdenActual.id);
    resPendingFiles.forEach((file) => fd.append('archivos', file));
    try {
      const r = await (window.LabApi?.apiFetch || fetch)('/api/resultados/subir', {
        method: 'POST',
        body: fd
      });
      const data = await r.json();
      if (!r.ok) {
        toast(data?.error || 'Error al guardar archivos', '❌');
        return;
      }
      resArchivos = [...(data.archivos || []), ...resArchivos];
      resPendingFiles = [];
      if (data.estado) resOrdenActual.estado = data.estado;
      resRenderOrdenInfo();
      resRenderArchivoPanels();
      resRenderProgress();
      resCargarLista(document.getElementById('res-search-paciente').value);
      toast(`${data.archivos?.length || 0} archivo(s) guardado(s) correctamente`);
    } catch {
      toast('Error al conectar', '❌');
    } finally {
      btn.disabled = false; btn.textContent = '💾 Guardar archivos';
    }
  }
  async function resMarcarCompletada() {
    if (!resOrdenActual) return;
    if (!resArchivos.length) {
      toast('Carga al menos un archivo antes de completar la orden', '⚠️');
      return;
    }
    if (resPendingFiles.length) {
      toast('Guarda primero los archivos que siguen en cola', '⚠️');
      return;
    }
    const btn = document.getElementById('res-btn-mark-complete');
    btn.disabled = true;
    try {
      const r = await api(`/api/resultados/completar/${resOrdenActual.id}`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) {
        toast(data?.error || 'No se pudo completar la orden', '❌');
        return;
      }
      resOrdenActual.estado = data.estado || RES_STATUS.COMPLETADO;
      resRenderOrdenInfo();
      resCargarLista(document.getElementById('res-search-paciente').value);
      resCargarCompletados(document.getElementById('res-search-completados').value);
      toast('Orden marcada como completada');
      setTimeout(() => {
        resResetSeleccionCarga();
      }, 700);
    } catch {
      toast('Error al conectar', '❌');
    } finally {
      btn.disabled = false;
    }
  }
  async function resReabrirOrden() {
    if (!resOrdenCompActual) return;
    const btn = document.getElementById('res-btn-reopen-order');
    btn.disabled = true;
    try {
      const r = await api(`/api/resultados/reabrir/${resOrdenCompActual.id}`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) {
        toast(data?.error || 'No se pudo reabrir la orden', '❌');
        return;
      }
      toast('Orden reabierta para seguir cargando');
      resCargarCompletados(document.getElementById('res-search-completados').value);
      resCargarLista(document.getElementById('res-search-paciente').value);
      resSwitchTab('carga');
    } catch {
      toast('Error al conectar', '❌');
    } finally {
      btn.disabled = false;
    }
  }
  /* ══ COMPLETADOS ══ */
  async function resCargarCompletados(buscar = '') {
    const container = document.getElementById('res-comp-patient-list');
    container.innerHTML = '<div class="spinner"></div>';
    if (resCompController) resCompController.abort();
    const controller = new AbortController();
    resCompController = controller;
    try {
      const params = new URLSearchParams({ buscar, limit: 100, estado: 'completado' });
      const r = await api(`/api/resultados/completados?${params}`, { signal: controller.signal });
      if (!r.ok) {
        let detail = 'HTTP ' + r.status;
        try {
          const data = await r.json();
          detail = data?.error || detail;
        } catch { }
        throw new Error(detail);
      }
      resAllCompletados = await r.json();
      resRenderCompletados(resAllCompletados, buscar);
    } catch (err) {
      if (isAbortError(err)) return;
      if (err.isAuth) return;
      container.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Error al cargar: ' + err.message + '</div>';
    } finally {
      if (resCompController === controller) resCompController = null;
    }
  }
  function resRenderCompletados(ordenes, buscar = '') {
    const container = document.getElementById('res-comp-patient-list');
    const countEl = document.getElementById('res-comp-list-count');
    container.innerHTML = '';
    const q = (buscar || '').toLowerCase().trim();
    const filtradas = q
      ? ordenes.filter(o =>
        o.paciente_nombre.toLowerCase().includes(q) ||
        o.folio.toLowerCase().includes(q) ||
        (o.paciente_celular || '').toLowerCase().includes(q)
      )
      : ordenes;
    countEl.textContent = filtradas.length + ' orden' + (filtradas.length !== 1 ? 'es' : '');
    if (!filtradas.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${q ? '🔍' : '📭'}</div>${q ? 'Sin resultados para esa búsqueda' : 'No hay órdenes completadas'}</div>`;
      return;
    }
    const fragment = document.createDocumentFragment();
    filtradas.forEach(o => {
      const row = document.createElement('div');
      row.className = 'patient-row' + (resOrdenCompActual?.id === o.id ? ' active' : '');
      row.dataset.id = o.id;
      const fecha = o.fecha ? o.fecha.substring(0, 10) : '—';
      row.innerHTML = `
        <div class="p-name">${escapeHTML(o.paciente_nombre)}</div>
        <div class="p-meta">
          <span class="p-folio">${escapeHTML(o.folio)}</span>
          <span class="p-date">${escapeHTML(fecha)}</span>
          <span class="badge badge-completado">✅ Completado</span>
        </div>`;
      row.addEventListener('click', () => resSeleccionarCompletado(o));
      fragment.appendChild(row);
    });
    container.appendChild(fragment);
  }
  async function resSeleccionarCompletado(orden) {
    document.querySelectorAll('#res-comp-patient-list .patient-row').forEach(r => r.classList.remove('active'));
    const row = document.querySelector(`#res-comp-patient-list .patient-row[data-id="${orden.id}"]`);
    if (row) row.classList.add('active');
    resOrdenCompActual = orden;
    document.getElementById('res-comp-right-empty').style.display = 'none';
    document.getElementById('res-comp-orden-section').style.display = '';
    document.getElementById('res-comp-resultados-grid').innerHTML = '<div class="spinner" style="margin:32px auto;"></div>';
    try {
      const r = await api(`/api/resultados/orden/${encodeURIComponent(orden.folio)}`);
      if (!r.ok) throw new Error();
      const data = await r.json();
      resOrdenCompActual = data.orden;
      resRenderCompOrdenInfo(data.orden);
      resRenderCompResultados(data.archivos || []);
    } catch (err) {
      if (err.isAuth) return;
      document.getElementById('res-comp-resultados-grid').innerHTML =
        '<div class="res-completados-empty"><div class="big-icon">⚠️</div><div>Error al cargar los resultados</div></div>';
    }
  }
  function resRenderCompOrdenInfo(o) {
    const el = document.getElementById('res-comp-orden-info');
    el.textContent = '';
    const fields = [
      ['Folio', o.folio, 'inf-folio'],
      ['Paciente', o.paciente_nombre, ''],
      ['Médico', o.medico || '—', ''],
      ['Sucursal', o.sucursal, ''],
      ['Fecha', o.fecha ? o.fecha.substring(0, 10) : '—', ''],
    ];
    fields.forEach(([lbl, val, extraCls]) => {
      const item = document.createElement('div');
      item.className = 'inf-item';
      const l = document.createElement('span');
      l.className = 'inf-lbl'; l.textContent = lbl;
      const v = document.createElement('span');
      v.className = 'inf-val' + (extraCls ? ' ' + extraCls : '');
      v.textContent = val;
      item.append(l, v);
      el.appendChild(item);
    });
    // Estado badge — controlado, no datos de usuario
    const estadoItem = document.createElement('div');
    estadoItem.className = 'inf-item';
    const estadoLbl = document.createElement('span');
    estadoLbl.className = 'inf-lbl'; estadoLbl.textContent = 'Estado';
    const estadoVal = document.createElement('span');
    estadoVal.className = 'inf-val';
    const badgeEl = document.createElement('span');
    badgeEl.className = 'badge badge-completado';
    badgeEl.textContent = 'Completado';
    estadoVal.appendChild(badgeEl);
    estadoItem.append(estadoLbl, estadoVal);
    el.appendChild(estadoItem);
  }
  function resRenderCompResultados(archivos) {
    const grid = document.getElementById('res-comp-resultados-grid');
    grid.innerHTML = '';
    if (!archivos.length) {
      grid.innerHTML = `<div class="res-completados-empty" style="grid-column:1/-1;"><div class="big-icon">📭</div><div>Esta orden no tiene archivos adjuntos</div></div>`;
      return;
    }
    archivos.forEach((archivo) => {
      const esPDF = (archivo.archivo_nombre || '').toLowerCase().endsWith('.pdf');
      const card = document.createElement('div');
      card.className = 'res-resultado-card';
      const head = document.createElement('div');
      head.className = 'res-resultado-card-head';
      const cat = document.createElement('div');
      cat.className = 'res-resultado-card-cat';
      cat.textContent = archivo.estudio_categoria || (archivo.estudio_nombre ? 'ESTUDIO RELACIONADO' : 'ARCHIVO DE ORDEN');
      const nom = document.createElement('div');
      nom.className = 'res-resultado-card-nombre';
      nom.textContent = archivo.estudio_nombre || archivo.archivo_nombre || 'Resultado';
      head.append(cat, nom);
      const body = document.createElement('div');
      body.className = 'res-resultado-card-body';
      const icon = document.createElement('div');
      icon.className = 'res-resultado-card-icon';
      icon.textContent = esPDF ? '📄' : '🖼️';
      const info = document.createElement('div');
      info.className = 'res-resultado-card-info';
      const fname = document.createElement('div');
      fname.className = 'res-resultado-card-filename';
      fname.textContent = archivo.archivo_nombre || 'resultado';
      const actions = document.createElement('div');
      actions.className = 'res-resultado-card-actions';
      const qrSrc = resSafeQrDataUrl(archivo.qr_base64);
      let qrWrap = null;
      if (qrSrc) {
        qrWrap = document.createElement('div');
        qrWrap.className = 'res-resultado-card-qr';
        const qrImg = document.createElement('img');
        qrImg.src = qrSrc;
        qrImg.alt = 'QR de resultado';
        const qrText = document.createElement('div');
        qrText.textContent = 'QR listo para etiqueta';
        qrWrap.append(qrImg, qrText);
      }
      const btnVer = document.createElement('button');
      btnVer.className = 'res-btn-file-action res-btn-view';
      btnVer.textContent = '👁️ Ver';
      btnVer.addEventListener('click', () => resAbrirViewer(archivo.archivo_url, archivo.archivo_nombre || 'resultado'));
      const linkDl = document.createElement('a');
      linkDl.className = 'res-btn-file-action res-btn-download';
      linkDl.href = '#';
      linkDl.download = archivo.archivo_nombre || 'resultado';
      linkDl.textContent = '⬇️ Descargar';
      linkDl.addEventListener('click', async (event) => {
        event.preventDefault();
        try {
          const blobUrl = await window.LabApi.apiBlobUrl(safeRelativeUrl(archivo.archivo_url));
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = archivo.archivo_nombre || 'resultado';
          a.click();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
        } catch {
          toast('No se pudo descargar el archivo', '❌');
        }
      });
      const btnQr = document.createElement('button');
      btnQr.className = 'res-btn-file-action res-btn-qr';
      btnQr.textContent = 'QR';
      btnQr.addEventListener('click', () => resImprimirQrResultado(archivo, resOrdenCompActual));
      const btnCopy = document.createElement('button');
      btnCopy.className = 'res-btn-file-action res-btn-copy-link';
      btnCopy.textContent = 'Copiar enlace';
      btnCopy.addEventListener('click', () => resCopiarLinkResultado(archivo));
      actions.append(btnVer, linkDl, btnQr, btnCopy);
      if (qrWrap) info.append(fname, qrWrap, actions);
      else info.append(fname, actions);
      body.append(icon, info);
      card.append(head, body);
      grid.appendChild(card);
    });
  }
  function resSafeQrDataUrl(value) {
    const text = String(value || '').trim();
    return /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(text) ? text : '';
  }
  function resPublicResultUrl(archivo = {}) {
    if (archivo.viewer_url) return String(archivo.viewer_url);
    if (archivo.resultado_uuid) return `https://system-lab-mu.vercel.app/resultado/${encodeURIComponent(archivo.resultado_uuid)}`;
    if (archivo.r2_url && /^https:\/\//i.test(String(archivo.r2_url))) return String(archivo.r2_url);
    return '';
  }
  async function resCopiarLinkResultado(archivo) {
    const url = resPublicResultUrl(archivo);
    if (!url) {
      toast('Este archivo todavia no tiene enlace publico', '⚠️');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const area = document.createElement('textarea');
        area.value = url;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      toast('Enlace copiado');
    } catch {
      toast('No se pudo copiar el enlace', '❌');
    }
  }
  function resImprimirQrResultado(archivo, orden) {
    const qrSrc = resSafeQrDataUrl(archivo?.qr_base64);
    const url = resPublicResultUrl(archivo);
    if (!qrSrc || !url) {
      toast('Este archivo todavia no tiene QR imprimible', '⚠️');
      return;
    }
    const paciente = escapeHTML(orden?.paciente_nombre || 'Paciente');
    const folio = escapeHTML(orden?.folio || '');
    const estudio = escapeHTML(archivo?.estudio_nombre || archivo?.archivo_nombre || 'Resultado digital');
    const uuid = escapeHTML(archivo?.resultado_uuid || '');
    const safeUrl = escapeHTML(url);
    const safeQr = escapeHTML(qrSrc);
    const win = window.open('', '_blank', 'width=520,height=720');
    if (!win) {
      toast('Permite ventanas emergentes para imprimir el QR', '⚠️');
      return;
    }
    win.document.write(`<!doctype html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
        <title>QR ${folio}</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #17202a; background: #f4f6f7; }
          .sheet { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 18px; }
          .label { width: 78mm; min-height: 58mm; background: #fff; border: 1px solid #1f618d; border-radius: 8px; padding: 12px; text-align: center; }
          .brand { font-size: 16px; font-weight: 800; color: #1f618d; }
          .subtitle { margin-top: 2px; font-size: 10px; font-weight: 700; color: #566573; text-transform: uppercase; letter-spacing: .4px; }
          img { width: 34mm; height: 34mm; margin: 8px auto 6px; display: block; }
          .line { font-size: 11px; margin: 2px 0; font-weight: 700; }
          .muted { color: #566573; font-weight: 600; }
          .url { margin-top: 6px; font-size: 8px; color: #566573; word-break: break-all; }
          .actions { margin-top: 14px; text-align: center; }
          button { height: 36px; border: 0; border-radius: 7px; padding: 0 14px; background: #1f618d; color: #fff; font-weight: 800; cursor: pointer; }
          @media print {
            body { background: #fff; }
            .sheet { padding: 0; min-height: auto; display: block; }
            .label { margin: 0; border-color: #000; break-inside: avoid; }
            .actions { display: none; }
          }
        </style>
      </head>
      <body>
        <div class="sheet">
          <div>
            <div class="label">
              <div class="brand">Laboratorio Clinico</div>
              <div class="subtitle">Resultado digital</div>
              <img src="${safeQr}" alt="QR de resultado">
              <div class="line">Folio: ${folio}</div>
              <div class="line muted">Paciente: ${paciente}</div>
              <div class="line muted">${estudio}</div>
              ${uuid ? `<div class="line muted">ID: ${uuid}</div>` : ''}
              <div class="url">${safeUrl}</div>
            </div>
            <div class="actions"><button onclick="window.print()">Imprimir QR</button></div>
          </div>
        </div>
      </body>
      </html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }
  /* ══ VIEWER ══ */
  async function resAbrirViewer(url, nombre) {
    // Reutilizar viewer modal inline de resultados
    const modal = document.getElementById('res-viewer-modal');
    const title = document.getElementById('res-viewer-title');
    const body = document.getElementById('res-viewer-body');
    const dlBtn = document.getElementById('res-viewer-dl-btn');
    title.textContent = nombre || 'Resultado';
    body.innerHTML = '';
    let objectUrl = '';
    try {
      objectUrl = window.LabApi?.apiBlobUrl
        ? await window.LabApi.apiBlobUrl(safeRelativeUrl(url))
        : safeRelativeUrl(url);
    } catch (err) {
      body.textContent = 'No se pudo cargar el archivo';
      modal.classList.add('open');
      return;
    }
    dlBtn.href = objectUrl;
    dlBtn.download = nombre || 'resultado';
    const esPDF = (nombre || '').toLowerCase().endsWith('.pdf');
    const esImg = /\.(jpe?g|png|webp|tiff?|bmp)$/i.test(nombre || '');
    if (esPDF) {
      const iframe = document.createElement('iframe');
      iframe.src = objectUrl; iframe.title = nombre;
      body.appendChild(iframe);
    } else if (esImg) {
      const img = document.createElement('img');
      img.src = objectUrl; img.alt = nombre;
      body.appendChild(img);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'res-viewer-unsupported';
      const icon = document.createElement('div');
      icon.className = 'big-icon';
      icon.textContent = '📎';
      const msg = document.createElement('div');
      msg.textContent = 'Vista previa no disponible para este tipo de archivo.';
      const link = document.createElement('a');
      link.className = 'btn btn-primary btn-sm';
      link.href = objectUrl;
      link.download = nombre || 'resultado';
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.marginTop = '8px';
      link.textContent = '⬇️ Descargar archivo';
      wrap.append(icon, msg, link);
      body.appendChild(wrap);
    }
    modal.classList.add('open');
  }
  function resCerrarViewer() {
    document.getElementById('res-viewer-modal').classList.remove('open');
    document.getElementById('res-viewer-body').innerHTML = '';
  }
  /* ── Event listeners resultados ── */
  document.getElementById('res-btn-save-all').addEventListener('click', resGuardarTodos);
  document.getElementById('res-btn-clear-files').addEventListener('click', () => {
    resPendingFiles = [];
    resRenderArchivoPanels();
    resRenderProgress();
  });
  document.getElementById('res-btn-mark-complete').addEventListener('click', resMarcarCompletada);
  document.getElementById('res-btn-reopen-order').addEventListener('click', resReabrirOrden);
  document.getElementById('res-search-paciente').addEventListener('input', () => {
    clearTimeout(resSearchTimer);
    const q = document.getElementById('res-search-paciente').value;
    resRenderLista(resAllOrdenes, q);
    if (q.length === 0 || q.length > 2) {
      resSearchTimer = setTimeout(() => resCargarLista(q), 400);
    }
  });
  document.getElementById('res-search-completados').addEventListener('input', () => {
    clearTimeout(resCompSearchTimer);
    const q = document.getElementById('res-search-completados').value;
    resRenderCompletados(resAllCompletados, q);
    if (q.length === 0 || q.length > 2) {
      resCompSearchTimer = setTimeout(() => resCargarCompletados(q), 400);
    }
  });
  document.getElementById('res-viewer-modal').addEventListener('click', function (e) {
    if (e.target === this) resCerrarViewer();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('res-viewer-modal').classList.contains('open')) {
      resCerrarViewer();
    }
  });
  /* ── Punto de entrada desde goTo() ── */
  window.resIniciarVista = function () {
    if (!resInicializado) {
      resInicializado = true;
      resCargarLista();
    }
  };
})();

/* ── USUARIOS Y PERMISOS ── */

(function () {
  let usrLoaded = false;
  let usrMeta = null;
  let usrUsuarios = [];
  let usrEditandoId = null;
  function usrEl(id) { return document.getElementById(id); }
  function usrSetStatus(text = '', type = 'error') {
    const el = usrEl('usr-status');
    el.textContent = text;
    el.style.color = text ? (type === 'success' ? 'var(--green)' : 'var(--red)') : '';
  }
  function usrSetFormStatus(text = '', type = 'error') {
    const el = usrEl('usr-form-status');
    el.textContent = text;
    el.style.color = text ? (type === 'success' ? 'var(--green)' : 'var(--red)') : '';
  }
  function usrRoleLabel(role) {
    const map = {
      admin: 'Administrador',
      laboratorio: 'Laboratorio',
      recepcion: 'Recepcion',
    };
    return map[role] || role || 'Sin rol';
  }
  function usrEsc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function usrGetRoleDefaults(role) {
    if (!usrMeta || !usrMeta.defaults) return [];
    return Array.isArray(usrMeta.defaults[role]) ? usrMeta.defaults[role] : [];
  }
  function usrSelectedPermissions() {
    return Array.from(document.querySelectorAll('#usr-permissions input[type="checkbox"]:checked'))
      .map((input) => input.value)
      .sort();
  }
  function usrUpdatePermissionHint() {
    if (!usrMeta) return;
    const role = usrEl('usr-role').value;
    const current = usrSelectedPermissions();
    const defaults = usrGetRoleDefaults(role);
    const sameAsRole = current.length === defaults.length && current.every((permission, index) => permission === defaults[index]);
    usrEl('usr-perm-hint').textContent = sameAsRole
      ? 'Usando permisos base del rol'
      : 'Permisos personalizados para este usuario';
  }
  function usrApplyRoleDefaults() {
    const defaults = new Set(usrGetRoleDefaults(usrEl('usr-role').value));
    document.querySelectorAll('#usr-permissions input[type="checkbox"]').forEach((input) => {
      input.checked = defaults.has(input.value);
    });
    usrUpdatePermissionHint();
  }
  function usrRenderPermissionOptions(selected = []) {
    const wrap = usrEl('usr-permissions');
    if (!wrap || !usrMeta) return;
    const selectedSet = new Set(selected);
    wrap.innerHTML = '';
    usrMeta.permissions.forEach((permission) => {
      const label = document.createElement('label');
      label.className = 'usr-perm-option';
      label.innerHTML = `
        <input type="checkbox" value="${permission}">
        <span>${permission}</span>
      `;
      const input = label.querySelector('input');
      input.checked = selectedSet.has(permission);
      input.addEventListener('change', usrUpdatePermissionHint);
      wrap.appendChild(label);
    });
    usrUpdatePermissionHint();
  }
  function usrResetForm() {
    usrEditandoId = null;
    usrEl('usr-form-title').textContent = '➕ Nuevo usuario';
    usrEl('usr-btn-save').textContent = 'Guardar';
    usrEl('usr-usuario').value = '';
    usrEl('usr-password').value = '';
    usrEl('usr-btn-delete').style.display = 'none';
    usrSetFormStatus('');
    if (usrMeta?.roles?.length) {
      usrEl('usr-role').value = usrMeta.roles[0];
      usrRenderPermissionOptions(usrGetRoleDefaults(usrMeta.roles[0]));
    }
  }
  function usrFillForm(user) {
    usrEditandoId = user.id;
    usrEl('usr-form-title').textContent = `✏️ Editar ${user.usuario}`;
    usrEl('usr-btn-save').textContent = 'Actualizar';
    usrEl('usr-usuario').value = user.usuario || '';
    usrEl('usr-password').value = '';
    usrEl('usr-role').value = user.role || (usrMeta?.roles?.[0] || 'recepcion');
    usrRenderPermissionOptions(Array.isArray(user.permissions) ? user.permissions : usrGetRoleDefaults(usrEl('usr-role').value));
    usrEl('usr-btn-delete').style.display = Number(user.id) === Number(authUser.id) ? 'none' : '';
    usrSetFormStatus(user.hasCustomPermissions ? 'Este usuario ya usa permisos personalizados.' : 'Este usuario usa los permisos base de su rol.', user.hasCustomPermissions ? 'success' : 'success');
  }
  function usrRenderTable() {
    const wrap = usrEl('usr-table-wrap');
    if (!wrap) return;
    if (!usrUsuarios.length) {
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="icon">👤</div>
          <div>No hay usuarios registrados.</div>
        </div>
      `;
      return;
    }
    const rows = usrUsuarios.map((user) => `
      <tr>
        <td>
          <div style="font-weight:800;">${usrEsc(user.usuario)}</div>
          <div style="font-size:12px;color:var(--muted);">${user.permissions.length} permisos efectivos</div>
        </td>
        <td><span class="usr-role-pill">${usrEsc(usrRoleLabel(user.role))}</span></td>
        <td>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${user.permissions.map((permission) => `<span class="usr-perm-tag">${usrEsc(permission)}</span>`).join('')}
          </div>
        </td>
        <td style="width:110px;text-align:right;">
          <button class="btn btn-ghost btn-sm" data-usr-edit="${user.id}">Editar</button>
        </td>
      </tr>
    `).join('');
    wrap.innerHTML = `
      <div style="overflow:auto;">
        <table class="usr-table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Rol</th>
              <th>Permisos efectivos</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    wrap.querySelectorAll('[data-usr-edit]').forEach((button) => {
      button.addEventListener('click', () => {
        const user = usrUsuarios.find((item) => Number(item.id) === Number(button.dataset.usrEdit));
        if (user) usrFillForm(user);
      });
    });
  }
  async function usrLoadData() {
    usrSetStatus('Cargando usuarios...');
    usrEl('usr-table-wrap').innerHTML = '<div class="spinner"></div>';
    try {
      const [metaRes, usersRes] = await Promise.all([
        api('/api/usuarios/meta'),
        api('/api/usuarios'),
      ]);
      if (!metaRes.ok || !usersRes.ok) {
        const metaError = metaRes.ok ? null : await metaRes.json().catch(() => ({}));
        const usersError = usersRes.ok ? null : await usersRes.json().catch(() => ({}));
        throw new Error(metaError?.error || usersError?.error || 'No se pudo cargar la administracion de usuarios');
      }
      usrMeta = await metaRes.json();
      usrUsuarios = await usersRes.json();
      const roleSelect = usrEl('usr-role');
      roleSelect.innerHTML = usrMeta.roles.map((role) => `<option value="${role}">${usrRoleLabel(role)}</option>`).join('');
      usrRenderTable();
      if (!usrLoaded || !usrEditandoId) {
        usrResetForm();
      } else {
        const current = usrUsuarios.find((item) => Number(item.id) === Number(usrEditandoId));
        if (current) usrFillForm(current);
      }
      usrLoaded = true;
      usrSetStatus(`Usuarios cargados: ${usrUsuarios.length}`, 'success');
    } catch (err) {
      usrSetStatus(err.message || 'No se pudo cargar la vista de usuarios');
      usrEl('usr-table-wrap').innerHTML = `
        <div class="empty-state">
          <div class="icon">⚠️</div>
          <div>No se pudo cargar la informacion.</div>
        </div>
      `;
    }
  }
  async function usrSave() {
    usrSetFormStatus('');
    const usuario = usrEl('usr-usuario').value.trim();
    const password = usrEl('usr-password').value;
    const role = usrEl('usr-role').value;
    const permissions = usrSelectedPermissions();
    if (!usuario) {
      usrSetFormStatus('El usuario es obligatorio.');
      usrEl('usr-usuario').focus();
      return;
    }
    if (!usrEditandoId && !password.trim()) {
      usrSetFormStatus('La contraseña es obligatoria al crear un usuario.');
      usrEl('usr-password').focus();
      return;
    }
    const btn = usrEl('usr-btn-save');
    btn.disabled = true;
    btn.textContent = usrEditandoId ? 'Guardando...' : 'Creando...';
    try {
      const res = await api(usrEditandoId ? `/api/usuarios/${usrEditandoId}` : '/api/usuarios', {
        method: usrEditandoId ? 'PUT' : 'POST',
        body: JSON.stringify({ usuario, password, role, permissions }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        usrSetFormStatus(data.error || 'No se pudo guardar el usuario.');
        return;
      }
      const editedId = usrEditandoId;
      const isSelfUpdate = data.token && Number(editedId) === Number(authUser.id);
      if (data.token) {
        sessionStorage.setItem('token', data.token);
        sessionStorage.setItem('role', data.role || role);
        sessionStorage.setItem('permissions', JSON.stringify(Array.isArray(data.permissions) ? data.permissions : permissions));
        sessionStorage.setItem('tokenIssuedAt', String(Date.now()));
      }
      usrSetFormStatus(usrEditandoId ? 'Usuario actualizado correctamente.' : 'Usuario creado correctamente.', 'success');
      toast(usrEditandoId ? 'Usuario actualizado' : 'Usuario creado', 'OK');
      if (isSelfUpdate) {
        setTimeout(() => window.location.reload(), 350);
        return;
      }
      await usrLoadData();
      usrResetForm();
    } catch (err) {
      if (!err.isAuth) usrSetFormStatus('No se pudo conectar con el servidor.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar usuario';
    }
  }
  async function usrDelete() {
    if (!usrEditandoId) return;
    const current = usrUsuarios.find((item) => Number(item.id) === Number(usrEditandoId));
    if (!current) return;
    if (!confirm(`¿Eliminar al usuario ${current.usuario}?`)) return;
    usrSetFormStatus('');
    const btn = usrEl('usr-btn-delete');
    btn.disabled = true;
    btn.textContent = 'Eliminando...';
    try {
      const res = await api(`/api/usuarios/${usrEditandoId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        usrSetFormStatus(data.error || 'No se pudo eliminar el usuario.');
        return;
      }
      toast('Usuario eliminado', 'OK');
      usrResetForm();
      await usrLoadData();
    } catch (err) {
      if (!err.isAuth) usrSetFormStatus('No se pudo conectar con el servidor.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Eliminar';
    }
  }
  usrEl('usr-btn-refresh')?.addEventListener('click', usrLoadData);
  usrEl('usr-btn-save')?.addEventListener('click', usrSave);
  usrEl('usr-btn-reset')?.addEventListener('click', usrResetForm);
  usrEl('usr-btn-delete')?.addEventListener('click', usrDelete);
  usrEl('usr-btn-defaults')?.addEventListener('click', usrApplyRoleDefaults);
  usrEl('usr-role')?.addEventListener('change', () => {
    if (!usrMeta) return;
    usrApplyRoleDefaults();
  });
  window.usrIniciarVista = async function () {
    if (!can('usuarios.manage')) return;
    if (!usrLoaded) {
      await usrLoadData();
    }
  };
})();

/* ── INIT ── */

loadDashboard();

/* Empresa: sincronizacion segura, branding compartido y listeners saneados */

(function () {
  const MIME_VALIDOS = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
  const EMPRESA_FIELDS = ['nombre', 'direccion', 'ruc', 'rfc', 'telefono', 'correo'];
  const EMPRESA_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const EMPRESA_RUC_RE = /^[\d-]{5,20}$/;
  const EMPRESA_RFC_RE = /^[A-Za-z0-9-]{5,20}$/;
  let empLogoBase64 = null;
  let empOriginalData = empEmptyData();
  let empConflictData = null;
  let empLoadSeq = 0;
  let empBrandData = empEmptyData();
  function empEl(id) { return document.getElementById(id); }
  function empEmptyData() {
    return { nombre: '', direccion: '', ruc: '', rfc: '', telefono: '', correo: '', logo: null, updated_at: null };
  }
  function empCleanText(value) {
    return String(value || '')
      .replace(/[\u0000-\u001F\u007F\uFEFF\u200B-\u200D]/g, ' ')
      .replace(/\uFFFD/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function empCleanPhone(value) {
    return empCleanText(value).replace(/[^0-9+()\-. ext]/gi, '').trim();
  }
  function empNormalize(data = {}) {
    return {
      nombre: empCleanText(data.nombre),
      direccion: empCleanText(data.direccion),
      ruc: empCleanText(data.ruc),
      rfc: empCleanText(data.rfc),
      telefono: empCleanPhone(data.telefono),
      correo: empCleanText(data.correo),
      logo: data.logo || null,
      updated_at: data.updated_at || null,
    };
  }
  function empCurrentFormData() {
    return {
      nombre: empCleanText(empEl('emp-nombre').value),
      direccion: empCleanText(empEl('emp-direccion').value),
      ruc: empCleanText(empEl('emp-ruc').value),
      rfc: empCleanText(empEl('emp-rfc').value),
      telefono: empCleanPhone(empEl('emp-telefono').value),
      correo: empCleanText(empEl('emp-correo').value),
      logo: empLogoBase64 || null,
      updated_at: empOriginalData.updated_at || null,
    };
  }
  function empSameData(a, b) {
    return EMPRESA_FIELDS.every((field) => (a[field] || '') === (b[field] || '')) && (a.logo || null) === (b.logo || null);
  }
  function empHasUnsavedChanges() {
    return !empSameData(empCurrentFormData(), empOriginalData);
  }
  function empSetStatus(text = '', type = 'error') {
    const el = empEl('emp-status');
    el.textContent = text;
    el.className = text ? type : '';
  }
  function empSetFormEnabled(enabled) {
    ['emp-logo-input', 'emp-nombre', 'emp-direccion', 'emp-ruc', 'emp-rfc', 'emp-telefono', 'emp-correo', 'emp-btn-remove-logo', 'emp-btn-guardar', 'emp-btn-cancelar'].forEach((id) => {
      const node = empEl(id);
      if (node) node.disabled = !enabled;
    });
    const overlay = document.querySelector('.emp-logo-overlay');
    if (overlay) {
      overlay.style.pointerEvents = enabled ? '' : 'none';
      overlay.style.opacity = enabled ? '1' : '0.55';
    }
  }
  function empShowLogo(src) {
    empEl('emp-logo-img').src = src;
    empEl('emp-logo-img').style.display = 'block';
    empEl('emp-logo-placeholder').style.display = 'none';
    empEl('emp-prev-img').src = src;
    empEl('emp-prev-img').style.display = 'block';
    empEl('emp-prev-placeholder').style.display = 'none';
    empEl('emp-btn-remove-logo').style.display = 'inline-block';
  }
  function empRemoveLogo() {
    empLogoBase64 = null;
    empEl('emp-logo-img').src = '';
    empEl('emp-logo-img').style.display = 'none';
    empEl('emp-logo-placeholder').style.display = '';
    empEl('emp-prev-img').src = '';
    empEl('emp-prev-img').style.display = 'none';
    empEl('emp-prev-placeholder').style.display = '';
    empEl('emp-btn-remove-logo').style.display = 'none';
    empEl('emp-logo-input').value = '';
  }
  function empApplyBranding(data = {}) {
    const next = empNormalize({ ...empBrandData, ...data });
    empBrandData = next;
    const fallback = empEl('sb-brand-icon-fallback');
    const img = empEl('sb-brand-icon-img');
    empEl('sb-brand-name').textContent = next.nombre || 'SIS Laboratory';
    empEl('sb-brand-sub').textContent = 'Sistema de gestión';
    if (next.logo) {
      img.src = next.logo;
      img.style.display = 'block';
      fallback.style.display = 'none';
    } else {
      img.src = '';
      img.style.display = 'none';
      fallback.style.display = '';
    }
  }
  function empUpdatePreview() {
    const current = empCurrentFormData();
    empEl('emp-prev-nombre').textContent = current.nombre || 'Nombre de la empresa';
    empEl('emp-prev-dir').textContent = current.direccion || '—';
    empEl('emp-prev-ruc').textContent = current.ruc || '—';
    empEl('emp-prev-rfc').textContent = current.rfc || '—';
    empEl('emp-prev-tel').textContent = current.telefono || '—';
    empEl('emp-prev-correo').textContent = current.correo || '—';
    empApplyBranding(current);
  }
  function empResetForm(data = empEmptyData()) {
    const next = empNormalize(data);
    empEl('emp-nombre').value = next.nombre;
    empEl('emp-direccion').value = next.direccion;
    empEl('emp-ruc').value = next.ruc;
    empEl('emp-rfc').value = next.rfc;
    empEl('emp-telefono').value = next.telefono;
    empEl('emp-correo').value = next.correo;
    if (next.logo) {
      empLogoBase64 = next.logo;
      empShowLogo(next.logo);
    } else {
      empRemoveLogo();
    }
    empUpdatePreview();
  }
  function empApplyLoadedData(data) {
    const next = empNormalize(data);
    empConflictData = null;
    empOriginalData = next;
    empResetForm(next);
    empApplyBranding(next);
  }
  function empValidar() {
    const current = empCurrentFormData();
    if (!current.nombre) {
      empSetStatus('El nombre de la empresa es requerido', 'error');
      empEl('emp-nombre').focus();
      return false;
    }
    if (current.nombre.length > 120) {
      empSetStatus('El nombre no puede superar 120 caracteres', 'error');
      empEl('emp-nombre').focus();
      return false;
    }
    if (current.correo && !EMPRESA_EMAIL_RE.test(current.correo)) {
      empSetStatus('El correo electrónico no es válido', 'error');
      empEl('emp-correo').focus();
      return false;
    }
    if (current.ruc && !EMPRESA_RUC_RE.test(current.ruc)) {
      empSetStatus('El RUC solo debe contener numeros y guiones (5-20 caracteres)', 'error');
      empEl('emp-ruc').focus();
      return false;
    }
    if (current.rfc && !EMPRESA_RFC_RE.test(current.rfc)) {
      empSetStatus('El RFC no es válido (5-20 caracteres alfanuméricos)', 'error');
      empEl('emp-rfc').focus();
      return false;
    }
    if (!empOriginalData.updated_at) {
      empSetStatus('Primero recarga los datos de la empresa antes de guardar.', 'error');
      return false;
    }
    return true;
  }
  async function empRefreshBranding() {
    if (empEl('view-empresa').classList.contains('active') && empHasUnsavedChanges()) return;
    try {
      const r = await api('/api/empresa');
      if (!r.ok) return;
      empApplyBranding(await r.json());
    } catch (e) {
      if (!e.isAuth) console.error(e);
    }
  }
  async function empCargarSegura() {
    const requestId = ++empLoadSeq;
    let canEdit = false;
    empSetStatus('');
    empSetFormEnabled(false);
    empEl('emp-loading').style.display = 'block';
    empEl('emp-form-body').style.display = 'none';
    try {
      const r = await api('/api/empresa');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (requestId !== empLoadSeq) return;
      empApplyLoadedData(data);
      canEdit = true;
    } catch (e) {
      if (requestId !== empLoadSeq || e.isAuth) return;
      empOriginalData = empEmptyData();
      empConflictData = null;
      empResetForm();
      empSetStatus('No se pudieron cargar los datos de la empresa. Vuelve a entrar a esta vista para reintentar.', 'error');
    } finally {
      if (requestId !== empLoadSeq) return;
      empEl('emp-loading').style.display = 'none';
      empEl('emp-form-body').style.display = 'block';
      empSetFormEnabled(canEdit);
    }
  }
  async function empGuardarSeguro() {
    empSetStatus('');
    if (!empValidar()) return;
    const payload = empCurrentFormData();
    const btn = empEl('emp-btn-guardar');
    btn.disabled = true;
    btn.textContent = 'Guardando...';
    try {
      const r = await api('/api/empresa', {
        method: 'PUT',
        body: JSON.stringify({ ...payload, version: empOriginalData.updated_at })
      });
      const result = await r.json();
      if (!r.ok) {
        if (r.status === 409 && result.current) {
          empConflictData = empNormalize(result.current);
          empSetStatus(result.error || 'La configuración fue modificada por otro usuario. Usa Cancelar para cargar la versión actual.', 'error');
          return;
        }
        empSetStatus(result.error || 'Error al guardar', 'error');
        return;
      }
      empApplyLoadedData(result);
      window.dispatchEvent(new CustomEvent('empresa-updated', { detail: result }));
      toast('Datos de empresa guardados', 'OK');
      empSetStatus('Cambios sincronizados correctamente', 'success');
    } catch (e) {
      if (e.isAuth) return;
      empSetStatus('No se pudo conectar con el servidor', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar cambios';
    }
  }
  function empCancelarSeguro() {
    empApplyLoadedData(empConflictData || empOriginalData);
    empSetStatus('');
    empSetFormEnabled(Boolean(empOriginalData.updated_at));
    toast('Cambios descartados', '↩');
  }
  function empReplaceNode(id) {
    const node = empEl(id);
    const clone = node.cloneNode(true);
    node.parentNode.replaceChild(clone, node);
    return clone;
  }
  const logoInput = empReplaceNode('emp-logo-input');
  const removeBtn = empReplaceNode('emp-btn-remove-logo');
  const saveBtn = empReplaceNode('emp-btn-guardar');
  const cancelBtn = empReplaceNode('emp-btn-cancelar');
  ['emp-nombre', 'emp-direccion', 'emp-ruc', 'emp-rfc', 'emp-telefono', 'emp-correo'].forEach((id) => {
    empEl(id).addEventListener('input', () => {
      if (empConflictData) empConflictData = null;
      empUpdatePreview();
      if (empEl('emp-status').className === 'success') empSetStatus('');
    });
  });
  logoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!MIME_VALIDOS.includes(file.type)) {
      empSetStatus('Formato no válido. Usa JPG, PNG, WebP o SVG.', 'error');
      logoInput.value = '';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      empSetStatus('El logo no puede superar 2 MB', 'error');
      logoInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      empConflictData = null;
      empLogoBase64 = ev.target.result;
      empShowLogo(empLogoBase64);
      empUpdatePreview();
      empSetStatus('');
    };
    reader.onerror = () => empSetStatus('Error al leer el archivo', 'error');
    reader.readAsDataURL(file);
  });
  removeBtn.addEventListener('click', () => {
    empConflictData = null;
    empRemoveLogo();
    empUpdatePreview();
    empSetStatus('');
  });
  saveBtn.textContent = 'Guardar cambios';
  saveBtn.addEventListener('click', empGuardarSeguro);
  cancelBtn.addEventListener('click', empCancelarSeguro);
  const logoPanel = document.querySelector('.emp-logo-panel');
  if (logoPanel && !logoPanel.querySelector('.emp-brand-note')) {
    const note = document.createElement('div');
    note.className = 'emp-brand-note';
    note.textContent = 'El logo se refleja en la vista previa, en los documentos generados y en el icono lateral del sistema.';
    logoPanel.insertBefore(note, removeBtn);
  }
  window.empPuedeSalirVista = function (nextView) {
    if (!empHasUnsavedChanges()) return true;
    return window.confirm(nextView === 'empresa'
      ? 'Hay cambios sin guardar en Empresa. Si recargas esta vista, se perderán. ¿Deseas continuar?'
      : 'Hay cambios sin guardar en Empresa. Si sales ahora, se perderán. ¿Deseas continuar?');
  };
  window.empIniciarVista = empCargarSegura;
  window.empRefrescarBranding = empRefreshBranding;
  empRefrescarBranding();
})();
