// Thin REST client for the backend API.
const json = (res) => {
  if (!res.ok) return res.json().then((e) => Promise.reject(new Error(e.error || res.statusText)));
  return res.status === 204 ? null : res.json();
};

export const api = {
  // users
  listUsers: () => fetch('/api/users').then(json),
  createUser: (data) => fetch('/api/users', { method: 'POST', headers: h(), body: JSON.stringify(data) }).then(json),
  updateUser: (id, data) => fetch(`/api/users/${id}`, { method: 'PUT', headers: h(), body: JSON.stringify(data) }).then(json),
  deleteUser: (id) => fetch(`/api/users/${id}`, { method: 'DELETE' }).then(json),
  userZones: (id) => fetch(`/api/users/${id}/zones`).then(json),

  // sessions
  protocols: () => fetch('/api/sessions/protocols').then(json),
  listSessions: () => fetch('/api/sessions').then(json),
  getSession: (id) => fetch(`/api/sessions/${id}`).then(json),
  createSession: (data) => fetch('/api/sessions', { method: 'POST', headers: h(), body: JSON.stringify(data) }).then(json),
  joinSession: (id, userId) => fetch(`/api/sessions/${id}/join`, { method: 'POST', headers: h(), body: JSON.stringify({ userId }) }).then(json),
  leaveSession: (id, userId) => fetch(`/api/sessions/${id}/leave`, { method: 'POST', headers: h(), body: JSON.stringify({ userId }) }).then(json),
  startSession: (id) => fetch(`/api/sessions/${id}/start`, { method: 'POST' }).then(json),
  finishSession: (id) => fetch(`/api/sessions/${id}/finish`, { method: 'POST' }).then(json),
  deleteSession: (id) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }).then(json),
  history: () => fetch('/api/sessions/history').then(json),

  // integrations
  integrationStatus: () => fetch('/api/integrations/status').then(json),
};

function h() {
  return { 'Content-Type': 'application/json' };
}
