// Keeps a playback session alive and closes it when playback is torn down.
export class Heartbeat {
  constructor(session, snapshot, onExpired) {
    this.session = session;
    this.snapshot = snapshot;
    this.onExpired = onExpired;
    this.timer = setInterval(() => this.beat(), session.heartbeatIntervalMs || 20000);
  }

  async beat() {
    try {
      const r = await fetch('/api/playback/heartbeat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.session.sessionId, ...this.snapshot() }),
      });
      if (r.status === 404) { this.stop(); this.onExpired?.(); }
    } catch { /* transient network failure: next beat retries */ }
  }

  stop(close = false) {
    clearInterval(this.timer);
    if (close) {
      fetch('/api/playback/heartbeat', {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.session.sessionId, state: 'closed' }),
      }).catch(() => {});
    }
  }
}
