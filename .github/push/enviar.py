"""Robô das notificações do app Eventos dos Bêbados.

Lê a fila `outbox` do Firestore, descobre os aparelhos de cada destinatário (coleção `tokens`)
e envia pelo Firebase Cloud Messaging. Depois apaga o aviso da fila.
Com a fila vazia gasta 1 leitura do banco por execução.
"""
import datetime
import json
import os
import sys

PROJ = 'sala-presenca'
DOCS = f'https://firestore.googleapis.com/v1/projects/{PROJ}/databases/(default)/documents'
FCM = f'https://fcm.googleapis.com/v1/projects/{PROJ}/messages:send'
LINK = 'https://jpereiracarvalho3-max.github.io/sala-presenca/'
VELHO_MS = 3 * 86400 * 1000  # aviso sem data com mais de 3 dias não é mais enviado


def valor(v):
    """Converte um valor no formato do Firestore REST para Python."""
    if 'stringValue' in v: return v['stringValue']
    if 'integerValue' in v: return int(v['integerValue'])
    if 'doubleValue' in v: return float(v['doubleValue'])
    if 'booleanValue' in v: return v['booleanValue']
    if 'mapValue' in v: return {k: valor(x) for k, x in v['mapValue'].get('fields', {}).items()}
    if 'arrayValue' in v: return [valor(x) for x in v['arrayValue'].get('values', [])]
    return None


def doc(d):
    out = {k: valor(v) for k, v in d.get('fields', {}).items()}
    out['_id'] = d['name'].rsplit('/', 1)[1]
    return out


def hoje_sp(agora=None):
    agora = agora or datetime.datetime.now(datetime.timezone.utc)
    return (agora - datetime.timedelta(hours=3)).strftime('%Y-%m-%d')


def na_hora(o, hoje):
    """O aviso já pode sair? (racha com data de cobrança só sai no dia)"""
    q = o.get('quando') or ''
    return not q or q <= hoje


def destinos(o, aprov, avatars):
    """Lista de uids que recebem o aviso `o`.
    aprov: {uid: memberId} dos aprovados; avatars: {uid: {rsvp: {eventId: 'sim'|'nao'}}}."""
    para, autor, ev = o.get('para'), o.get('uid'), o.get('eventId') or ''
    if para == 'todos':
        us = [u for u in aprov if ((avatars.get(u) or {}).get('rsvp') or {}).get(ev) != 'nao']
    elif isinstance(para, list):
        us = [u for u, m in aprov.items() if m in para]
    else:
        us = []
    return sorted(u for u in set(us) if u != autor)


def mensagem(o, token):
    return {'message': {'token': token, 'webpush': {
        'headers': {'Urgency': 'high', 'TTL': '86400'},
        'notification': {'title': o.get('titulo') or 'Eventos dos Bêbados', 'body': o.get('corpo') or '',
                         'icon': LINK + 'icone-192.png', 'badge': LINK + 'icone-192.png', 'tag': o['_id']},
        'fcm_options': {'link': LINK}}}}


def main():
    sa = os.environ.get('FIREBASE_SA', '').strip()
    if not sa:
        print('Segredo FIREBASE_SA não configurado; nada a fazer.')
        return 0
    import requests
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account
    cred = service_account.Credentials.from_service_account_info(
        json.loads(sa), scopes=['https://www.googleapis.com/auth/datastore',
                                'https://www.googleapis.com/auth/firebase.messaging'])
    cred.refresh(Request())
    h = {'Authorization': 'Bearer ' + cred.token}

    def listar(col):
        out, tok = [], None
        while True:
            r = requests.get(f'{DOCS}/{col}', headers=h, params={'pageSize': 300, **({'pageToken': tok} if tok else {})}, timeout=30)
            r.raise_for_status()
            j = r.json()
            out += [doc(d) for d in j.get('documents', [])]
            tok = j.get('nextPageToken')
            if not tok:
                return out

    def apagar(caminho):
        requests.delete(f'{DOCS}/{caminho}', headers=h, timeout=30)

    fila = listar('outbox')
    if not fila:
        print('Fila vazia.')
        return 0
    agora_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    hoje = hoje_sp()
    prontos = []
    for o in fila:
        if not na_hora(o, hoje):
            continue
        if not o.get('quando') and agora_ms - int(o.get('at') or 0) > VELHO_MS:
            apagar('outbox/' + o['_id'])
            continue
        prontos.append(o)
    if not prontos:
        print(f'{len(fila)} aviso(s) aguardando a data.')
        return 0

    aprov = {a['_id']: a.get('memberId') for a in listar('approvals') if a.get('status') == 'aprovado'}
    tokens = {t['_id']: (t.get('t') or {}) for t in listar('tokens')}
    avatars = {a['_id']: a for a in listar('avatars')} if any(o.get('para') == 'todos' for o in prontos) else {}
    enviados = falhas = 0
    for o in prontos:
        for u in destinos(o, aprov, avatars):
            for tk in list(tokens.get(u, {})):
                r = requests.post(FCM, headers=h, json=mensagem(o, tk), timeout=30)
                if r.ok:
                    enviados += 1
                    continue
                falhas += 1
                print('Falha', r.status_code, r.text[:200].replace(tk, '<aparelho>'))
                if r.status_code in (400, 404):  # aparelho que não existe mais: tira do cadastro
                    tokens[u].pop(tk, None)
                    corpo = {'fields': {'t': {'mapValue': {'fields': {k: {'integerValue': str(int(v))} for k, v in tokens[u].items()}}}}}
                    requests.patch(f'{DOCS}/tokens/{u}', headers=h, params={'updateMask.fieldPaths': 't'}, json=corpo, timeout=30)
        apagar('outbox/' + o['_id'])
    print(f'{len(prontos)} aviso(s) processado(s), {enviados} envio(s), {falhas} falha(s).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
