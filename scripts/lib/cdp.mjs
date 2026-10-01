/** Minimal Chrome DevTools Protocol client for loopback Obsidian pages (tooling only, Node 22 global WebSocket). */
export class CDP {
  constructor(url, timeoutMs = 15000) {
    this.url = url; this.timeoutMs = timeoutMs; this.nextId = 0; this.pending = new Map(); this.errors = [];
  }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.text);
      if (!message.id) return;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed.')), { once: true });
    });
    await this.send('Runtime.enable'); await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`CDP ${method} timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async value(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return JSON.parse(response.result.value);
  }
  async pressEscape() {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  close() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.socket?.close();
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
