import { parseItem, parsePlate, normalize } from './parse';

interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ALLOWED_ORIGIN: string;
  OCR_BASE_URL: string;
  OCR_MODEL: string;
  OCR_API_KEY?: string;   // wrangler secret put OCR_API_KEY
  SYNC_TOKEN?: string;    // wrangler secret put SYNC_TOKEN
}

const MAX_PHOTO_BYTES = 300 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
// A 300KB JPEG becomes ~400KB once base64-encoded into the data URL, plus the
// surrounding JSON. This bounds the OCR proxy without rejecting a real photo.
const MAX_OCR_BYTES = 450 * 1024;

function cors(env: Env, origin: string | null): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN.split(',').map((s) => s.trim());
  const ok = origin && allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin! : allowed[0],
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, init: ResponseInit, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Constant-time compare so a wrong token leaks no timing signal. */
async function tokenOk(provided: string | null, expected: string | undefined): Promise<boolean> {
  if (!expected || !provided) return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const h = cors(env, origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, ts: Date.now() }, { status: 200 }, h);
      }

      // Parser is stateless and harmless — left open so the PWA can use it
      // before any sync token is configured.
      if (url.pathname === '/parse' && request.method === 'POST') {
        const body = (await request.json()) as { text?: string; kind?: string };
        const text = String(body.text ?? '');
        if (body.kind === 'plate') {
          return json({ plate: parsePlate(text), normalized: normalize(text) }, { status: 200 }, h);
        }
        return json({ item: parseItem(text), normalized: normalize(text) }, { status: 200 }, h);
      }

      // Everything past here mutates or reads private ledger data.
      const auth = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? null;
      if (!(await tokenOk(auth, env.SYNC_TOKEN))) {
        return json({ error: 'unauthorized' }, { status: 401 }, h);
      }

      if (url.pathname === '/sync' && request.method === 'POST') {
        const len = Number(request.headers.get('Content-Length') ?? '0');
        if (len > MAX_JSON_BYTES) return json({ error: 'payload too large' }, { status: 413 }, h);
        return await handleSync(request, env, h);
      }

      if (url.pathname === '/sync' && request.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0');
        const device = url.searchParams.get('device') ?? '';
        return await handlePull(env, device, since, h);
      }

      if (url.pathname.startsWith('/photo/')) {
        return await handlePhoto(request, env, url, h);
      }

      if (url.pathname === '/ocr' && request.method === 'POST') {
        return await handleOcr(request, env, h);
      }

      return json({ error: 'not found' }, { status: 404 }, h);
    } catch (err) {
      console.error(JSON.stringify({
        msg: 'unhandled',
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err),
      }));
      return json({ error: 'internal error' }, { status: 500 }, h);
    }
  },
} satisfies ExportedHandler<Env>;

interface JobPayload {
  id: string;
  device_id: string;
  plate?: string | null;
  plate_photo?: string | null;
  customer_id?: string | null;
  note?: string | null;
  total_cost?: number;
  total_charge?: number;
  settled?: number;
  /** Printed on the customer's copy; must survive a round trip verbatim. */
  receipt_no?: string | null;
  /** Local calendar day (YYYY-MM-DD), not derivable from created_at. */
  local_date?: string | null;
  created_at: number;
  updated_at: number;
  deleted_at?: number | null;
  items?: Array<{
    id: string;
    spoken_name: string;
    canonical_id?: string | null;
    qty?: number;
    cost?: number;
    shipping?: number;
    charge?: number;
    seq?: number;
  }>;
}

/**
 * Last-write-wins on updated_at. Single-device app, so a real CRDT would be
 * over-engineering; the guard exists only to stop a stale offline replay from
 * clobbering a newer edit.
 */
