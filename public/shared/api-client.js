(function () {
  'use strict';

  function getToken() {
    return sessionStorage.getItem('token') || '';
  }

  function logout() {
    sessionStorage.clear();
    window.location.replace('/index.html');
  }

  async function parseError(res) {
    try {
      const data = await res.json();
      return data?.error || `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  }

  async function apiFetch(url, options = {}) {
    const token = getToken();
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(url, { ...options, headers });
    if (res.status === 401 || res.status === 403) {
      logout();
      throw Object.assign(new Error('auth'), { isAuth: true, response: res });
    }
    return res;
  }

  async function apiJson(url, options = {}) {
    const res = await apiFetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { response: res, data });
    return data;
  }

  async function apiBlobUrl(url, options = {}) {
    const res = await apiFetch(url, options);
    if (!res.ok) throw new Error(await parseError(res));
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  window.LabApi = {
    apiFetch,
    apiJson,
    apiBlobUrl,
    logout,
    getToken,
  };
})();
