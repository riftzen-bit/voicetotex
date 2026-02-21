/**
 * WebSocket client with auto-reconnect, heartbeat, and event routing.
 * Messages are JSON objects with a `type` field used for dispatch.
 */

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 15000;

export class WebSocketClient {
  /**
   * @param {string} url — e.g. ws://127.0.0.1:9876
   */
  constructor(url, authToken = '') {
    this._url = url;
    this._authToken = authToken;
    this._ws = null;
    this._listeners = new Map(); // type → Set<callback>
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._intentionalClose = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Register a handler for a message type.
   * @param {string} type — message type to listen for
   * @param {Function} callback — receives the parsed message object
   * @returns {Function} unsubscribe function
   */
  on(type, callback) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(callback);

    return () => {
      const set = this._listeners.get(type);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this._listeners.delete(type);
      }
    };
  }

  /**
   * Send a command to the server.
   * Wraps as {type: "command", action: "..."} to match backend protocol.
   * @param {string} action — command action name
   * @param {Object} data — additional payload fields
   */
  send(action, data = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    if (action === 'ping') {
      this._ws.send(JSON.stringify({ type: 'ping' }));
    } else {
      this._ws.send(JSON.stringify({ type: 'command', action, ...data }));
    }
  }

  /** Open the WebSocket connection. */
  connect() {
    this._intentionalClose = false;
    this._openSocket();
  }

  /** Gracefully close and stop reconnecting. */
  disconnect() {
    this._intentionalClose = true;
    this._stopReconnect();
    this._stopHeartbeat();
    if (this._ws) {
      this._ws.close(1000);
      this._ws = null;
    }
  }

  /** @returns {boolean} */
  get isConnected() {
    return this._ws !== null && this._ws.readyState === WebSocket.OPEN;
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  _openSocket() {
    try {
      this._ws = new WebSocket(this._url);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      this._reconnectDelay = RECONNECT_BASE_MS; // reset backoff
      if (this._authToken) {
        this._ws.send(JSON.stringify({ type: 'auth', token: this._authToken }));
      }
      this._startHeartbeat();
      this._emit('open', {});
    };

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type) {
          this._emit(msg.type, msg);
        }
      } catch {
        // Ignore non-JSON messages
      }
    };

    this._ws.onclose = () => {
      this._stopHeartbeat();
      this._emit('close', {});
      if (!this._intentionalClose) {
        this._scheduleReconnect();
      }
    };

    this._ws.onerror = () => {
      // onerror is always followed by onclose — no extra handling needed
    };
  }

  /**
   * Dispatch a message to all registered handlers for its type.
   * @param {string} type
   * @param {Object} msg
   */
  _emit(type, msg) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(msg);
      } catch {
        // Don't let one bad handler break others
      }
    }
  }

  _scheduleReconnect() {
    this._stopReconnect();
    this._reconnectTimer = setTimeout(() => {
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
      this._openSocket();
    }, this._reconnectDelay);
  }

  _stopReconnect() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this.send('ping');
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }
}
