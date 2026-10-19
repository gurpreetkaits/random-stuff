// WebSocket connection to the race server (server/server.js).

export class Net {
  constructor(onMessage, onStatus) {
    this.ws = null;
    this.id = null;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
  }

  // The race server also serves the game, so it lives on the page's own host.
  static available() { return location.protocol === 'http:' || location.protocol === 'https:'; }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return this.ready;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    this.ready = new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(url);
      ws.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'hello') { this.id = m.id; resolve(); return; }
        this.onMessage(m);
      };
      ws.onerror = () => reject(new Error('Could not reach the race server.'));
      ws.onclose = () => { this.ws = null; this.id = null; this.onStatus('closed'); };
    });
    return this.ready;
  }

  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  close() { if (this.ws) this.ws.close(); }
}
