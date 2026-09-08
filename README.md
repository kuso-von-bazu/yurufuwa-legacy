# MTG ゆるふわレガシー

レガシーのカードプールをそのまま使い、デッキ75枚の「最安購入価格(晴れる屋基準)」で
1K〜500K級+無差別級に分けて遊ぶフォーマット。主戦場は1K〜5K級(1,000〜5,000円)。ルールは `フォーマット仕様.md`。

公開サイト: https://kuso-von-bazu.github.io/yurufuwa-legacy/

## 階級判定サイト(静的・ビルド不要)

- `起動.bat` → http://localhost:8995/ (`python -m http.server 8995`)
- 3ファイル(index.html / app.js / style.css)+ `data/cards.json`(カード名リスト)
- **検索→選択→登録**でデッキを組む。英名でも日本語名でも途中まで入力でOK。
  Enter=メイン / Shift+Enter=サイド。足した瞬間に価格を取得して合計と階級がライブ更新。
- テキスト貼り付け(アリーナ / Moxfield / 晴れる屋形式)と書き出しも可。デッキはブラウザに自動保存。
- 名寄せ: `data/cards.json`(レガシー適法カードの英名+日本語名+晴れる屋検索名+基本土地フラグ)。
  無い名前だけ Scryfall `cards/named?fuzzy=` に問い合わせ。
- 価格取得はブラウザから直接:
  1. 晴れる屋 `https://www.hareruyamtg.com/ja/products/search/unisearch_api`
     (サイト内部の検索JSON。`Access-Control-Allow-Origin: *`。
     `fq.card_name=英名完全一致 & fq.foil_flg=0 & sort=price asc`。非公式なので仕様変更の可能性あり)
  2. 取扱なし → Scryfall `cards/search` 紙最安USD × 為替(open.er-api.com、24hキャッシュ、手入力可)
- 分割カードは「Fire/Ice」、両面・出来事は表面名で晴れる屋検索
- 価格は localStorage に24hキャッシュ。「価格を取り直す」で無効化

### 出力
- 階級バッジ・合計・内訳(高い順、晴れる屋商品リンク)・レガシー禁止/5枚以上/60枚未満などの警告・
  ひとつ下の階級にするための削減額と候補・残り予算
- 証明コード `YFL1.階級.ハッシュ8.日付.合計.チェック2`、SpellTable用テキスト、共有URL(#deck=…)、配信用オーバーレイPNG
- 検証タブ: 相手のコードの有効期限(30日)/チェック桁/階級と金額の整合、デッキリスト貼付でハッシュ照合

## メンテナンス
- `python 名前リスト更新.py` … 新セット発売後に `data/cards.json` を作り直す(Scryfall、約2分)
- `python 階級判定.py deck.txt …` … 主催者向け一括判定(サイトと同じハッシュ・チェック桁)
- `python 階級判定.py --verify コード [deck.txt]`
- `bash 公開.sh` … GitHub Pages(kuso-von-bazu/yurufuwa-legacy)へ push

## SpellTable との連携について
SpellTable に公開APIは無いので、ゲーム名の先頭に `[ゆるふわ 3K] コード` を書く命名規約と、
サイトの「検証」タブでの照合、OBS用オーバーレイPNGで連携する。
