// WebSocket client wrapper with auto-reconnect. Emits parsed messages via a
// simple callback registry.
export class WsClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.sessionId = null;
    this._queue = [];
    this._connect();
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      this.dispatchEvent(new Event('open'));
      if (this.sessionId) this.subscribe(this.sessionId);
      this._queue.forEach((m) => this.ws.send(m));
      this._queue = [];
    };
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      } catch {
        /* ignore */
      }
    };
    this.ws.onclose = () => {
      this.dispatchEvent(new Event('close'));
      setTimeout(() => this._connect(), 1500);
    };
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else this._queue.push(data);
  }

  subscribe(sessionId) {
    this.sessionId = sessionId;
    this.send({ type: 'subscribe', sessionId });
  }

  telemetry(sessionId, userId, reading) {
    // Raw readings are only useful live: drop them rather than queue while offline.
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'telemetry', sessionId, userId, ...reading });
  }

  devices(sessionId, userId, devices) {
    this.send({ type: 'devices', sessionId, userId, devices });
  }
}
