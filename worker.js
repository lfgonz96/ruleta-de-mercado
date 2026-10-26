// Servidor del ranking de la Ruleta de Mercado (Cloudflare Worker).
// Todo lo que no empieza con /api/ lo atiende Cloudflare como archivos estáticos (la web y los audios).
//
//   POST /api/giro      -> el SERVIDOR sortea (acción o token) y entrega un ticket firmado
//   POST /api/alias     -> crea un alias y entrega un código de recuperación (se muestra una sola vez)
//   POST /api/entrar    -> entra con alias + código (para usar el mismo alias en otro dispositivo)
//   POST /api/autor     -> dice si el alias (con su código) es el del autor (variable AUTOR_ALIAS); solo muestra herramientas de edición
//   POST /api/codigo-nuevo -> cambia el código (invalida el anterior)
//   POST /api/registrar -> canjea un ticket que salió "especial" por +1 en el ranking (con alias + código)
//   GET  /api/ranking   -> top del ranking
//
// Qué cuenta: las 7 magníficas (AAPL, MSFT, GOOGL, GOOG, AMZN, NVDA, META, TSLA), Bitcoin y Ethereum.
// Qué guarda: alias, cantidad de aciertos y el hash del código de recuperación. No guarda IP ni datos personales.
//
// Necesita: base D1 con el nombre de binding DB, y el secreto TICKET_SECRET (ver las instrucciones).

const MAGNIFICAS = new Set(['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA']);
const COINS_ESPECIALES = new Set(['bitcoin', 'ethereum']);
const VIDA_TICKET_MS = 60 * 60 * 1000;   // un ticket se puede canjear hasta 1 hora después del giro
const ESPERA_MIN_MS = 4000;              // y no antes de 4 s (evita canjear sin haber "girado")
const TOP_MAX = 25;

// ---- Lista de palabras no permitidas en alias (odio, menores, estafas). Los insultos comunes se permiten. ----
const PROHIBIDAS = ['nazi', 'hitler', 'kkk', 'pedofil', 'pedo filo', 'violador', 'violacion', 'suicid', 'sudaca',
  'mongolic', 'retrasad', 'maricon', 'trolo', 'travelo', 'sidoso', 'whatsapp', 'telegram', 'cripto gratis', 'airdrop'];

let datosCache = null, datosCacheTs = 0;
let tablasListas = false;
const limites = new Map();

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
});

function limitar(ip, clave, max, ventanaMs) {
  const k = clave + '|' + ip, ahora = Date.now();
  let e = limites.get(k);
  if (!e || ahora - e.t0 > ventanaMs) { e = { t0: ahora, n: 0 }; limites.set(k, e); }
  e.n++;
  if (limites.size > 5000) { for (const [kk, v] of limites) if (ahora - v.t0 > ventanaMs) limites.delete(kk); }
  return e.n <= max;
}

const enc = new TextEncoder();
function b64u(bytes) {
  let s = ''; bytes = new Uint8Array(bytes);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64u(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '=';
  const bin = atob(str), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function clave(env) {
  return crypto.subtle.importKey('raw', enc.encode(env.TICKET_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function firmar(env, payload) {
  const cuerpo = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await clave(env), enc.encode(cuerpo));
  return cuerpo + '.' + b64u(sig);
}
async function verificar(env, ticket) {
  if (typeof ticket !== 'string' || ticket.length > 600 || ticket.indexOf('.') < 1) return null;
  const [cuerpo, sig] = ticket.split('.');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await clave(env), deB64u(sig), enc.encode(cuerpo)); } catch (e) { return null; }
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(deB64u(cuerpo))); } catch (e) { return null; }
}
async function sha256hex(txt) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(txt));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function azar(n) {
  const lim = Math.floor(0x100000000 / n) * n, a = new Uint32Array(1);
  do { crypto.getRandomValues(a); } while (a[0] >= lim);
  return a[0] % n;
}

// Las listas salen del mismo index.html que ve la gente, así servidor y web siempre coinciden.
async function datos(request, env) {
  if (datosCache && Date.now() - datosCacheTs < 5 * 60 * 1000) return datosCache;
  const url = new URL('/', request.url);
  const r = await env.ASSETS.fetch(new Request(url.toString()));
  const html = await r.text();
  const m = html.match(/var DATA = (\{[\s\S]*?\});\n/);
  if (!m) throw new Error('sin datos');
  const d = JSON.parse(m[1]);
  datosCache = { stocks: d.stocks, coins: d.coins }; datosCacheTs = Date.now();
  return datosCache;
}

async function asegurarTablas(env) {
  if (tablasListas) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS scores (alias TEXT PRIMARY KEY COLLATE NOCASE, owner TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, last_ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS hits (nonce TEXT PRIMARY KEY, alias TEXT NOT NULL, item TEXT NOT NULL, ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_scores_hits ON scores (hits DESC, last_ts ASC)')
  ]);
  tablasListas = true;
}

