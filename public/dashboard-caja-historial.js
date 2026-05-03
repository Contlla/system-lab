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
