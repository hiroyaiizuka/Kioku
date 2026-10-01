// Minimal loopback CDP protocol simulation (HTTP /json/list + WebSocket). Never a browser, never native evidence.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

function frame(text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >>> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}

/**
 * `pages`: [{ path, title }]. `respond(path, message)` returns the CDP `result` object for a request
 * (undefined → `{}`). Returns { port, close, url(path) }.
 */
export async function startCdpServer(pages, respond) {
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(pages.map((page) => ({ type: 'page', title: page.title,
      webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${page.path}` }))));
  });
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on('data', (part) => {
      buffered = Buffer.concat([buffered, part]);
      while (buffered.length >= 6) {
        const opcode = buffered[0] & 15; let length = buffered[1] & 127; let position = 2;
        if (length === 126) { if (buffered.length < 8) return; length = buffered.readUInt16BE(2); position = 4; }
        if (buffered.length < position + 4 + length) return;
        const mask = buffered.subarray(position, position + 4); position += 4;
        const data = Buffer.from(buffered.subarray(position, position + length)); buffered = buffered.subarray(position + length);
        for (let index = 0; index < data.length; index += 1) data[index] ^= mask[index % 4];
        if (opcode === 8) { socket.end(); continue; }
        const message = JSON.parse(data.toString());
        const result = respond(request.url, message) ?? {};
        socket.write(frame(JSON.stringify({ id: message.id, result })));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    url: (path) => `ws://127.0.0.1:${server.address().port}${path}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** CDP Runtime.evaluate result carrying a JSON-stringified value (as returnByValue does). */
export const evaluated = (value) => ({ result: { type: 'string', value: JSON.stringify(value) } });
