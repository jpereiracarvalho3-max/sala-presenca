/* Robô rápido das notificações do app Eventos dos Bêbados (Cloudflare Worker, plano gratuito).

   Faz o mesmo que .github/push/enviar.py: lê a fila `outbox` do Firestore, descobre os aparelhos de cada
   destinatário (coleção `tokens`) e envia pelo Firebase Cloud Messaging.
   Roda em dois momentos:
     - quando o app avisa (POST nesta URL, logo depois de gravar na fila): envio em segundos;
     - a cada minuto (Cron Trigger "* * * * *"): racha com data de cobrança e lembrete de evento.
   O endereço não aceita conteúdo de quem chama: só manda olhar a fila. No máximo uma olhada a cada 3 segundos.

   Configuração no painel do Cloudflare (Settings do Worker):
     - Variables and Secrets: segredo FIREBASE_SA = conteúdo do arquivo da chave da conta de serviço do Firebase;
     - Trigger Events: Cron Trigger  * * * * *
*/
const PROJ = 'sala-presenca';
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const FCM = `https://fcm.googleapis.com/v1/projects/${PROJ}/messages:send`;
const LINK = 'https://jpereiracarvalho3-max.github.io/sala-presenca/';
const VELHO_MS = 3 * 86400 * 1000; // aviso sem data com mais de 3 dias não é mais enviado
const INTERVALO_MS = 3000;         // intervalo mínimo entre duas olhadas na fila
const LIMITE = 45;                 // o plano gratuito permite 50 chamadas externas por execução; o que não couber fica para o minuto seguinte

/* ---------- regras (iguais às do enviar.py) ---------- */

/* Converte um valor no formato do Firestore REST para JavaScript. */
function valor(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, valor(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(valor);
  return null;
}

function doc(d) {
  const out = Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, valor(v)]));
  out._id = d.name.slice(d.name.lastIndexOf('/') + 1);
  return out;
}

/* Data de hoje em Brasília (AAAA-MM-DD). */
const hojeSP = (agoraMs) => new Date(agoraMs - 3 * 3600000).toISOString().slice(0, 10);

/* O aviso já pode sair? (racha com data de cobrança só sai no dia; lembrete de evento só no horário `em`) */
function naHora(o, hoje, agoraMs) {
  const q = o.quando || '';
  if (q && q > hoje) return false;
  return !o.em || Number(o.em) <= agoraMs;
}

/* Aviso que não faz mais sentido enviar: lembrete com mais de 45 min de atraso, ou aviso comum com mais de 3 dias. */
function perdeuAHora(o, agoraMs) {
  if (o.em) return agoraMs - Number(o.em) > 45 * 60000;
  return !o.quando && agoraMs - Number(o.at || 0) > VELHO_MS;
}

/* Início do evento (data e hora de Brasília) em milissegundos. */
function inicioMs(ev) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(`${ev.date} ${ev.time || '00:00'}`);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 3, +m[5]);
}

/* Lista de uids que recebem o aviso `o`.
   aprov: {uid: memberId} dos aprovados; avatars: {uid: {rsvp: {eventId: 'sim'|'nao'}}}. */
function destinos(o, aprov, avatars) {
  const para = o.para, autor = o.uid, ev = o.eventId || '';
  let us = [];
  if (para === 'todos') us = Object.keys(aprov).filter((u) => (((avatars[u] || {}).rsvp || {})[ev]) !== 'nao');
  else if (Array.isArray(para)) us = Object.keys(aprov).filter((u) => para.includes(aprov[u]));
  return [...new Set(us)].filter((u) => u !== autor || o.teste).sort();
}

function mensagem(o, token) {
  return { message: { token, webpush: {
    headers: { Urgency: 'high', TTL: '86400' },
    notification: { title: o.titulo || 'Eventos dos Bêbados', body: o.corpo || '',
      icon: LINK + 'icone-192.png', badge: LINK + 'icone-192.png', tag: o._id },
    fcm_options: { link: LINK } } } };
}

/* ---------- acesso ao Google (conta de serviço, JWT RS256 assinado com WebCrypto) ---------- */

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const txt = (s) => new TextEncoder().encode(s);

let cache = { v: '', exp: 0, de: '' }; // o acesso vale 1 hora; guarda para não pedir de novo a cada execução

async function acesso(sa, c) {
  const agora = Math.floor(Date.now() / 1000);
  if (cache.v && cache.de === sa.private_key_id && cache.exp - 120 > agora) return cache.v;
  const pem = String(sa.private_key || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const chave = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (x) => x.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const corpo = b64url(txt(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }))) + '.' +
    b64url(txt(JSON.stringify({ iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600,
      scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging' })));
  const jwt = corpo + '.' + b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, txt(corpo)));
  c.n++;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt });
  if (!r.ok) throw new Error('O Google recusou a chave (' + r.status + ').');
  const j = await r.json();
  cache = { v: j.access_token, exp: agora + (j.expires_in || 3600), de: sa.private_key_id };
  return cache.v;
}

/* ---------- uma olhada na fila ---------- */

