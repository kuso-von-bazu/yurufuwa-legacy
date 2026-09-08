#!/usr/bin/env python3
"""レガシーで使えるカード名リスト(英名+日本語名)を Scryfall から作って data/cards.json に書く。

  python 名前リスト更新.py

サイトの検索→選択UIはこのファイルだけで動く(オフライン名寄せ)。新セット発売後に実行して再公開する。
"""
import json, time, datetime, urllib.request, urllib.parse, sys, os

SCRYFALL = 'https://api.scryfall.com/cards/search'
UA = 'yurufuwa-legacy-namelist/1.0'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'cards.json')


def fetch_all(q, label):
    url = SCRYFALL + '?' + urllib.parse.urlencode({'q': q, 'unique': 'cards', 'order': 'name'})
    out = []
    page = 1
    while url:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    d = json.loads(r.read().decode('utf-8'))
                break
            except Exception as e:
                print('  retry', attempt, e, file=sys.stderr); time.sleep(2 + attempt * 2)
        else:
            raise SystemExit('取得失敗: ' + url)
        out += d.get('data', [])
        print('\r%s: %d/%d (page %d)' % (label, len(out), d.get('total_cards', 0), page), end='', file=sys.stderr)
        url = d.get('next_page'); page += 1
        time.sleep(0.3)
    print(file=sys.stderr)
    return out


def hareruya_name(c):
    faces = [f['name'] for f in c.get('card_faces', [])]
    if c.get('layout') in ('split', 'aftermath') and faces:
        return '/'.join(faces)
    if faces:
        return faces[0]
    return c['name']


def printed_ja(c):
    """日本語版の印刷名。両面/分割は面ごとの印刷名を '/' で連結。英語のままなら '' (Scryfallのデータ欠け)。"""
    if c.get('lang') != 'ja':
        return ''
    if c.get('printed_name') and c['printed_name'] != c['name']:
        return c['printed_name']
    faces = c.get('card_faces', [])
    names = [f.get('printed_name') or '' for f in faces]
    if faces and any(n and n != f['name'] for n, f in zip(names, faces)):
        return '/'.join(n for n in names if n)
    return ''


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def fix_missing_ja(rows):
    """ja が空のカードを1枚ずつ全印刷から探して補修する(Scryfallの代表印刷に日本語名が無いことがある)。"""
    todo = [r for r in rows if not r[1]]
    fixed = 0
    for i, r in enumerate(todo):
        q = 'lang:ja !"%s"' % r[0].replace('"', '')
        url = SCRYFALL + '?' + urllib.parse.urlencode({'q': q, 'unique': 'prints', 'order': 'released'})
        d = {}
        for attempt in range(3):
            try:
                d = fetch_json(url); break
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break  # 日本語版なし
                print('\n  http %s %s (retry %d)' % (e.code, r[0], attempt), file=sys.stderr); time.sleep(65)
            except Exception as e:
                print('\n  err %s %s (retry %d)' % (e, r[0], attempt), file=sys.stderr); time.sleep(65)
        for c in d.get('data', []):
            ja = printed_ja(c)
            if ja:
                r[1] = ja; fixed += 1; break
        print('\r補修: %d/%d (直った %d)' % (i + 1, len(todo), fixed), end='', file=sys.stderr)
        time.sleep(0.3)
    print(file=sys.stderr)
    return fixed


def main():
    if '--fix' in sys.argv:
        d = json.load(open(OUT, encoding='utf-8'))
        n = fix_missing_ja(d['cards'])
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False, separators=(',', ':'))
        print('補修 %d 件 → %s' % (n, OUT)); return
    cards = {}
    for c in fetch_all('legal:legacy game:paper lang:ja', '日本語版'):
        cards[c['name']] = {'ja': printed_ja(c), 'h': hareruya_name(c), 'b': 1 if (c.get('type_line', '') or '').startswith('Basic') else 0}
    for c in fetch_all('legal:legacy game:paper', '全カード'):
        if c['name'] not in cards:
            cards[c['name']] = {'ja': '', 'h': hareruya_name(c), 'b': 1 if (c.get('type_line', '') or '').startswith('Basic') else 0}
    banned = sorted({c['name'] for c in fetch_all('banned:legacy', '禁止')})
    rows = []
    for name in sorted(cards):
        v = cards[name]
        rows.append([name, v['ja'], v['h'] if v['h'] != name else '', v['b']])
    fix_missing_ja(rows)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'updated': datetime.date.today().isoformat(), 'count': len(rows), 'banned': banned, 'cards': rows},
                  f, ensure_ascii=False, separators=(',', ':'))
    print('書き出し: %s (%d枚, 禁止%d, %.1fMB)' % (OUT, len(rows), len(banned), os.path.getsize(OUT) / 1e6))


if __name__ == '__main__':
    main()
