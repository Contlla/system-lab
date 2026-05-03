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
