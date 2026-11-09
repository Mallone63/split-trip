import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createHttpServer } from './http';
import { createService } from './service';

const config = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  TRIP_ID: z.uuid(),
  API_TOKEN: z.string().min(32),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
}).safeParse(process.env);
if (!config.success) {
  // Only variable names; never print secret values.
  console.error('Invalid server configuration:', config.error.issues.map(i => i.path.join('.')).join(', '));
  process.exit(1);
}
const env = config.data;
const db = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, {
    ...init, signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  }) },
});
const server = createHttpServer(createService(db, env.TRIP_ID), env.API_TOKEN);
server.listen(env.PORT, env.HOST, () => console.log(`Split Trip API/MCP listening on ${env.HOST}:${env.PORT}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());
