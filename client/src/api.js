const BASE = '/api/audit-entries';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  list: () => request(''),
  create: (entry) => request('', { method: 'POST', body: entry }),
  update: (id, patch) => request(`/${id}`, { method: 'PUT', body: patch }),
  similar: (id) => request(`/${id}/similar`, { method: 'POST' }),
  retry: (id) => request(`/${id}/retry`, { method: 'POST' }),
  health: () => fetch('/api/health').then((r) => r.json()),
};
