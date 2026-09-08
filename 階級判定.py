#!/usr/bin/env python3
"""ゆるふわレガシー 階級判定 CLI(主催者向け・複数デッキの一括判定用)

使い方:
  python 階級判定.py deck.txt [deck2.txt ...]   # 各ファイルを判定して証明コードを出す
  python 階級判定.py --verify YFL1.3K.XXXXXXXX.20260908.2860.K7 [deck.txt]

サイト(app.js)と同じ規則・同じハッシュ・同じチェック桁を使う。stdlib のみ。
"""
import json, re, sys, time, datetime, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

VERSION = 'YFL1'
TIERS = [('1K', 'こんぺいとう', 1000), ('2K', 'ラムネ', 2000), ('3K', 'グミ', 3000), ('4K', 'キャラメル', 4000),
         ('5K', 'わたあめ', 5000), ('10K', 'マシュマロ', 10000), ('30K', 'ぷりん', 30000), ('60K', 'ドーナツ', 60000),
         ('120K', 'ショートケーキ', 120000), ('250K', 'パフェ', 250000), ('500K', 'ホールケーキ', 500000),
         ('X', 'レガシー', float('inf'))]
GRACE = 1.10
VALID_DAYS = 30
HARERUYA_API = 'https://www.hareruyamtg.com/ja/products/search/unisearch_api'
SCRYFALL = 'https://api.scryfall.com'
RATE_API = 'https://open.er-api.com/v6/latest/USD'
UA = 'yurufuwa-legacy-cli/1.0'


def http_json(url, data=None):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': 'application/json',
                                                          'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


# ---------- デッキ解析(app.js と同等) ----------
def parse_decklist(text):
    main, side = [], []
    cur = main
    saw_main = False
    for raw in text.replace('\r', '').split('\n'):
        line = raw.strip()
        if not line:
            if saw_main and cur is main:
                cur = side
            continue
        if re.match(r'^(sideboard|side|sb|サイドボード|サイド)\s*[:：]?$', line, re.I) or re.match(r'^//\s*sideboard', line, re.I):
            cur = side; continue
        if re.match(r'^(deck|main|maindeck|mainboard|メイン|メインデッキ|メインボード)\s*[:：]?$', line, re.I):
            cur = main; continue
        if re.match(r'^(commander|companion|統率者|相棒)\s*[:：]?$', line, re.I) or re.match(r'^(//|#)', line):
            continue
        target, body = cur, line
        if re.match(r'^SB:\s*', body, re.I):
            target = side; body = re.sub(r'^SB:\s*', '', body, flags=re.I)
        m = re.match(r'^(\d+)\s*[xX×]?\s+(.+)$', body)
        if m:
            qty, name = int(m.group(1)), m.group(2)
        else:
            m = re.match(r'^(.+?)\s*[xX×]\s*(\d+)$', body)
            if m:
                qty, name = int(m.group(2)), m.group(1)
            else:
                qty, name = 1, body
        jp = re.search(r'《([^》]*)》', name)
        if jp:
            sl = jp.group(1).split('/')
            name = '/'.join(sl[1:]).strip() if len(sl) > 1 else jp.group(1).strip()
        name = re.sub(r'\s+\([A-Za-z0-9]{2,6}\)\s*[\w★☆-]*\s*$', '', name)
        name = re.sub(r'\s*\*F\*\s*$', '', name, flags=re.I)
        name = re.sub(r'\s+#\d+$', '', name)
        name = re.sub(r'\s+\[[^\]]*\]$', '', name).strip()
        if name:
            target.append((qty, name))
            saw_main = True
    return main, side


# ---------- Scryfall 名寄せ ----------
def slim(c):
    return {'name': c['name'], 'layout': c.get('layout'), 'type_line': c.get('type_line', ''),
            'faces': [f['name'] for f in c.get('card_faces', [])], 'legacy': c.get('legalities', {}).get('legacy')}


