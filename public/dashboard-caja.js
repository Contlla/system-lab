(function () {
  'use strict';

  const CJ_HOST_ID = 'cj-host';
  const CJ_STYLE_ID = 'cj-dashboard-host-style';
  const CJ_CHART_SRC = '/chart.umd.min.js';
  const CJ_TEMPLATE_SRC = '/dashboard-caja-template.html';
  const CJ_CSS_SRC = '/dashboard-caja.css';
  const CJ_BUNDLE_SRC = '/dashboard-caja-bundle.js?v=discount-flow-20260506';

  let cjBootstrapped = false;
  let cjLoadingPromise = null;
  let cjRoot = null;
  let cjSesionActiva = null;
  let cjSessionWatchInstalled = false;
  let cjAssetsPromise = null;

  function cjEnsureHostStyles() {
    if (document.getElementById(CJ_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = CJ_STYLE_ID;
    style.textContent = `
      #${CJ_HOST_ID} { position: relative; }
    `;
    document.head.appendChild(style);
  }

  async function cjEnsureChart() {
    if (window.Chart) return true;
    try {
      await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${CJ_CHART_SRC}"]`);
      if (existing) {
        if (window.Chart) {
          resolve();
          return;
        }
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = CJ_CHART_SRC;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
      });
      return !!window.Chart;
    } catch (error) {
      console.warn('cjEnsureChart:', error);
      return false;
    }
  }

  async function cjFetchText(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`No se pudo cargar ${url} (${response.status})`);
    return response.text();
  }

  async function cjLoadAssets() {
    if (!cjAssetsPromise) {
      cjAssetsPromise = Promise.all([
        cjFetchText(CJ_TEMPLATE_SRC),
        cjFetchText(CJ_CSS_SRC),
      ]).then(([template, css]) => ({ template, css }));
    }
    return cjAssetsPromise;
  }

  function cjGetToken() {
    return sessionStorage.getItem('token') || localStorage.getItem('token') || '';
  }

  async function cjCajaApi(path, options = {}) {
    const token = cjGetToken();
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(path, {
      ...options,
      headers,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {}
    return { response, data };
  }

  async function cjFetchSesionActiva() {
    const { response, data } = await cjCajaApi('/api/caja/sesion-activa');
    if (!response.ok) {
      throw new Error(data?.error || `No se pudo consultar la sesion (${response.status})`);
    }
    cjSesionActiva = data?.sesion || null;
    return cjSesionActiva;
  }

  async function cjAbrirSesionCaja() {
    const { response, data } = await cjCajaApi('/api/caja/sesion/abrir', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error(data?.error || `No se pudo abrir caja (${response.status})`);
    }
    cjSesionActiva = data?.sesion || null;
    return cjSesionActiva;
  }

  function cjInstallSessionWatch() {
    if (cjSessionWatchInstalled) return;
    cjSessionWatchInstalled = true;

    const refresh = async () => {
      if (!cjRoot) return;
      const view = document.getElementById('view-caja');
      if (view && view.style.display === 'none') return;
      try {
        await cjInstallGate(cjRoot);
      } catch (error) {
        console.warn('cjInstallSessionWatch:', error);
      }
    };

    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
    });
  }

  function cjGateMarkup() {
    return `
      <style>
        #cj-gate-shell {
          position: absolute;
          inset: 0;
          z-index: 9999;
          display: block;
        }
        .cj-gate {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(255,255,255,0.9);
          backdrop-filter: blur(4px);
        }
        .cj-gate-card {
          width: min(480px, 100%);
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          box-shadow: 0 18px 45px rgba(15,23,42,0.16);
          padding: 24px;
          text-align: center;
          font-family: 'Plus Jakarta Sans', sans-serif;
          color: #1a202c;
        }
        .cj-gate-icon {
          font-size: 42px;
          line-height: 1;
          margin-bottom: 10px;
        }
        .cj-gate-title {
          font-size: 18px;
          font-weight: 800;
          margin-bottom: 8px;
        }
        .cj-gate-copy {
          font-size: 13px;
          color: #718096;
          line-height: 1.55;
          margin-bottom: 18px;
        }
        .cj-gate-meta {
          font-size: 12px;
          color: #4b5563;
          margin: -4px 0 12px;
          font-family: 'DM Mono', monospace;
        }
        .cj-gate-btn {
          border: 0;
          border-radius: 999px;
          padding: 11px 16px;
          font: inherit;
          font-weight: 700;
          background: linear-gradient(135deg, #22c55e, #16a34a);
          color: white;
          cursor: pointer;
          box-shadow: 0 10px 24px rgba(34,197,94,0.22);
        }
      </style>
      <div class="cj-gate" id="cj-gate">
        <div class="cj-gate-card">
          <div class="cj-gate-icon">$</div>
          <div class="cj-gate-title">Caja cerrada</div>
          <div class="cj-gate-copy">Antes de cobrar o generar cortes, abre manualmente la caja del dia. Esto bloquea acciones operativas y evita descuadres entre turnos.</div>
          <div class="cj-gate-meta" id="cj-gate-meta">Sesion no iniciada</div>
          <button type="button" class="cj-gate-btn" id="cj-open-day-btn">Abrir caja del dia</button>
        </div>
      </div>
    `;
  }

  async function cjInstallGate(root) {
    const wrapper = root.querySelector('#cj-wrapper');
    if (!wrapper) return;

    const existing = root.querySelector('#cj-gate-shell');
    if (existing) existing.remove();

    const shell = document.createElement('div');
    shell.id = 'cj-gate-shell';
    shell.innerHTML = cjGateMarkup();
    wrapper.appendChild(shell);

    let sesionActiva = null;
    try {
      sesionActiva = await cjFetchSesionActiva();
    } catch (error) {
      console.warn('cjInstallGate: sesion-activa', error);
      const meta = shell.querySelector('#cj-gate-meta');
      if (meta) meta.textContent = String(error.message || error);
    }

    if (sesionActiva) {
      shell.style.display = 'none';
      return;
    }

    const gate = root.querySelector('#cj-gate');
    const card = shell.querySelector('.cj-gate-card');
    const openBtn = root.querySelector('#cj-open-day-btn');
    const meta = root.querySelector('#cj-gate-meta');

    if (meta) meta.textContent = 'Sesion pendiente de apertura';

    if (gate) {
      gate.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    if (card) {
      card.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    }

    if (openBtn) {
      openBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        openBtn.disabled = true;
        if (meta) meta.textContent = 'Abriendo sesion...';
        try {
          const sesion = await cjAbrirSesionCaja();
          shell.style.display = 'none';
          toast(`Caja abierta: sesion #${sesion?.id || ''}`, 'OK');
        } catch (error) {
          if (meta) meta.textContent = String(error.message || error);
          toast(String(error.message || 'No se pudo abrir caja'), 'ERROR');
        } finally {
          openBtn.disabled = false;
        }
      });
    }
  }

  async function cjLoadCajaBundle() {
    const existing = document.querySelector(`script[src="${CJ_BUNDLE_SRC}"]`);
    if (existing) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CJ_BUNDLE_SRC;
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    });
  }

  function cjExtractAtRule(css, atRuleName, predicate = () => true) {
    const blocks = [];
    let output = '';
    let cursor = 0;

    while (cursor < css.length) {
      const atIndex = css.indexOf(atRuleName, cursor);
      if (atIndex === -1) {
        output += css.slice(cursor);
        break;
      }

      const openIndex = css.indexOf('{', atIndex);
      if (openIndex === -1) {
        output += css.slice(cursor);
        break;
      }

      const prelude = css.slice(atIndex, openIndex).trim();
      let depth = 1;
      let index = openIndex + 1;
      while (index < css.length && depth > 0) {
        if (css[index] === '{') depth += 1;
        if (css[index] === '}') depth -= 1;
        index += 1;
      }

      if (predicate(prelude)) {
        output += css.slice(cursor, atIndex);
        blocks.push(css.slice(atIndex, index));
      } else {
        output += css.slice(cursor, index);
      }

      cursor = index;
    }

    return { css: output, blocks };
  }

  function cjPrefixSelector(selector) {
    const trimmed = selector.trim();
    if (!trimmed) return trimmed;
    if (trimmed === ':root' || trimmed === 'body') return '#cj-wrapper';
    if (trimmed === 'html' || trimmed === 'html body') return '#cj-wrapper';
    if (trimmed === '*') return '#cj-wrapper *';
    if (trimmed === '*::before' || trimmed === '*::after') return `#cj-wrapper ${trimmed}`;
    if (trimmed.startsWith('#cj-wrapper')) return trimmed;
    if (trimmed.startsWith('#ticket-print')) return trimmed;
    if (trimmed.startsWith('@')) return trimmed;
    return `#cj-wrapper ${trimmed}`;
  }

  function cjPrefixCssRules(css) {
    let output = '';
    let cursor = 0;

    while (cursor < css.length) {
      const openIndex = css.indexOf('{', cursor);
      if (openIndex === -1) {
        output += css.slice(cursor);
        break;
      }

      const prelude = css.slice(cursor, openIndex);
      let depth = 1;
      let index = openIndex + 1;
      while (index < css.length && depth > 0) {
        if (css[index] === '{') depth += 1;
        if (css[index] === '}') depth -= 1;
        index += 1;
      }

      const body = css.slice(openIndex + 1, index - 1);
      const trimmedPrelude = prelude.trim();

      if (trimmedPrelude.startsWith('@')) {
        output += `${prelude}{${cjPrefixCssRules(body)}}`;
      } else {
        const prefixedPrelude = prelude
          .split(',')
          .map(cjPrefixSelector)
          .join(', ');
        output += `${prefixedPrelude}{${body}}`;
      }

      cursor = index;
    }

    return output;
  }

  function cjNormalizeShadowCss(css) {
    const pageExtract = cjExtractAtRule(css, '@page');
    const printExtract = cjExtractAtRule(
      pageExtract.css,
      '@media',
      (prelude) => /\bprint\b/i.test(prelude)
    );

    const screenCss = cjPrefixCssRules(printExtract.css);
    const embeddedReset = `
      #cj-wrapper {
        min-height: 0;
        padding: 0;
        background: transparent;
      }
    `;

    return [
      screenCss,
      embeddedReset,
      ...pageExtract.blocks,
      ...printExtract.blocks,
    ].join('\n');
  }

  function cjWrapTemplate(template, css) {
    return `<style>${cjNormalizeShadowCss(css)}</style>${template}`;
  }

  async function cjBootstrap() {
    if (cjBootstrapped) return;
    if (cjLoadingPromise) return cjLoadingPromise;

    cjLoadingPromise = (async () => {
      cjEnsureHostStyles();
      const assets = await cjLoadAssets();
      const chartReady = await cjEnsureChart();

      const host = document.getElementById(CJ_HOST_ID);
      if (!host) throw new Error('No se encontro el host de Caja');

      host.innerHTML = '<div class="cj-loading-shell"><div class="big">Caja</div><div>Cargando modulo de caja...</div></div>';

      host.innerHTML = cjWrapTemplate(assets.template, assets.css);
      cjRoot = host;

      await cjLoadCajaBundle();
      if (!chartReady) {
        const compPanel = host.querySelector('#panel-comparativa');
        if (compPanel) compPanel.style.display = 'none';
      }
      cjInstallSessionWatch();
      await cjInstallGate(host);

      cjBootstrapped = true;
    })().catch((error) => {
      cjLoadingPromise = null;
      const host = document.getElementById(CJ_HOST_ID);
      if (host) {
        host.innerHTML = `
          <div class="cj-error-shell">
            <div class="big">Caja</div>
            <div>No se pudo cargar Caja dentro del dashboard.</div>
            <div style="font-size:13px;color:var(--muted);">${String(error.message || error)}</div>
          </div>
        `;
      }
      throw error;
    });

    return cjLoadingPromise;
  }

  async function cjIniciarVista() {
    try {
      await cjBootstrap();
      if (cjRoot) await cjInstallGate(cjRoot);
    } catch (error) {
      console.error('cjIniciarVista:', error);
      toast('No se pudo iniciar Caja', 'ERROR');
    }
  }

  window.cjIniciarVista = cjIniciarVista;
})();