function normalizar(a) {
  return a.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '');
}
function aliasValido(alias) {
  if (typeof alias !== 'string') return null;
  const a = alias.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (a.length < 3 || a.length > 16) return null;
  if (!/^[\p{L}\p{N} ._-]+$/u.test(a)) return null;
  if (/(https?|www|\.com|\.ar|\.net|\.io|@)/i.test(a)) return null;
  const n = normalizar(a);
  for (const p of PROHIBIDAS) if (n.includes(p.replace(/ /g, ''))) return null;
  if ((a.match(/\d/g) || []).length > 6) return null;
  return a;
}

async function cuerpo(request) {
  try {
    const t = await request.text();
    if (t.length > 2000) return null;
    return JSON.parse(t);
  } catch (e) { return null; }
}

async function giro(request, env) {
  if (!env.TICKET_SECRET) return json({ error: 'no-configurado' }, 503);
  const b = await cuerpo(request);
  if (!b || (b.wheel !== 'stock' && b.wheel !== 'coin')) return json({ error: 'pedido-invalido' }, 400);
  const d = await datos(request, env);
  let item;
  if (b.wheel === 'stock') {
    const it = d.stocks[azar(d.stocks.length)];
    item = it[0];
  } else {
    const lista = d.coins.filter(c => !b.filtro || !c[4]);
    if (!lista.length) return json({ error: 'sin-lista' }, 500);
    item = lista[azar(lista.length)][1];
  }
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(12)));
  const ticket = await firmar(env, { w: b.wheel, k: item, t: Date.now(), n: nonce });
  return json({ ticket, key: item });
}

// ---- Cuentas: alias + código de recuperación (sin contraseñas propias) ----
// El servidor genera un código al crear el alias, lo muestra UNA vez y solo guarda su hash.
// Con ese código se entra desde otro dispositivo y se canjean los aciertos.
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sin I, L, O, 0, 1 para que no se confundan
function nuevoCodigo() {
  let c = '';
  for (let i = 0; i < 12; i++) c += ALFABETO[azar(ALFABETO.length)];
  return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8);
}
function limpiarCodigo(c) {
  if (typeof c !== 'string' || c.length > 40) return null;
  const l = c.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{12}$/.test(l) ? l : null;
}
const hashCodigo = (l) => sha256hex('ruleta-codigo|' + l);
const MSG_ALIAS = 'Alias de 3 a 16 letras, números, espacios, punto, guion o guion bajo, sin links ni palabras prohibidas.';

// Devuelve { fila } si alias+código coinciden; si no, { error: Response }
async function autenticar(env, aliasIn, codigoIn) {
  const alias = typeof aliasIn === 'string' ? aliasIn.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  const cod = limpiarCodigo(codigoIn);
  if (!alias || !cod) return { error: json({ error: 'pedido-invalido' }, 400) };
  await asegurarTablas(env);
  const fila = await env.DB.prepare('SELECT alias, owner, hits FROM scores WHERE alias = ?1').bind(alias).first();
  const h = await hashCodigo(cod);
  if (!fila || fila.owner !== h) return { error: json({ error: 'codigo-incorrecto', mensaje: 'Alias o código incorrectos.' }, 403) };
  return { fila, hash: h };
}

async function crearAlias(request, env) {
  if (!env.DB) return json({ error: 'no-configurado' }, 503);
  const b = await cuerpo(request);
  if (!b) return json({ error: 'pedido-invalido' }, 400);
  const alias = aliasValido(b.alias);
  if (!alias) return json({ error: 'alias-invalido', mensaje: MSG_ALIAS }, 400);
  await asegurarTablas(env);
  const ahora = Date.now();
  // limpieza: aliases creados que nunca sumaron nada y tienen más de 30 días
  await env.DB.prepare('DELETE FROM scores WHERE hits = 0 AND last_ts < ?1').bind(ahora - 30 * 86400000).run();
  const codigo = nuevoCodigo();
  const h = await hashCodigo(codigo.replace(/-/g, ''));
  try {
    await env.DB.prepare('INSERT INTO scores (alias, owner, hits, last_ts) VALUES (?1, ?2, 0, ?3)').bind(alias, h, ahora).run();
  } catch (e) {
    return json({ error: 'alias-ocupado', mensaje: 'Ese alias ya lo usa otra persona. Elegí otro.' }, 409);
  }
  return json({ ok: true, alias, codigo });
}

async function entrar(request, env) {
  if (!env.DB) return json({ error: 'no-configurado' }, 503);
  const b = await cuerpo(request);
  if (!b) return json({ error: 'pedido-invalido' }, 400);
  const r = await autenticar(env, b.alias, b.codigo);
  if (r.error) return r.error;
  return json({ ok: true, alias: r.fila.alias, hits: r.fila.hits });
}

