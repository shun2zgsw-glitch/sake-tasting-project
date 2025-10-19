// ====== 共通: JSONレスポンス ======
// 任意のオブジェクトを JSON 文字列にして HTTP レスポンスとして返すヘルパー
function _corsJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 既存の設定の上に追加
const SAKES_SHEET_NAME = 'sakes';   // 日本酒マスタ（銘柄一覧）を置くシート名
const MEMBERS_SHEET_NAME = 'members'; // 参加メンバー一覧を置くシート名

// 既に使っていればそのまま
const VERSION = 'v3-master+members';

const SHEET_NAME = 'scores'; // ← ★ これを追加（投票データ用タブ名）

// ★ SAKE_NAMES は sakes シートから動的に作る（直書き廃止）
// sakes シートから銘柄マスタを読み出して API 形式で返す内部関数
function getSakeMaster_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SAKES_SHEET_NAME);
  if (!sh) return { ok:false, items:[], error:'sakes sheet not found' };

  // シート全体を 2次元配列で取得
  const values = sh.getDataRange().getValues();

  // 1行目（ヘッダ）を見出しとして扱う
  const header = values[0] || [];
  const idx = (k) => header.indexOf(k); // 見出し名→列インデックスを求める関数

  // 必要列のインデックスをヘッダから取得
  const iName  = idx('name'),
        iType  = idx('type'),
        iBrewery = idx('brewery'),
        iBurl = idx('breweryUrl'),
        iExh  = idx('exhibitor'),
        iImg  = idx('img'),
        iDesc = idx('desc'),
        iOrder = idx('order');

  // データ本体（2行目以降）
  const rows = values.slice(1);

  // 1行＝1銘柄としてオブジェクト化
  const items = rows.map(r => ({
    name: String(r[iName] || '').trim(),
    type: String(r[iType] || '').trim(),
    brewery: String(r[iBrewery] || '').trim(),
    breweryUrl: String(r[iBurl] || '').trim(),
    exhibitor: String(r[iExh] || '').trim(),
    img: String(r[iImg] || '').trim(),
    desc: String(r[iDesc] || '').trim(),
    order: Number(r[iOrder] || 0),
  }))
  .filter(it => it.name); // name が空の行は除外

  // order があれば並べ替え（未指定は大きい数字扱いで後ろへ）
  items.sort((a,b) => (a.order||9999) - (b.order||9999));

  return { ok:true, items, updatedAt: new Date().toISOString() };
}

// doGet: sakes を返す分岐を追加（既存の stats / members は維持）
// Web アプリの GET エンドポイント。type パラメータで機能を切替
function doGet(e) {
  const type = (e.parameter.type || '').toLowerCase();

  // /?type=sakes → 銘柄マスタを返す
  if (type === 'sakes') {
    const r = getSakeMaster_();
    if (!r.ok) return _corsJson({ ok:false, items:[], error:r.error, version: VERSION });
    return _corsJson(r);
  }

  // /?type=members → メンバー一覧を返す
  if (type === 'members') {
    const r = getMembers_();
    if (!r.ok) return _corsJson({ ok:false, members:[], error:r.error, version: VERSION });
    return _corsJson(r);
  }

  // /?type=stats → 集計結果（平均点・件数など）を返す
  if (type === 'stats') {
    return _corsJson(buildStats_());
  }

  // /?ping=1 → 稼働確認
  if (e.parameter.ping === '1') {
    return _corsJson({ ok:true, version: VERSION });
  }

  // 未知のエンドポイント
  return _corsJson({ ok:false, error:'unknown endpoint', version: VERSION });
}