async function handleSync(request: Request, env: Env, h: Record<string, string>): Promise<Response> {
  const body = (await request.json()) as { jobs?: JobPayload[] };
  const jobs = body.jobs ?? [];
  if (!Array.isArray(jobs) || jobs.length > 500) {
    return json({ error: 'invalid batch' }, { status: 400 }, h);
  }

  const perJob: Array<{ id: string; stmts: D1PreparedStatement[] }> = [];
  for (const j of jobs) {
    if (!j.id || !j.device_id || !j.created_at) continue;
    const version = j.updated_at ?? j.created_at;
    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      env.DB.prepare(
        `INSERT INTO jobs (id, device_id, plate, plate_photo, customer_id, note,
                           total_cost, total_charge, settled, receipt_no, local_date,
                           created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           plate=excluded.plate, plate_photo=excluded.plate_photo,
           customer_id=excluded.customer_id, note=excluded.note,
           total_cost=excluded.total_cost, total_charge=excluded.total_charge,
           settled=excluded.settled, receipt_no=excluded.receipt_no,
           local_date=excluded.local_date, updated_at=excluded.updated_at,
           deleted_at=excluded.deleted_at
         WHERE excluded.updated_at >= jobs.updated_at`,
      ).bind(
        j.id, j.device_id, j.plate ?? null, j.plate_photo ?? null,
        j.customer_id ?? null, j.note ?? null,
        j.total_cost ?? 0, j.total_charge ?? 0, j.settled ?? 0,
        j.receipt_no ?? null, j.local_date ?? null,
        j.created_at, version, j.deleted_at ?? null,
      ),
    );

    if (j.items?.length) {
      stmts.push(
        env.DB.prepare(
          `DELETE FROM job_items
           WHERE job_id = ?
             AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND updated_at = ?)`,
        ).bind(j.id, j.id, version),
      );
      for (const [i, it] of j.items.entries()) {
        if (!it.id || !it.spoken_name) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO job_items (id, job_id, spoken_name, canonical_id, qty, cost, shipping, charge, seq, created_at)
             SELECT ?,?,?,?,?,?,?,?,?,?
             WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND updated_at = ?)`,
          ).bind(
            it.id, j.id, it.spoken_name, it.canonical_id ?? null,
            it.qty ?? 1, it.cost ?? 0, it.shipping ?? 0, it.charge ?? 0,
            it.seq ?? i, j.created_at, j.id, version,
          ),
        );
      }
    }
    perJob.push({ id: j.id, stmts: stmts });
  }

  if (!perJob.length) return json({ ok: true, written: 0 }, { status: 200 }, h);

  // One batch per job rather than one for everything. D1 runs a batch as a
  // single transaction, so a constraint conflict on one job (a receipt number
  // reused after a restore, say) would otherwise reject every other job in the
  // push — one bad row silently blocking the whole ledger from syncing, which
  // is the failure this endpoint exists to prevent.
  let written = 0;
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const { id, stmts } of perJob) {
    try {
      await env.DB.batch(stmts);
      written++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ msg: 'job rejected', id, reason }));
      skipped.push({ id, reason });
    }
  }
  return json({ ok: true, written, skipped, ts: Date.now() }, { status: 200 }, h);
}

async function handlePull(
  env: Env, device: string, since: number, h: Record<string, string>,
): Promise<Response> {
  if (!device) return json({ error: 'device required' }, { status: 400 }, h);
  const { results } = await env.DB.prepare(
    `SELECT * FROM jobs WHERE device_id = ? AND updated_at > ?
     ORDER BY updated_at ASC LIMIT 200`,
  ).bind(device, since).all();

  const ids = (results as Array<{ id: string }>).map((r) => r.id);
  let items: unknown[] = [];
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT * FROM job_items WHERE job_id IN (${ph}) ORDER BY job_id, seq`,
    ).bind(...ids).all();
    items = r.results;
  }
  return json({ jobs: results, items, ts: Date.now() }, { status: 200 }, h);
}

async function handlePhoto(
  request: Request, env: Env, url: URL, h: Record<string, string>,
): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice('/photo/'.length));
  if (!key || key.includes('..')) return json({ error: 'bad key' }, { status: 400 }, h);

  if (request.method === 'PUT') {
    const len = Number(request.headers.get('Content-Length') ?? '0');
    if (len > MAX_PHOTO_BYTES) {
      return json({ error: 'photo too large', max: MAX_PHOTO_BYTES }, { status: 413 }, h);
    }
    await env.PHOTOS.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get('Content-Type') ?? 'image/jpeg' },
    });
    return json({ ok: true, key }, { status: 200 }, h);
  }

  if (request.method === 'GET') {
    const obj = await env.PHOTOS.get(key);
    if (!obj) return json({ error: 'not found' }, { status: 404 }, h);
    const hdr = new Headers(h);
    obj.writeHttpMetadata(hdr);
    hdr.set('etag', obj.httpEtag);
    hdr.set('Cache-Control', 'private, max-age=31536000, immutable');
    return new Response(obj.body, { headers: hdr });
  }

  if (request.method === 'DELETE') {
    await env.PHOTOS.delete(key);
    return json({ ok: true }, { status: 200 }, h);
  }

  return json({ error: 'method not allowed' }, { status: 405 }, h);
}

/**
 * Vision-model proxy. Exists so the API key never ships inside the PWA —
 * that is the entire reason this Worker handles OCR at all.
 */
async function handleOcr(
  request: Request, env: Env, h: Record<string, string>,
): Promise<Response> {
  // Size first: this endpoint forwards the image to a paid vision API, so an
  // unbounded body is a billing problem, not just a slow request. Checked
  // before the key so the limit holds whether or not OCR is configured.
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_OCR_BYTES) {
    return json({ error: 'photo too large', max: MAX_OCR_BYTES }, { status: 413 }, h);
  }

  if (!env.OCR_API_KEY) return json({ error: 'ocr not configured' }, { status: 503 }, h);

  const raw = await request.text();
  // A chunked request has no Content-Length, so re-check the body we actually got.
  if (raw.length > MAX_OCR_BYTES) {
    return json({ error: 'photo too large', max: MAX_OCR_BYTES }, { status: 413 }, h);
  }
  let body: { image?: string; kind?: string };
  try {
    body = JSON.parse(raw) as { image?: string; kind?: string };
  } catch {
    return json({ error: 'bad json' }, { status: 400 }, h);
  }
  if (!body.image?.startsWith('data:image/')) {
    return json({ error: 'image must be a data URL' }, { status: 400 }, h);
  }

  const prompt = body.kind === 'invoice'
    ? '这是一张汽配销货单。逐行提取配件名称、数量、单价（元）。只输出 JSON 数组：[{"name":"","qty":1,"price":0}]，不要解释。'
    : '识别图中车牌号，只输出车牌号本身，例如 皖A12345。看不清就输出 UNKNOWN。';

  const upstream = await fetch(env.OCR_BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OCR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OCR_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: body.image } },
          { type: 'text', text: prompt },
        ],
      }],
      max_tokens: 800,
      temperature: 0,
    }),
  });

  if (!upstream.ok) {
    console.error(JSON.stringify({ msg: 'ocr upstream failed', status: upstream.status }));
    return json({ error: 'ocr failed', status: upstream.status }, { status: 502 }, h);
  }

  const data = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  const plate = body.kind === 'invoice' ? null : parsePlate(text);
  return json({ text, plate }, { status: 200 }, h);
}