async function autor(request, env) {
  if (!env.DB) return json({ error: 'no-configurado' }, 503);
  const b = await cuerpo(request);
  if (!b) return json({ error: 'pedido-invalido' }, 400);
  const r = await autenticar(env, b.alias, b.codigo);
  if (r.error) return r.error;
  const lista = String(env.AUTOR_ALIAS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return json({ ok: true, autor: lista.includes(String(r.fila.alias).toLowerCase()) });
}

async function codigoNuevo(request, env) {
  if (!env.DB) return json({ error: 'no-configurado' }, 503);
  const b = await cuerpo(request);
  if (!b) return json({ error: 'pedido-invalido' }, 400);
  const r = await autenticar(env, b.alias, b.codigo);
  if (r.error) return r.error;
  const codigo = nuevoCodigo();
  await env.DB.prepare('UPDATE scores SET owner = ?1 WHERE alias = ?2').bind(await hashCodigo(codigo.replace(/-/g, '')), r.fila.alias).run();
  return json({ ok: true, alias: r.fila.alias, codigo });
}

async function registrar(request, env) {
  if (!env.TICKET_SECRET || !env.DB) return json({ error: 'no-configurado' }, 503);
  const b = await cuerpo(request);
  if (!b) return json({ error: 'pedido-invalido' }, 400);
  const r = await autenticar(env, b.alias, b.codigo);
  if (r.error) return r.error;
  const alias = r.fila.alias;
  const t = await verificar(env, b.ticket);
  if (!t || typeof t.t !== 'number') return json({ error: 'ticket-invalido' }, 400);
  const edad = Date.now() - t.t;
  if (edad > VIDA_TICKET_MS) return json({ error: 'ticket-vencido', mensaje: 'Ese giro es de hace más de una hora.' }, 400);
  if (edad < ESPERA_MIN_MS) return json({ error: 'muy-rapido' }, 400);
  const especial = (t.w === 'stock' && MAGNIFICAS.has(t.k)) || (t.w === 'coin' && COINS_ESPECIALES.has(t.k));
  if (!especial) return json({ error: 'no-es-especial' }, 400);

  const ahora = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO hits (nonce, alias, item, ts) VALUES (?1, ?2, ?3, ?4)').bind(t.n, alias, t.w + ':' + t.k, ahora),
      env.DB.prepare('UPDATE scores SET hits = hits + 1, last_ts = ?2 WHERE alias = ?1').bind(alias, ahora)
    ]);
  } catch (e) {
    return json({ error: 'ya-canjeado', mensaje: 'Ese giro ya se había sumado.' }, 409);
  }
  const fila = await env.DB.prepare('SELECT hits FROM scores WHERE alias = ?1').bind(alias).first();
  const mejores = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE hits > ?1').bind(fila.hits).first();
  return json({ ok: true, alias, hits: fila.hits, puesto: mejores.n + 1 });
}

async function ranking(request, env) {
  if (!env.DB) return json({ error: 'no-configurado' }, 503);
  await asegurarTablas(env);
  const top = await env.DB.prepare('SELECT alias, hits FROM scores WHERE hits > 0 ORDER BY hits DESC, last_ts ASC LIMIT ?1').bind(TOP_MAX).all();
  const total = await env.DB.prepare('SELECT COALESCE(SUM(hits),0) AS n, COUNT(*) AS j FROM scores WHERE hits > 0').first();
  const ult = await env.DB.prepare('SELECT alias, item, ts FROM hits ORDER BY ts DESC LIMIT 5').all();
  return json({ top: top.results, aciertos: total.n, jugadores: total.j, ultimos: ult.results }, 200, { 'cache-control': 'public, max-age=15' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const ip = request.headers.get('cf-connecting-ip') || 'x';
    try {
      if (url.pathname === '/api/giro' && request.method === 'POST') {
        if (!limitar(ip, 'giro', 12, 60000)) return json({ error: 'demasiados-pedidos' }, 429);
        return await giro(request, env);
      }
      if (url.pathname === '/api/registrar' && request.method === 'POST') {
        if (!limitar(ip, 'reg', 12, 60000)) return json({ error: 'demasiados-pedidos' }, 429);
        return await registrar(request, env);
      }
      if (url.pathname === '/api/alias' && request.method === 'POST') {
        if (!limitar(ip, 'alias', 6, 60000)) return json({ error: 'demasiados-pedidos' }, 429);
        return await crearAlias(request, env);
      }
      if (url.pathname === '/api/entrar' && request.method === 'POST') {
        if (!limitar(ip, 'entrar', 10, 60000)) return json({ error: 'demasiados-pedidos' }, 429);
        return await entrar(request, env);
      }
      if (url.pathname === '/api/autor' && request.method === 'POST') {
        if (!limitar(ip, 'autor', 20, 60000)) return json({ error: 'demasiados-pedidos' }, 429);
        return await autor(request, env);
      }
      if (url.pathname === '/api/codigo-nuevo' && request.method === 'POST') {
        if (!limitar(ip, 'codnuevo', 4, 60000)) return json({ error: 'demasiados-pedidos' }, 429);
        return await codigoNuevo(request, env);
      }
      if (url.pathname === '/api/ranking' && request.method === 'GET') {
        if (!limitar(ip, 'rank', 60, 60000)) return json({ error: 'demasiados-pedidos' }, 429);
        return await ranking(request, env);
      }
    } catch (e) {
      return json({ error: 'error-interno' }, 500);
    }
    return json({ error: 'no-existe' }, 404);
  }
};
