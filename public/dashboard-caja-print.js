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

  }); // fin DOMContentLoaded

