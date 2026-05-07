(function () {
  'use strict';

  let bqOrdenActual = null;
  let bqOffset = 0;
  const BQ_LIMIT = 20;
  let bqSearchTimer = null;
  let bqInicializado = false;

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function fmtSafe(value) {
    return typeof fmt === 'function' ? fmt(value) : Number(value || 0).toFixed(2);
  }

  function fmtDateSafe(value) {
    return typeof fmtDate === 'function' ? fmtDate(value) : String(value || '').slice(0, 10);
  }

  function badgeSafe(value) {
    return typeof badge === 'function' ? badge(value) : esc(value || '');
  }

  function sexoPacienteLabel(value) {
    if (value === 'M') return 'Masculino';
    if (value === 'F') return 'Femenino';
    if (value === 'O') return 'Otro';
    return 'Paciente';
  }

  function formatBirthDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return raw;
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  function formatLabelDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) return raw.replace('T', ' ').slice(0, 16);
    return `${parsed.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' })} ${parsed.toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}`;
  }

  function bqIniciarVista() {
    const q = document.getElementById('bq-q').value.trim();
    if (!bqInicializado) {
      bqInicializado = true;
      bqBuscar(0);
    } else if (!q && !document.getElementById('bq-estado').value && !document.getElementById('bq-desde').value) {
      bqBuscar(0);
    }
  }

  function bqGetFiltros() {
    return {
      q: document.getElementById('bq-q').value.trim(),
      estado: document.getElementById('bq-estado').value,
      sucursal: document.getElementById('bq-sucursal').value,
      fechaDesde: document.getElementById('bq-desde').value,
      fechaHasta: document.getElementById('bq-hasta').value,
    };
  }

  function bqLimpiar() {
    document.getElementById('bq-q').value = '';
    document.getElementById('bq-estado').value = '';
    document.getElementById('bq-sucursal').value = '';
    document.getElementById('bq-desde').value = '';
    document.getElementById('bq-hasta').value = '';
    document.getElementById('bq-count').textContent = '-';
    document.getElementById('bq-pagination').innerHTML = '';
    document.getElementById('bq-table-container').innerHTML = `
      <div class="empty-state" style="min-height:220px;">
        <div class="icon">🔍</div><div>Usa los filtros para buscar ordenes</div>
      </div>`;
    bqCerrarDetalle();
  }

  async function bqBuscar(offset = 0) {
    bqOffset = offset;
    const f = bqGetFiltros();
    const qs = new URLSearchParams({ limit: BQ_LIMIT, offset });
    if (f.q) qs.set('q', f.q);
    if (f.estado) qs.set('estado', f.estado);
    if (f.sucursal) qs.set('sucursal', f.sucursal);
    if (f.fechaDesde) qs.set('fecha_desde', f.fechaDesde);
    if (f.fechaHasta) qs.set('fecha_hasta', f.fechaHasta);

    const container = document.getElementById('bq-table-container');
    container.innerHTML = '<div class="spinner"></div>';
    document.getElementById('bq-count').textContent = '...';

    try {
      const r = await api(`/api/ordenes/buscar?${qs.toString()}`);
      if (!r.ok) {
        container.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>Error al buscar</div></div>';
        return;
      }
      const data = await r.json();
      bqRenderTabla(data.ordenes || []);
      bqRenderPaginacion(Number(data.total || 0), offset);
      document.getElementById('bq-count').textContent =
        Number(data.total || 0) === 0 ? 'Sin resultados'
          : `${data.total} orden${data.total !== 1 ? 'es' : ''} · mostrando ${offset + 1}-${Math.min(offset + BQ_LIMIT, data.total)}`;
    } catch (e) {
      if (e.isAuth) return;
      container.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>Error de conexion</div></div>';
    }
  }

  function bqRenderTabla(ordenes) {
    const container = document.getElementById('bq-table-container');
    if (!ordenes.length) {
      container.innerHTML = '<div class="empty-state" style="min-height:180px;"><div class="icon">📭</div><div>No hay ordenes que coincidan</div></div>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'bq-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Folio</th><th>Paciente</th><th>Estado</th><th>Total</th><th>Saldo</th><th>Sucursal</th><th>Fecha</th></tr>';
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    ordenes.forEach((o) => {
      const tr = document.createElement('tr');
      if (bqOrdenActual && bqOrdenActual.folio === o.folio) tr.classList.add('selected');

      const tdFolio = document.createElement('td');
      tdFolio.style.cssText = "font-family:'DM Mono',monospace;font-size:11px;font-weight:700;";
      tdFolio.textContent = o.folio;

      const tdPac = document.createElement('td');
      tdPac.style.fontWeight = '600';
      tdPac.textContent = o.paciente_nombre;

      const tdEstado = document.createElement('td');
      tdEstado.innerHTML = badgeSafe(o.estado);

      const tdTotal = document.createElement('td');
      tdTotal.textContent = '$' + fmtSafe(o.total);

      const tdSaldo = document.createElement('td');
      tdSaldo.textContent = '$' + fmtSafe(o.saldo);
      if (Number(o.saldo || 0) > 0) tdSaldo.style.color = 'var(--red)';

      const tdSuc = document.createElement('td');
      tdSuc.style.cssText = 'font-size:11px;color:var(--muted);';
      tdSuc.textContent = o.sucursal;

      const tdFecha = document.createElement('td');
      tdFecha.style.cssText = 'font-size:11px;color:var(--muted);';
      tdFecha.textContent = fmtDateSafe(o.fecha);

      tr.append(tdFolio, tdPac, tdEstado, tdTotal, tdSaldo, tdSuc, tdFecha);
      tr.addEventListener('click', () => bqAbrirDetalle(o.folio));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);
  }

  function bqRenderPaginacion(total, offset) {
    const pag = document.getElementById('bq-pagination');
    pag.innerHTML = '';
    if (total <= BQ_LIMIT) return;

    const totalPages = Math.ceil(total / BQ_LIMIT);
    const currentPage = Math.floor(offset / BQ_LIMIT);

    const prev = document.createElement('button');
    prev.className = 'bq-page-btn';
    prev.textContent = '<';
    prev.disabled = currentPage === 0;
    prev.onclick = () => bqBuscar((currentPage - 1) * BQ_LIMIT);
    pag.appendChild(prev);

    const start = Math.max(0, currentPage - 2);
    const end = Math.min(totalPages - 1, start + 4);
    for (let i = start; i <= end; i += 1) {
      const btn = document.createElement('button');
      btn.className = 'bq-page-btn' + (i === currentPage ? ' active' : '');
      btn.textContent = i + 1;
      btn.onclick = () => bqBuscar(i * BQ_LIMIT);
      pag.appendChild(btn);
    }

    const next = document.createElement('button');
    next.className = 'bq-page-btn';
    next.textContent = '>';
    next.disabled = currentPage >= totalPages - 1;
    next.onclick = () => bqBuscar((currentPage + 1) * BQ_LIMIT);
    pag.appendChild(next);
  }

  async function bqAbrirDetalle(folio) {
    const panel = document.getElementById('bq-detail-panel');
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    document.getElementById('bqd-folio').textContent = folio;
    document.getElementById('bqd-info').innerHTML = '<div class="spinner"></div>';
    document.getElementById('bqd-actions').innerHTML = '';
    document.getElementById('bqd-etiquetas').innerHTML = '';
    document.getElementById('bqd-estudios').innerHTML = '';
    document.getElementById('bqd-pagos').innerHTML = '';

    document.querySelectorAll('.bq-table tbody tr').forEach((tr) => {
      tr.classList.toggle('selected', tr.querySelector('td')?.textContent === folio);
    });

    try {
      const r = await api('/api/orden/' + encodeURIComponent(folio) + '/detalle');
      if (!r.ok) {
        toast('Error al cargar orden', '❌');
        return;
      }
      const { orden, estudios, pagos, etiquetasResumen } = await r.json();
      bqOrdenActual = orden;

      bqRenderInfo(orden);
      bqRenderAcciones(orden, etiquetasResumen);
      bqRenderEtiquetas(etiquetasResumen);
      bqRenderEstudios(estudios || []);
      bqRenderPagos(pagos || []);
      bqRenderCopiables(orden);
    } catch (e) {
      if (e.isAuth) return;
      toast('Error de conexion', '❌');
    }
  }

  function bqRenderInfo(orden) {
    const info = document.getElementById('bqd-info');
    info.innerHTML = '';
    const infoData = [
      ['Paciente', orden.paciente_nombre, false],
      ['Celular', orden.paciente_celular || '-', false],
      ['Sucursal', orden.sucursal, false],
      ['Medico', orden.medico || '-', false],
      ['Estado', null, false],
      ['Total', '$' + fmtSafe(orden.total), false],
      ['Pagado', '$' + fmtSafe(orden.pagado), false],
      ['Saldo', '$' + fmtSafe(orden.saldo), Number(orden.saldo || 0) > 0],
      ['Fecha', fmtDateSafe(orden.fecha), false],
    ];
    infoData.forEach(([label, val, isRed]) => {
      const div = document.createElement('div');
      div.className = 'bqd-field';
      const lbl = document.createElement('div');
      lbl.className = 'bqd-label';
      lbl.textContent = label;
      const valEl = document.createElement('div');
      valEl.className = 'bqd-value' + (isRed ? ' red' : '');
      if (label === 'Estado') valEl.innerHTML = badgeSafe(orden.estado);
      else valEl.textContent = val;
      div.append(lbl, valEl);
      info.appendChild(div);
    });
  }

  function makeAction(label, onClick, disabled = false) {
    const btn = document.createElement('button');
    btn.className = 'bq-action-btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function bqRenderAcciones(orden, etiquetasResumen = {}) {
    const actions = document.getElementById('bqd-actions');
    actions.innerHTML = '';
    const labelsCount = Number(etiquetasResumen?.total || 0);

    actions.append(
      makeAction('Imprimir orden', () => bqAbrirOrdenEstudios(orden.folio)),
      makeAction('Reimprimir etiquetas', () => bqReimprimirEtiquetas(orden.folio, etiquetasResumen), labelsCount === 0),
      makeAction('Ir a caja', () => bqIrACaja(orden.folio)),
      makeAction('Copiar folio', () => bqCopiarTexto(orden.folio))
    );
  }

  function bqRenderEtiquetas(summary = {}) {
    const el = document.getElementById('bqd-etiquetas');
    const total = Number(summary?.total || 0);
    if (!total) {
      el.innerHTML = '<div style="color:var(--muted);font-size:12px;">Esta orden no tiene etiquetas generadas.</div>';
      return;
    }

    const tubos = Array.isArray(summary.tubos) ? summary.tubos : [];
    el.innerHTML = `
      <div class="bq-label-summary">
        <div class="bq-label-stats">
          <div class="bq-label-stat"><span>Total</span><strong>${esc(total)}</strong></div>
          <div class="bq-label-stat"><span>Impresas</span><strong>${esc(summary.impresas || 0)}</strong></div>
          <div class="bq-label-stat"><span>Reimpresiones</span><strong>${esc(summary.reimpresiones || 0)}</strong></div>
          <div class="bq-label-stat"><span>Ultima</span><strong>${esc(summary.ultima_impresion ? fmtDateSafe(summary.ultima_impresion) : '-')}</strong></div>
        </div>
        <div class="bq-tube-list">
          ${tubos.map((item) => {
            const tubo = [item.tipo_tubo, item.color_tapa].filter(Boolean).join(' / ') || 'Tubo sin definir';
            const indice = Number(item.total_tubos_grupo || 1) > 1
              ? `Tubo ${item.indice_tubo || 1}/${item.total_tubos_grupo || 1}`
              : '1 tubo';
            const meta = [item.tipo_muestra, item.area_proceso, item.estudios_resumen].filter(Boolean).join(' · ');
            return `
              <div class="bq-tube-item">
                <div class="bq-tube-main"><span>${esc(tubo)}</span><span>${esc(indice)}</span></div>
                <div class="bq-tube-meta">${esc(meta || 'Sin detalle')}</div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function bqRenderEstudios(estudios) {
    const estudiosEl = document.getElementById('bqd-estudios');
    estudiosEl.innerHTML = '';
    if (!estudios.length) {
      estudiosEl.innerHTML = '<div style="color:var(--muted);font-size:12px;">Sin estudios</div>';
      return;
    }
    estudios.forEach((e) => {
      const row = document.createElement('div');
      row.className = 'bqd-estudio-row';
      const name = document.createElement('span');
      name.textContent = e.nombre;
      const price = document.createElement('span');
      price.style.fontWeight = '700';
      price.textContent = '$' + fmtSafe(e.precio);
      row.append(name, price);
      estudiosEl.appendChild(row);
    });
  }

  function bqRenderPagos(pagos) {
    const pagosEl = document.getElementById('bqd-pagos');
    pagosEl.innerHTML = '';
    if (!pagos.length) {
      pagosEl.innerHTML = '<div style="color:var(--muted);font-size:12px;">Sin pagos registrados</div>';
      return;
    }
    pagos.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'bqd-pago-row';
      const left = document.createElement('div');
      const monto = document.createElement('div');
      monto.style.fontWeight = '700';
      monto.textContent = '$' + fmtSafe(p.monto);
      const meta = document.createElement('div');
      meta.className = 'bqd-pago-meta';
      meta.textContent = `${p.metodo} · ${p.cajero} · ${fmtDateSafe(p.fecha)}`;
      left.append(monto, meta);
      if (p.referencia) {
        const ref = document.createElement('div');
        ref.className = 'bqd-pago-meta';
        ref.textContent = 'Ref: ' + p.referencia;
        left.appendChild(ref);
      }
      row.appendChild(left);
      pagosEl.appendChild(row);
    });
  }

  function bqRenderCopiables(orden) {
    const copyBtns = document.getElementById('bqd-copy-btns');
    copyBtns.innerHTML = '';
    const copiables = [
      ['Folio', orden.folio],
      ['Paciente', orden.paciente_nombre],
      ['Celular', orden.paciente_celular || ''],
      ['Total', '$' + fmtSafe(orden.total)],
      ['Saldo', '$' + fmtSafe(orden.saldo)],
    ].filter(([_, v]) => v && v !== '' && v !== '$0.00');

    copiables.forEach(([label, val]) => {
      const btn = document.createElement('button');
      btn.className = 'bq-copy-btn';
      btn.textContent = label;
      btn.onclick = () => bqCopiarTexto(val, btn, label);
      copyBtns.appendChild(btn);
    });
  }

  function bqCopiarTexto(value, btn = null, label = '') {
    navigator.clipboard.writeText(value).then(() => {
      if (!btn) {
        toast('Copiado', '📋');
        return;
      }
      btn.classList.add('copied');
      btn.textContent = 'Copiado';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = label;
      }, 1800);
    });
  }

  function bqAbrirOrdenEstudios(folio) {
    if (typeof goTo === 'function') goTo('proforma');
    setTimeout(() => {
      const input = document.getElementById('pf-folio');
      if (input) input.value = folio;
      if (typeof pfGenerar === 'function') pfGenerar();
    }, 80);
  }

  function bqIrACaja(folio) {
    if (typeof goTo === 'function') goTo('caja');
    setTimeout(() => {
      const input = document.querySelector('#view-caja #folio-input');
      if (input) input.value = folio;
    }, 200);
  }

  async function registrarImpresionEtiquetas(folio) {
    const r = await api(`/api/orden/${encodeURIComponent(folio)}/etiquetas/registrar-impresion`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!r.ok) throw new Error('No se pudo registrar la impresion');
  }

  function buildLabelSheetHtml({ orden, etiquetas, empresa }) {
    const empresaNombre = esc(empresa?.nombre || 'LABORATORIO');
    const paciente = esc(orden?.paciente_nombre || 'Paciente sin nombre');
    const folio = esc(orden?.folio || '');
    const fechaNacimiento = formatBirthDate(orden?.paciente_fecha_nacimiento);
    const sexoPaciente = esc(sexoPacienteLabel(orden?.paciente_sexo));
    const fechaHoraEtiqueta = esc(formatLabelDate(orden?.fecha));

    return etiquetas.map((item) => {
      const tituloTubo = [item.tipo_tubo, item.color_tapa].filter(Boolean).map(esc).join(' / ') || 'Tubo sin definir';
      const muestra = esc(item.tipo_muestra || 'Muestra no especificada');
      const area = esc(item.area_proceso || 'Sin area');
      const estudios = esc(item.estudios_resumen || 'Sin estudios asociados');
      const indice = Number(item.total_tubos_grupo || 1) > 1
        ? `<div class="lb-chip">Tubo ${esc(item.indice_tubo || 1)}/${esc(item.total_tubos_grupo || 1)}</div>`
        : '<div class="lb-chip">1 tubo</div>';

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
        </div>`;
    }).join('');
  }

  function labelPrintStyles() {
    return `
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
        .lb-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.8mm; }
        .lb-top-main { display: flex; flex-direction: column; gap: 0.2mm; min-width: 0; max-width: 28mm; }
        .lb-company { font-size: 5.8pt; font-weight: 800; line-height: 1.05; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lb-chip { border: 1px solid #000; border-radius: 999px; padding: 0.45mm 1mm; font-size: 4.9pt; font-weight: 700; white-space: nowrap; }
        .lb-patient { font-size: 5pt; font-weight: 700; line-height: 1.05; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lb-meta-row { display: flex; justify-content: space-between; gap: 0.5mm; margin-top: 0.15mm; }
        .lb-meta { font-size: 4.45pt; line-height: 1.05; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 0; }
        .lb-folio { flex-basis: 100%; font-size: 4.6pt; font-weight: 800; overflow: visible; text-overflow: clip; }
        .lb-meta-row-full { display: block; }
        .lb-meta-full { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lb-meta-time { flex: 0 0 auto; max-width: 11.2mm; text-align: right; }
        .lb-box { border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 0.35mm 0; margin-top: 0.25mm; }
        .lb-title { font-size: 5.6pt; font-weight: 800; line-height: 1.02; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .lb-sub { font-size: 4.55pt; line-height: 1.02; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lb-studies { font-size: 4.25pt; line-height: 1.02; margin-top: 0.25mm; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
      </style>`;
  }

  async function bqReimprimirEtiquetas(folio, summary = {}) {
    const total = Number(summary?.total || 0);
    if (!total) {
      toast('Esta orden no tiene etiquetas', 'AVISO');
      return;
    }

    const ultima = summary.ultima_impresion ? fmtDateSafe(summary.ultima_impresion) : 'sin impresion previa';
    const reimp = Number(summary.reimpresiones || 0);
    const ok = confirm(`Se reimprimiran ${total} etiqueta(s) para ${folio}.\nUltima impresion: ${ultima}.\nReimpresiones registradas: ${reimp}.\n\nContinuar?`);
    if (!ok) return;

    try {
      const res = await api(`/api/orden/${encodeURIComponent(folio)}/etiquetas`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'No se pudieron cargar las etiquetas');
      }

      const payload = await res.json();
      if (!Array.isArray(payload.etiquetas) || payload.etiquetas.length === 0) {
        toast('La orden no tiene etiquetas para imprimir', 'AVISO');
        return;
      }

      const printWindow = window.open('', '_blank', 'width=520,height=760');
      if (!printWindow) throw new Error('El navegador bloqueo la ventana de impresion');

      const html = buildLabelSheetHtml(payload);
      printWindow.document.open();
      printWindow.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas ${esc(folio)}</title>${labelPrintStyles()}</head><body>${html}</body></html>`);
      printWindow.document.close();
      printWindow.focus();

      const finish = async () => {
        try {
          await registrarImpresionEtiquetas(folio);
          await bqAbrirDetalle(folio);
        } catch (err) {
          console.error('registrarImpresionEtiquetas:', err);
        } finally {
          printWindow.close();
        }
      };

      printWindow.addEventListener('afterprint', finish, { once: true });
      setTimeout(() => printWindow.print(), 120);
    } catch (err) {
      console.error('bqReimprimirEtiquetas:', err);
      toast(err.message || 'No se pudieron imprimir las etiquetas', '❌');
    }
  }

  function bqCerrarDetalle() {
    document.getElementById('bq-detail-panel').style.display = 'none';
    bqOrdenActual = null;
    document.querySelectorAll('.bq-table tbody tr').forEach((tr) => tr.classList.remove('selected'));
  }

  function bqPreFill(folio) {
    document.getElementById('bq-q').value = folio;
    bqBuscar(0);
  }

  document.getElementById('bq-q').addEventListener('input', () => {
    clearTimeout(bqSearchTimer);
    bqSearchTimer = setTimeout(() => bqBuscar(0), 350);
  });

  ['bq-estado', 'bq-sucursal', 'bq-desde', 'bq-hasta'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => bqBuscar(0));
  });

  document.getElementById('bq-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') bqBuscar(0);
  });

  window.bqIniciarVista = bqIniciarVista;
  window.bqPreFill = bqPreFill;
  window.bqBuscar = bqBuscar;
  window.bqLimpiar = bqLimpiar;
  window.bqCerrarDetalle = bqCerrarDetalle;
})();
