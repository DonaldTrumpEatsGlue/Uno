const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocket } = require('ws');

test('signed-in UNO identity validates an Openboard account with the publishable key', async (context) => {
  const requests = [];
  const authServer = http.createServer((request, response) => {
    requests.push({
      path: new URL(request.url, 'http://localhost').pathname,
      apiKey: request.headers.apikey,
      authorization: request.headers.authorization,
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/auth/v1/user') {
      response.writeHead(request.headers.authorization === 'Bearer test-access-token' ? 200 : 401);
      response.end(JSON.stringify({ id: 'test-user-id', email: 'player@example.com', user_metadata: { username: 'OpenboardPlayer' } }));
      return;
    }
    if (new URL(request.url, 'http://localhost').pathname === '/rest/v1/profiles') {
      response.writeHead(200);
      response.end(JSON.stringify([{ username: 'OpenboardPlayer' }]));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));
  const authUrl = `http://127.0.0.1:${authServer.address().port}`;
  process.env.SUPABASE_URL = authUrl;
  process.env.SUPABASE_ANON_KEY = 'test-publishable-key';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const { server } = require('./server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  context.after(async () => {
    if (socket.readyState === WebSocket.OPEN) socket.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => authServer.close(resolve));
  });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const identified = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for account identity.')), 3000);
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'identified') return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  socket.send(JSON.stringify({ type: 'identify', accessToken: 'test-access-token' }));

  const identity = await identified;
  assert.equal(identity.name, 'OpenboardPlayer');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.apiKey === 'test-publishable-key'));
  assert.equal(requests[1].authorization, 'Bearer test-access-token');
});