async function olharFila(env) {
  let sa;
  try { sa = JSON.parse(env.FIREBASE_SA || ''); } catch (e) { return 'Segredo FIREBASE_SA faltando ou inválido.'; }
  if (!sa || !sa.private_key || !sa.client_email) return 'Segredo FIREBASE_SA faltando ou inválido.';
  const c = { n: 0 }; // chamadas externas feitas nesta execução
  const h = { Authorization: 'Bearer ' + await acesso(sa, c), 'Content-Type': 'application/json' };
  const chamar = (url, init) => { c.n++; return fetch(url, { headers: h, ...init }); };

  const listar = async (col) => {
    const out = [];
    let tok = '';
    for (;;) {
      const r = await chamar(`${DOCS}/${col}?pageSize=300${tok ? '&pageToken=' + encodeURIComponent(tok) : ''}`);
      if (!r.ok) throw new Error('Leitura de ' + col + ' falhou (' + r.status + ').');
      const j = await r.json();
      for (const d of j.documents || []) out.push(doc(d));
      tok = j.nextPageToken;
      if (!tok) return out;
    }
  };
  /* Tira o aviso da fila. Só quem consegue apagar envia: se o outro robô (ou outra execução) já pegou, não envia de novo. */
  const pegar = async (id) => (await chamar(`${DOCS}/outbox/${id}?currentDocument.exists=true`, { method: 'DELETE' })).ok;

  const fila = await listar('outbox');
  if (!fila.length) return 'Fila vazia.';
  fila.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const agoraMs = Date.now(), hoje = hojeSP(agoraMs);
  const prontos = [];
  for (const o of fila) {
    if (!naHora(o, hoje, agoraMs)) continue;
    if (perdeuAHora(o, agoraMs)) { await pegar(o._id); continue; }
    if (o.lembrete) { // evento apagado ou remarcado depois de agendar: não avisa
      if (c.n >= LIMITE - 10) continue;
      const r = await chamar(`${DOCS}/events/${o.eventId}`);
      if (!r.ok && r.status !== 404) continue; // falha passageira: tenta de novo no minuto seguinte
      const ev = r.ok ? doc(await r.json()) : null;
      if (!ev || Math.abs(inicioMs(ev) - 32 * 60000 - Number(o.em)) > 60000) { await pegar(o._id); continue; }
    }
    prontos.push(o);
  }
  if (!prontos.length) return `${fila.length} aviso(s) aguardando a hora.`;

  const aprov = {};
  for (const a of await listar('approvals')) if (a.status === 'aprovado') aprov[a._id] = a.memberId;
  const tokens = {};
  for (const t of await listar('tokens')) tokens[t._id] = t.t || {};
  const avatars = {};
  if (prontos.some((o) => o.para === 'todos')) for (const a of await listar('avatars')) avatars[a._id] = a;

  let feitos = 0, enviados = 0, falhas = 0, adiados = 0;
  for (const o of prontos) {
    const us = destinos(o, aprov, avatars);
    const custo = 1 + us.reduce((s, u) => s + Object.keys(tokens[u] || {}).length + 1, 0);
    if (feitos && c.n + custo > LIMITE) { adiados++; continue; }
    if (!await pegar(o._id)) continue;
    feitos++;
    for (const u of us) {
      let mudou = false;
      for (const tk of Object.keys(tokens[u] || {})) {
        let r;
        try { r = await chamar(FCM, { method: 'POST', body: JSON.stringify(mensagem(o, tk)) }); } catch (e) { falhas++; continue; }
        if (r.ok) { enviados++; continue; }
        falhas++;
        console.log('Falha no envio', r.status, (await r.text()).slice(0, 200).split(tk).join('<aparelho>').replace(/\s+/g, ' '));
        if (r.status === 400 || r.status === 404) { delete tokens[u][tk]; mudou = true; } // aparelho que não existe mais: tira do cadastro
      }
      if (mudou) {
        const campos = Object.fromEntries(Object.entries(tokens[u]).map(([k, v]) => [k, { integerValue: String(Math.trunc(Number(v) || 0)) }]));
        try { await chamar(`${DOCS}/tokens/${u}?updateMask.fieldPaths=t`, { method: 'PATCH', body: JSON.stringify({ fields: { t: { mapValue: { fields: campos } } } }) }); } catch (e) {}
      }
    }
  }
  return `${feitos} aviso(s) processado(s), ${enviados} envio(s), ${falhas} falha(s)` + (adiados ? `, ${adiados} para o próximo minuto.` : '.');
}

/* ---------- controle: uma olhada por vez, no máximo uma a cada 3 segundos ---------- */

let ultimaMs = 0, espera = false, resumo = 'ainda não rodou desde que foi ligado';

async function rodar(env) {
  ultimaMs = Date.now();
  let r;
  try { r = await olharFila(env); } catch (e) { r = 'Erro: ' + ((e && e.message) || e); }
  resumo = new Date(ultimaMs).toISOString() + ' ' + r;
  if (r !== 'Fila vazia.') console.log(r);
  return r;
}

/* Pedido do app: olha a fila já, ou assim que passarem 3 segundos da última olhada. Pedidos repetidos nesse meio tempo não somam. */
function pedir(env, ctx) {
  if (espera) return;
  espera = true;
  const falta = Math.max(0, ultimaMs + INTERVALO_MS - Date.now());
  ctx.waitUntil((async () => {
    try { if (falta) await new Promise((ok) => setTimeout(ok, falta)); } finally { espera = false; }
    await rodar(env);
  })());
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'POST') { pedir(env, ctx); return new Response('ok\n', { status: 202 }); }
    if (req.method !== 'GET') return new Response(null, { status: 204 });
    /* Abrir o endereço no navegador só mostra a situação; não envia nada. */
    return new Response(`Robô das notificações no ar.\nChave do Firebase: ${env.FIREBASE_SA ? 'cadastrada' : 'FALTANDO'}\nÚltima olhada na fila: ${resumo}\n`,
      { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(rodar(env));
  },
  _teste: { valor, doc, hojeSP, naHora, perdeuAHora, inicioMs, destinos, mensagem, olharFila },
};