// ★ 集計/保存側で “銘柄数” を sakes マスタから取得して処理
// Web アプリの POST エンドポイント。投票（スコア）を保存する
function doPost(e) {
  try {
    // 同時書き込み衝突を避けるためのロック（最大3秒待ち）
    const lock = LockService.getDocumentLock();
    lock.tryLock(3000);

    // リクエストパラメータ payload を JSON として解釈
    const payload = e?.parameter?.payload || '{}';
    const body = JSON.parse(payload);

    const nickname = (body.nickname || '').trim(); // 投稿者名（ニックネーム）
    const scores = body.scores || {};              // { s0: 7, s1: 10, ... } のような採点マップ

    if (!nickname) return _corsJson({ ok:false, error:'nickname required', version: VERSION });

    // スコア記録用シート（scores タブ）
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sh) return _corsJson({ ok:false, error:'sheet not found', version: VERSION });

    // 銘柄マスタを取得（列数＝銘柄数に合わせて保存列を決めるため）
    const master = getSakeMaster_();
    if (!master.ok || master.items.length === 0)
      return _corsJson({ ok:false, error:'sake master empty', version: VERSION });

    const mlen = master.items.length; // 銘柄数

    // appendRow 用の1行データを組み立てる：[タイムスタンプ, ニックネーム, s0, s1, ...]
    const row = [new Date(), nickname];

    // 銘柄数ぶん、scores から s0, s1, ... を読み出し、数値または空文字を push
    for (let i = 0; i < mlen; i++) {
      const key = `s${i}`; // ← クライアント側のキー名（例: "s0", "s1"...）と対応
      const v = scores[key];
      row.push((v === undefined || v === null) ? '' : Number(v));
    }

    // シート末尾に1行追記
    sh.appendRow(row);

    // ロック開放
    if (lock.hasLock()) lock.releaseLock();

    return _corsJson({ ok:true, version: VERSION });

  } catch (err) {
    // 例外は JSON で返す
    return _corsJson({ ok:false, error:String(err), version: VERSION });
  }
}

// スコアの集計を行い、銘柄ごとの平均点と件数を計算して返す内部関数
function buildStats_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);

  // スコアシートが未作成の場合は、銘柄名だけ返して平均0・件数0で初期化
  if (!sh) {
    const master = getSakeMaster_();
    const names = master.ok ? master.items.map(it => it.name) : [];
    return {
      items: names.map(n => ({ name:n, avg:0, count:0 })),
      updatedAt: new Date().toISOString(),
      version: VERSION
    };
  }

  // スコアデータ全体と、銘柄マスタ（名前配列）を取得
  const values = sh.getDataRange().getValues();
  const master = getSakeMaster_();
  const names = master.ok ? master.items.map(it => it.name) : [];
  const mlen = names.length;

  // データがない（ヘッダのみ等）の場合は初期形で返す
  if (values.length <= 1 || mlen === 0) {
    return {
      items: names.map(n => ({ name:n, avg:0, count:0 })),
      updatedAt: new Date().toISOString(),
      version: VERSION
    };
  }

  // 2行目以降が投票データ：[timestamp, nickname, s0, s1, ...]
  const rows = values.slice(1);

  // 同一ニックネームが複数回投稿している場合、最新の1件のみを有効にする
  const latestByNick = new Map();
  for (const r of rows) {
    const ts = r[0];
    const nick = String(r[1] || '').trim();
    if (!nick) continue;
    const existed = latestByNick.get(nick);
    if (!existed || (existed[0] < ts)) latestByNick.set(nick, r);
  }

  // 銘柄ごとの合計値と件数を用意
  const sum = new Array(mlen).fill(0);
  const cnt = new Array(mlen).fill(0);

  // 最新票のみで集計（s0 は C列＝インデックス2）
  for (const r of latestByNick.values()) {
    for (let i = 0; i < mlen; i++) {
      const v = r[2 + i]; // s0 がC列
      if (v !== '' && v !== null && v !== undefined && !isNaN(v)) {
        sum[i] += Number(v);
        cnt[i] += 1;
      }
    }
  }

  // 平均（avg）と件数（count）を算出し、平均→件数の降順で並べ替え
  const items = names.map((name, i) => ({
    name,
    avg: cnt[i] ? (sum[i] / cnt[i]) : 0,
    count: cnt[i]
  }))
  .sort((a,b) => b.avg - a.avg || b.count - a.count);

  return {
    items,
    updatedAt: new Date().toISOString(),
    version: VERSION
  };
}

// 追加：membersシートから名前一覧を取り出す
// members シート（A列：名前、1行目はヘッダ）から重複なしのメンバー名配列を作る
function getMembers_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(MEMBERS_SHEET_NAME);
  if (!sh) return { ok:false, members:[], error:'members sheet not found' };

  const values = sh.getDataRange().getValues(); // 2次元配列
  const rows = values.slice(1); // 1行目はヘッダ想定

  const names = [];
  for (const r of rows) {
    const name = String(r[0] || '').trim(); // A列
    if (name) names.push(name);
  }

  // 重複除去
  const uniq = Array.from(new Set(names));

  return { ok:true, members: uniq, updatedAt: new Date().toISOString() };
}
