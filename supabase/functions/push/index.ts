// Bundle with scripts/build-push.mjs before deploying. Secrets stay in Supabase.
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { createPushHandler } from '../../../server/push';

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};
function env(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
const publicKey = env('VAPID_PUBLIC_KEY');
const vapidDetails = {
  subject: env('VAPID_SUBJECT'),
  publicKey,
  privateKey: env('VAPID_PRIVATE_KEY'),
};
Deno.serve(
  createPushHandler({
    db: createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    publicKey,
    appUrl: env('PUSH_APP_URL'),
    dispatchSecret: env('PUSH_DISPATCH_SECRET'),
    send: async (subscription, payload, ttl) => {
      await webpush.sendNotification(subscription, payload, {
        vapidDetails,
        TTL: ttl,
        timeout: 15000,
        urgency: 'normal',
      });
    },
  }),
);
