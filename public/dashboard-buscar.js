(function () {
  'use strict';

  let bqOrdenActual = null;
  let bqOffset = 0;
  const BQ_LIMIT = 20;
  let bqTotalResultados = 0;
  let bqSearchTimer = null;
  let bqInicializado = false;

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
    document.getElementById('bq-count').textContent = '—';
    document.getElementById('bq-pagination').innerHTML = '';
    document.getElementById('bq-table-container').innerHTML = `
      <div class="empty-state" style="min-height:220px;">
        <div class="icon">🔍</div><div>Usa los filtros para buscar órdenes</div>
      </div>`;
    bqCerrarDetalle();
    bqOrdenActual = null;
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
    document.getElementById('bq-count').textContent = '…';
    try {
      const r = await api(`/api/ordenes/buscar?${qs.toString()}`);
      if (!r.ok) {
        container.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>Error al buscar</div></div>';
        return;
      }
      const data = await r.json();
      bqTotalResultados = data.total;
      bqRenderTabla(data.ordenes);
      bqRenderPaginacion(data.total, offset);
      document.getElementById('bq-count').textContent =
        data.total === 0 ? 'Sin resultados'
          : `${data.total} orden${data.total !== 1 ? 'es' : ''} · mostrando ${offset + 1}–${Math.min(offset + BQ_LIMIT, data.total)}`;
    } catch (e) {
      if (e.isAuth) return;
      container.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>Error de conexión</div></div>';
    }
  }

  function bqRenderTabla(ordenes) {
    const container = document.getElementById('bq-table-container');
    if (!ordenes.length) {
      container.innerHTML = '<div class="empty-state" style="min-height:180px;"><div class="icon">📭</div><div>No hay órdenes que coincidan</div></div>';
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
      tdEstado.innerHTML = badge(o.estado);

      const tdTotal = document.createElement('td');
      tdTotal.textContent = '$' + fmt(o.total);

      const tdSaldo = document.createElement('td');
      tdSaldo.textContent = '$' + fmt(o.saldo);
      if (o.saldo > 0) tdSaldo.style.color = 'var(--red)';

      const tdSuc = document.createElement('td');
      tdSuc.style.cssText = 'font-size:11px;color:var(--muted);';
      tdSuc.textContent = o.sucursal;

      const tdFecha = document.createElement('td');
      tdFecha.style.cssText = 'font-size:11px;color:var(--muted);';
      tdFecha.textContent = fmtDate(o.fecha);

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
    prev.textContent = '‹';
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
    next.textContent = '›';
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
    document.getElementById('bqd-estudios').innerHTML = '';
    document.getElementById('bqd-pagos').innerHTML = '';

    document.querySelectorAll('.bq-table tbody tr').forEach((tr) => {
      tr.classList.toggle('selected', tr.querySelector('td')?.textContent === folio);
    });

    try {
      const r = await api('/api/caja/orden/' + encodeURIComponent(folio));
      if (!r.ok) {
        toast('Error al cargar orden', '❌');
        return;
      }
      const { orden, estudios, pagos } = await r.json();
      bqOrdenActual = orden;

      const info = document.getElementById('bqd-info');
      info.innerHTML = '';
      const infoData = [
        ['Paciente', orden.paciente_nombre, false],
        ['Celular', orden.paciente_celular || '—', false],
        ['Sucursal', orden.sucursal, false],
        ['Médico', orden.medico || '—', false],
        ['Estado', null, false],
        ['Total', '$' + fmt(orden.total), false],
        ['Pagado', '$' + fmt(orden.pagado), false],
        ['Saldo', '$' + fmt(orden.saldo), orden.saldo > 0],
        ['Fecha', fmtDate(orden.fecha), false],
      ];
      infoData.forEach(([label, val, isRed]) => {
        const div = document.createElement('div');
        div.className = 'bqd-field';
        const lbl = document.createElement('div');
        lbl.className = 'bqd-label';
        lbl.textContent = label;
        const valEl = document.createElement('div');
        valEl.className = 'bqd-value' + (isRed ? ' red' : '');
        if (label === 'Estado') valEl.innerHTML = badge(orden.estado);
        else valEl.textContent = val;
        div.append(lbl, valEl);
        info.appendChild(div);
      });

      document.getElementById('bqd-estado-sel').value = orden.estado;

      const estudiosEl = document.getElementById('bqd-estudios');
      estudiosEl.innerHTML = '';
      if (!estudios.length) {
        estudiosEl.innerHTML = '<div style="color:var(--muted);font-size:12px;">Sin estudios</div>';
      } else {
        estudios.forEach((e) => {
          const row = document.createElement('div');
          row.className = 'bqd-estudio-row';
          const name = document.createElement('span');
          name.textContent = e.nombre;
          const price = document.createElement('span');
          price.style.fontWeight = '700';
          price.textContent = '$' + fmt(e.precio);
          row.append(name, price);
          estudiosEl.appendChild(row);
        });
      }

      const pagosEl = document.getElementById('bqd-pagos');
      pagosEl.innerHTML = '';
      if (!pagos.length) {
        pagosEl.innerHTML = '<div style="color:var(--muted);font-size:12px;">Sin pagos registrados</div>';
      } else {
        pagos.forEach((p) => {
          const row = document.createElement('div');
          row.className = 'bqd-pago-row';
          const left = document.createElement('div');
          const monto = document.createElement('div');
          monto.style.fontWeight = '700';
          monto.textContent = '$' + fmt(p.monto);
          const meta = document.createElement('div');
          meta.className = 'bqd-pago-meta';
          meta.textContent = `${p.metodo} · ${p.cajero} · ${fmtDate(p.fecha)}`;
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

      const copyBtns = document.getElementById('bqd-copy-btns');
      copyBtns.innerHTML = '';
      const copiables = [
        ['📋 Folio', orden.folio],
        ['👤 Paciente', orden.paciente_nombre],
        ['📱 Celular', orden.paciente_celular || ''],
        ['💵 Total', '$' + fmt(orden.total)],
        ['💸 Saldo', '$' + fmt(orden.saldo)],
      ].filter(([_, v]) => v && v !== '' && v !== '$0.00');
      copiables.forEach(([label, val]) => {
        const btn = document.createElement('button');
        btn.className = 'bq-copy-btn';
        btn.textContent = label;
        btn.onclick = () => {
          navigator.clipboard.writeText(val).then(() => {
            btn.classList.add('copied');
            btn.textContent = '✔ Copiado';
            setTimeout(() => {
              btn.classList.remove('copied');
              btn.textContent = label;
            }, 1800);
          });
        };
        copyBtns.appendChild(btn);
      });
    } catch (e) {
      if (e.isAuth) return;
      toast('Error de conexión', '❌');
    }
  }

  function bqCerrarDetalle() {
    document.getElementById('bq-detail-panel').style.display = 'none';
    bqOrdenActual = null;
    document.querySelectorAll('.bq-table tbody tr').forEach((tr) => tr.classList.remove('selected'));
  }

  async function bqCambiarEstado() {
    if (!bqOrdenActual) return;
    const estado = document.getElementById('bqd-estado-sel').value;
    try {
      const r = await api(`/api/orden/${encodeURIComponent(bqOrdenActual.folio)}/estado`, {
        method: 'PATCH',
        body: JSON.stringify({ estado })
      });
      if (!r.ok) {
        const d = await r.json();
        toast(d.error || 'Error', '❌');
        return;
      }
      toast('Estado actualizado', '✔');
      _dashCache = null;
      await bqAbrirDetalle(bqOrdenActual.folio);
      bqBuscar(bqOffset);
    } catch (e) {
      if (e.isAuth) return;
      toast('Error de conexión', '❌');
    }
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
  window.bqCambiarEstado = bqCambiarEstado;
})();