def resolve(names):
    out = {}
    for i in range(0, len(names), 75):
        chunk = names[i:i + 75]
        body = json.dumps({'identifiers': [{'name': n.split('//')[0].strip()} for n in chunk]}).encode()
        try:
            d = http_json(SCRYFALL + '/cards/collection', body)
        except Exception as e:
            print('collection失敗', e, file=sys.stderr); d = {}
        by = {}
        for c in d.get('data', []):
            s = slim(c); by[c['name'].lower()] = s
            for f in s['faces']:
                by[f.lower()] = s
        for n in chunk:
            s = by.get(n.split('//')[0].strip().lower())
            if s:
                out[n] = s
        time.sleep(0.12)
    for n in names:
        if n in out:
            continue
        try:
            out[n] = slim(http_json(SCRYFALL + '/cards/named?fuzzy=' + urllib.parse.quote(n)))
        except Exception:
            pass
        time.sleep(0.11)
    return out


# ---------- 価格 ----------
def hareruya_name(c):
    if c['layout'] in ('split', 'aftermath'):
        return '/'.join(c['faces'])
    return c['faces'][0] if c['faces'] else c['name']


def price_hareruya(c):
    url = HARERUYA_API + '?fq.card_name=' + urllib.parse.quote(hareruya_name(c)) + '&fq.foil_flg=0&fq.price=1%7E%2A&sort=price+asc&rows=60'
    d = http_json(url)
    docs = [x for x in d.get('response', {}).get('docs', [])
            if x.get('foil_flg') == '0' and int(x.get('price', 0)) > 0
            and not re.search(r'傷|Damaged|プレイド|PLD', x.get('product_name', ''), re.I)
            and not re.search(r'【アート・カード】|トークン|プレイマット', x.get('product_name', ''))]
    if not docs:
        return None
    ins = [x for x in docs if int(x['stock']) > 0]
    pick = min(ins or docs, key=lambda x: int(x['price']))
    return {'price': int(pick['price']), 'product': pick['product'], 'pname': pick['product_name'],
            'stock': int(pick['stock']), 'src': 'hareruya' if ins else 'hareruya-nostock'}


