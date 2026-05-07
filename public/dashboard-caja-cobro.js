       BUSCAR ORDEN PARA COBRAR
    ═══════════════════════════════════════════════════════════════ */
    let ordenActual    = null;
    let metodoPago     = 'efectivo';
    let splitPagos     = [];   // Pagos mixtos acumulados (sólo en frontend, aún no enviados)
    let _historialData = null;
    let _cortesData    = null;

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
