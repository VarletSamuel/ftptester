// Thin REST client for the backend API.
const json = (res) => {
  if (!res.ok) return res.json().then((e) => Promise.reject(new Error(e.error || res.statusText)));
  return res.status === 204 ? null : res.json();
};

const send = (method, url, body) =>
  fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(json);

export const api = {
  settings: () => fetch('/api/settings').then(json),

  // users
  listUsers: () => fetch('/api/users').then(json),
  createUser: (data) => send('POST', '/api/users', data),
  updateUser: (id, data) => send('PUT', `/api/users/${id}`, data),
  deleteUser: (id) => send('DELETE', `/api/users/${id}`),

  // sessions
  listSessions: () => fetch('/api/sessions').then(json),
  getSession: (id) => fetch(`/api/sessions/${id}`).then(json),
  createSession: (data) => send('POST', '/api/sessions', data),
  joinSession: (id, userId) => send('POST', `/api/sessions/${id}/join`, { userId }),
  leaveSession: (id, userId) => send('POST', `/api/sessions/${id}/leave`, { userId }),
  startSession: (id, body = {}) => send('POST', `/api/sessions/${id}/start`, body),
  finishSession: (id) => send('POST', `/api/sessions/${id}/finish`, {}),
  deleteSession: (id) => send('DELETE', `/api/sessions/${id}`),
  startRider: (id, userId, delaySeconds = 0) => send('POST', `/api/sessions/${id}/riders/${userId}/start`, { delaySeconds }),
  stopRider: (id, userId) => send('POST', `/api/sessions/${id}/riders/${userId}/stop`, {}),
  setControl: (id, userId, control) => send('PUT', `/api/sessions/${id}/riders/${userId}/control`, control),

  // stored tests
  tests: () => fetch('/api/tests').then(json),
  test: (id) => fetch(`/api/tests/${id}`).then(json),
  deleteTest: (id) => send('DELETE', `/api/tests/${id}`),
  exportUrl: (id, file) => `/api/tests/${id}/export/${file}`,
  excelUrl: (id) => `/api/tests/${id}/export.xlsx`,

  // integrations
  integrationStatus: () => fetch('/api/integrations/status').then(json),
};