def price_scryfall(c, rate):
    q = '!"%s" game:paper' % c['name'].replace('"', '')
    d = http_json(SCRYFALL + '/cards/search?q=' + urllib.parse.quote(q) + '&unique=prints&order=usd&dir=asc')
    for x in d.get('data', []):
        if x.get('prices', {}).get('usd'):
            return {'price': -(-float(x['prices']['usd']) * rate // 1), 'src': 'scryfall', 'usd': x['prices']['usd']}
    return None


def get_rate():
    try:
        return float(http_json(RATE_API)['rates']['JPY']), 'open.er-api.com'
    except Exception:
        return 150.0, '既定値'


def price_card(c, rate):
    if c['type_line'].startswith('Basic'):
        return {'price': 0, 'src': 'basic'}
    try:
        r = price_hareruya(c)
        if r:
            return r
    except Exception as e:
        print('晴れる屋失敗', c['name'], e, file=sys.stderr)
    try:
        r = price_scryfall(c, rate)
        if r:
            return r
    except Exception:
        pass
    return {'price': None, 'src': 'none'}


# ---------- 階級・ハッシュ・コード(app.js と同一) ----------
def tier_for(total, grace=True):
    for k, name, mx in TIERS:
        if total <= mx:
            return (k, name, mx), False
        if grace and total <= mx * GRACE:
            return (k, name, mx), True
    return TIERS[-1], False


def fnv1a(s, seed):
    h = seed & 0xFFFFFFFF
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'


def to_b32(nums, length):
    bits = ''.join(format(n, '032b') for n in nums)
    out = ''
    for i in range(0, len(bits) - 4, 5):
        if len(out) >= length:
            break
        out += B32[int(bits[i:i + 5], 2)]
    return out


def deck_hash(entries):  # entries: [(name, qty, is_side)]
    items = []
    for name, qty, side in entries:
        items += [('sb:' if side else '') + name.lower()] * qty
    items.sort()
    s = '\n'.join(items)
    return to_b32([fnv1a(s, 2166136261), fnv1a(s, 0x9747b28c)], 8)


def checksum(s):
    return to_b32([fnv1a(s, 0x811c9dc5 ^ 0x5bd1e995)], 2)


def make_code(tier_k, h, date_str, total):
    body = '.'.join([VERSION, tier_k, h, date_str, str(int(round(total)))])
    return body + '.' + checksum(body)


def parse_code(code):
    p = code.strip().upper().split('.')
    if len(p) != 6 or p[0] != VERSION:
        return None, '形式が違います'
    if checksum('.'.join(p[:5])) != p[5]:
        return None, 'チェック桁が一致しません'
    t = next((x for x in TIERS if x[0] == p[1]), None)
    if not t or not re.match(r'^\d{8}$', p[3]):
        return None, '階級または日付が不正です'
    d = datetime.date(int(p[3][:4]), int(p[3][4:6]), int(p[3][6:]))
    age = (datetime.date.today() - d).days
    return {'tier': t, 'hash': p[2], 'date': d, 'total': int(p[4]), 'age': age, 'valid': 0 <= age <= VALID_DAYS}, None


# ---------- 実行 ----------
def judge_file(path, grace=True):
    text = open(path, encoding='utf-8').read()
    main, side = parse_decklist(text)
    names = list(dict.fromkeys(n for _, n in main + side))
    cards = resolve(names)
    rate, rate_src = get_rate()
    uniq = {c['name']: c for c in cards.values()}
    with ThreadPoolExecutor(max_workers=3) as ex:
        prices = dict(zip(uniq.keys(), ex.map(lambda c: price_card(c, rate), uniq.values())))
    rows, total, entries, warns = [], 0, [], []
    for lst, is_side in ((main, False), (side, True)):
        for qty, n in lst:
            c = cards.get(n)
            if not c:
                warns.append('不明: ' + n); rows.append((n, qty, is_side, None, 0, 'unknown')); continue
            p = prices[c['name']]
            if c['legacy'] == 'banned':
                warns.append('レガシー禁止: ' + c['name'])
            elif c['legacy'] not in ('legal', 'restricted'):
                warns.append('レガシー使用不可: ' + c['name'])
            if p['price'] is None:
                warns.append('価格なし: ' + c['name'])
            sub = (p['price'] or 0) * qty
            total += sub
            rows.append((c['name'], qty, is_side, p['price'], sub, p['src']))
            entries.append((c['name'], qty, is_side))
    (k, name, mx), used_grace = tier_for(total, grace)
    h = deck_hash(entries)
    date_str = datetime.date.today().strftime('%Y%m%d')
    code = make_code(k, h, date_str, total)
    print('=' * 60)
    print(path)
    print('階級: %s級 %s  合計 %s円%s  (上限 %s)' % (k, name, format(int(total), ','), ' [猶予10%内]' if used_grace else '',
                                              '∞' if mx == float('inf') else format(mx, ',')))
    print('証明コード: ' + code)
    print('SpellTable: [ゆるふわ %s] %s' % (k, code))
    print('為替 %.1f (%s)  メイン%d枚 サイド%d枚' % (rate, rate_src, sum(q for q, _ in main), sum(q for q, _ in side)))
    for w in warns:
        print('  ! ' + w)
    for n, qty, is_side, unit, sub, src in sorted(rows, key=lambda r: -r[4]):
        print('  %s%-42s %2d x %8s = %9s  %s' % ('SB ' if is_side else '   ', n[:42], qty, '?' if unit is None else format(int(unit), ','), format(int(sub), ','), src))
    return code


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__); return
    grace = '--no-grace' not in args
    args = [a for a in args if a != '--no-grace']
    if args[0] == '--verify':
        r, err = parse_code(args[1])
        if err:
            print('無効: ' + err); sys.exit(1)
        print('%s級 %s / 合計 %s円 / 判定日 %s (%d日前) / ハッシュ %s / %s' % (
            r['tier'][0], r['tier'][1], format(r['total'], ','), r['date'], r['age'], r['hash'], '有効' if r['valid'] else '期限切れ'))
        if len(args) > 2:
            main_, side_ = parse_decklist(open(args[2], encoding='utf-8').read())
            cards = resolve(list(dict.fromkeys(n for _, n in main_ + side_)))
            entries = [(cards[n]['name'], q, s) for lst, s in ((main_, False), (side_, True)) for q, n in lst if n in cards]
            h = deck_hash(entries)
            print('デッキリストのハッシュ %s → %s' % (h, '一致' if h == r['hash'] else '不一致'))
        return
    for path in args:
        judge_file(path, grace)


if __name__ == '__main__':
    main()
