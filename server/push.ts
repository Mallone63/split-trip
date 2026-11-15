import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  currentDebt,
  pushMessage,
  type PushPayload,
  type RawBundle,
} from './push-content';

const uuid = z.uuid();
const credentials = {
  deviceId: uuid,
  deviceToken: z.string().regex(/^[a-f0-9]{64}$/),
};
const preferences = z
  .object({
    expenses: z.boolean(),
    settlements: z.boolean(),
    reminders: z.boolean(),
  })
  .strict();
const subscription = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});
const register = z
  .object({
    ...credentials,
    tripId: uuid,
    memberId: uuid,
    subscription,
    preferences,
  })
  .strict();
const unregister = z.object(credentials).strict();
const remind = z
  .object({
    requestId: uuid,
    tripId: uuid,
    actorId: uuid,
    payerId: uuid,
    receiverId: uuid,
    currency: z.enum(['RUB', 'USD', 'JPY']),
  })
  .strict();
interface PushJob {
  id: string;
  trip_id: string;
  subscription_id: string;
  kind: string;
  source_id: string;
  payload: PushPayload;
  attempts: number;
  created_at: string;
}
export type SendPush = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  ttl: number,
) => Promise<void>;
interface Config {
  db: SupabaseClient;
  publicKey: string;
  appUrl: string;
  dispatchSecret: string;
  send: SendPush;
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function allowedPushEndpoint(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      (u.hostname.endsWith('.push.apple.com') ||
        u.hostname === 'fcm.googleapis.com' ||
        u.hostname === 'updates.push.services.mozilla.com')
    );
  } catch {
    return false;
  }
}
async function hash(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
async function checked<T>(
  request: PromiseLike<{ data: T; error: unknown }>,
): Promise<T> {
  const r = await request;
  if (r.error)
    throw new HttpError(503, 'Сервис уведомлений временно недоступен');
  return r.data;
}

export function createPushHandler(config: Config) {
  const { db } = config;
  const origin = new URL(config.appUrl).origin;
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Cache-Control': 'no-store',
      },
    });
  async function bundle(tripId: string): Promise<RawBundle> {
    return (await checked(
      db.rpc('push_trip_snapshot', { t: tripId }),
    )) as RawBundle;
  }
  async function dispatch() {
    const jobs: PushJob[] = await checked(db.rpc('claim_push_jobs', { batch_size: 10 }));
    let sent = 0;
    await Promise.all(
      (jobs ?? []).map(async (job) => {
        const s = await checked(
          db
            .from('push_subscriptions')
            .select('*')
            .eq('id', job.subscription_id)
            .maybeSingle(),
        );
        // Recheck identity, preference and cancellation after claiming.
        const latest = await checked(
          db.from('push_jobs').select('status').eq('id', job.id).maybeSingle(),
        );
        if (!s || latest?.status !== 'sending') return;
        const payload = job.payload as PushPayload;
        const enabled =
          job.kind === 'reminder'
            ? s.reminders
            : job.kind.startsWith('expense')
              ? s.expenses
              : s.settlements;
        if (
          !enabled ||
          s.trip_id !== job.trip_id ||
          s.member_id !== payload.recipientId
        ) {
          await checked(
            db
              .from('push_jobs')
              .update({ status: 'cancelled' })
              .eq('id', job.id),
          );
          return;
        }
        if (job.kind === 'reminder') {
          const r = payload.record;
          const data = await bundle(job.trip_id);
          const debt = currentDebt(
            data,
            String(r.payer_id),
            String(r.receiver_id),
            r.currency as 'JPY' | 'RUB' | 'USD',
          );
          if (
            !debt ||
            !debt.from.memberIds.includes(s.member_id) ||
            !debt.to.memberIds.includes(String(r.actor_id)) ||
            new Date(job.created_at).getTime() < Date.now() - 3600_000
          ) {
            await checked(
              db
                .from('push_jobs')
                .update({ status: 'cancelled' })
                .eq('id', job.id),
            );
            return;
          }
          payload.record = { ...r, amount: debt.amountMinor };
          payload.members = data.members;
        }
        try {
          if (!allowedPushEndpoint(s.endpoint))
            throw Object.assign(new Error('Invalid endpoint'), {
              statusCode: 400,
            });
          await config.send(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(
              pushMessage(
                job.kind,
                job.source_id,
                job.trip_id,
                payload,
                config.appUrl,
              ),
            ),
            job.kind === 'reminder' ? 3600 : 86400,
          );
          await checked(
            db
              .from('push_jobs')
              .update({
                status: 'sent',
                delivered_at: new Date().toISOString(),
                last_error: null,
              })
              .eq('id', job.id)
              .eq('status', 'sending'),
          );
          sent++;
        } catch (error) {
          const status =
            Number((error as { statusCode?: number }).statusCode) || 0;
          if (status === 404 || status === 410)
            await checked(
              db.from('push_subscriptions').delete().eq('id', s.id),
            );
          else
            await checked(
              db
                .from('push_jobs')
                .update({
                  status:
                    job.attempts >= 8 ||
                    (status >= 400 && status < 500 && status !== 429)
                      ? 'failed'
                      : 'pending',
                  available_at: new Date(
                    Date.now() + Math.min(3600, 30 * 2 ** job.attempts) * 1000,
                  ).toISOString(),
                  last_error: status
                    ? `push_http_${status}`
                    : 'push_transport_error',
                })
                .eq('id', job.id)
                .eq('status', 'sending'),
            );
        }
      }),
    );
    return { processed: jobs?.length ?? 0, sent };
  }
  return async (request: Request): Promise<Response> => {
    try {
      const action = new URL(request.url).pathname.split('/').pop();
      if (action === 'dispatch') {
        if (
          request.method !== 'POST' ||
          !config.dispatchSecret ||
          request.headers.get('x-push-secret') !== config.dispatchSecret
        )
          throw new HttpError(403, 'Forbidden');
        return json(await dispatch());
      }
      if (
        request.headers.get('origin') &&
        request.headers.get('origin') !== origin
      )
        throw new HttpError(403, 'Origin is not allowed');
      if (request.method === 'OPTIONS')
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Headers':
              'authorization, apikey, content-type, x-client-info',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            Vary: 'Origin',
          },
        });
      if (request.method === 'GET' && action === 'config')
        return json({ publicKey: config.publicKey });
      if (request.method !== 'POST')
        throw new HttpError(405, 'Method not allowed');
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        throw new HttpError(415, 'JSON required');
      const reader = request.body?.getReader();
      if (!reader) throw new HttpError(400, 'JSON required');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 12000) {
            await reader.cancel();
            throw new HttpError(413, 'Request too large');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      const body = new TextDecoder().decode(bytes);
      const input = JSON.parse(body);
      if (action === 'subscribe') {
        const p = register.parse(input);
        if (!allowedPushEndpoint(p.subscription.endpoint))
          throw new HttpError(400, 'Неподдерживаемый push-сервис');
        // Limit stored devices; endpoints and device secrets never leave this service.
        const existing = await checked(
          db
            .from('push_subscriptions')
            .select('id')
            .eq('trip_id', p.tripId)
            .eq('member_id', p.memberId),
        );
        if (
          (existing ?? []).length >= 8 &&
          !(existing ?? []).some((s) => s.id === p.deviceId)
        )
          throw new HttpError(409, 'Достигнут лимит: 8 устройств на участника');
        const result = await db.rpc('save_push_subscription', {
          device: p.deviceId,
          secret_hash: await hash(p.deviceToken),
          t: p.tripId,
          member: p.memberId,
          push_endpoint: p.subscription.endpoint,
          dh: p.subscription.keys.p256dh,
          auth_key: p.subscription.keys.auth,
          prefs: p.preferences,
        });
        if (result.error)
          throw new HttpError(
            409,
            'Не удалось привязать устройство. Проверь участника и переподключи уведомления.',
          );
        return json({ subscribed: true });
      }
      if (action === 'unsubscribe') {
        const p = unregister.parse(input);
        const s = await checked(
          db
            .from('push_subscriptions')
            .select('*')
            .eq('id', p.deviceId)
            .maybeSingle(),
        );
        if (s && s.token_hash !== (await hash(p.deviceToken)))
          throw new HttpError(403, 'Неверный ключ устройства');
        if (s)
          await checked(db.from('push_subscriptions').delete().eq('id', s.id));
        return json({ subscribed: false });
      }
      if (action === 'remind') {
        const p = remind.parse(input);
        const data = await bundle(p.tripId),
          debt = currentDebt(data, p.payerId, p.receiverId, p.currency);
        if (!debt)
          throw new HttpError(409, 'Этот долг уже погашен или изменился');
        if (!debt.to.memberIds.includes(p.actorId))
          throw new HttpError(
            403,
            'Напомнить может участник кошелька, которому должны',
          );
        const result = await db.rpc('queue_debt_reminder', {
          t: p.tripId,
          creditor: debt.to.key,
          debtor: debt.from.key,
          actor: p.actorId,
          recipients: debt.from.memberIds,
          reminder_id: p.requestId,
          data: {
            record: {
              actor_id: p.actorId,
              payer_id: p.payerId,
              receiver_id: p.receiverId,
              amount: debt.amountMinor,
              currency: p.currency,
            },
            members: data.members,
            baseCurrency: data.trip.base_currency,
          },
        });
        if (result.error?.message.includes('REMINDER_COOLDOWN'))
          throw new HttpError(
            429,
            'Этому кошельку уже напоминали за последние 24 часа',
          );
        if (result.error)
          throw new HttpError(
            503,
            'Не удалось поставить напоминание в очередь',
          );
        return json({
          queued: result.data === true,
          reason: result.data ? 'queued' : 'notifications_disabled',
        });
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      return json(
        {
          error:
            e instanceof HttpError
              ? e.message
              : e instanceof z.ZodError || e instanceof SyntaxError
                ? 'Некорректные данные'
                : 'Сервис уведомлений временно недоступен',
        },
        e instanceof HttpError
          ? e.status
          : e instanceof z.ZodError || e instanceof SyntaxError
            ? 400
            : 503,
      );
    }
  };
}
