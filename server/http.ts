import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp';
import { ApiError, errorResponse, type ExpenseService } from './service';

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new ApiError(415, 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new ApiError(413, 'Request body too large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON'); }
}

export function createHttpServer(service: ExpenseService, token: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${token}`);
  return createServer(async (req, res) => {
    try {
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new ApiError(401, 'Invalid bearer token');
      }
      // Server-to-server API. Browser origins are intentionally not enabled.
      if (req.headers.origin) throw new ApiError(403, 'Browser origins are not allowed');
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/mcp') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new ApiError(405, 'Use POST'); }
        const body = await readBody(req);
        const server = createMcpServer(service);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } else if (path === '/api/trip' && req.method === 'GET') {
        json(res, 200, await service.getTrip());
      } else if (path === '/api/expenses' && req.method === 'GET') {
        json(res, 200, await service.listExpenses());
      } else if (path === '/api/expenses' && req.method === 'POST') {
        const result = await service.addExpense(await readBody(req));
        json(res, result.created ? 201 : 200, result);
      } else {
        throw new ApiError(404, 'Endpoint not found');
      }
    } catch (error) {
      const failure = errorResponse(error);
      if (!res.headersSent) json(res, failure.status, { error: failure.error });
      else res.end();
    }
  });
}
