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

  const values = sh.getDataRange().getValues();
  const header = values[0] || [];
  const idx = (k) => header.indexOf(k);

  const iName  = idx('name'),
        iType  = idx('type'),
        iBrewery = idx('brewery'),
        iBurl = idx('breweryUrl'),
        iExh  = idx('exhibitor'),
        iExhId = idx('exhibitorMemberId'), // ★ 追加
        iImg  = idx('img'),
        iDesc = idx('desc'),
        iOrder = idx('order');

  const rows = values.slice(1);

  const items = rows.map(r => ({
    name: String(r[iName] || '').trim(),
    type: String(r[iType] || '').trim(),
    brewery: String(r[iBrewery] || '').trim(),
    breweryUrl: String(r[iBurl] || '').trim(),
    exhibitor: String(r[iExh] || '').trim(),
    exhibitorMemberId: String(r[iExhId] || '').trim(), // ★ 追加
    img: String(r[iImg] || '').trim(),
    desc: String(r[iDesc] || '').trim(),
    order: Number(r[iOrder] || 0),
  })).filter(it => it.name);

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

  // doGet に以下を追加
// /?type=members_full → [{id,name}]
if (type === 'members_full') {
  const r = getMembersFull_();
  return _corsJson(r);}

  // 未知のエンドポイント
  return _corsJson({ ok:false, error:'unknown endpoint', version: VERSION });
}

// ★ 集計/保存側で “銘柄数” を sakes マスタから取得して処理
// Web アプリの POST エンドポイント。投票（スコア）を保存する
function doPost(e) {
  try {
    const lock = LockService.getDocumentLock();
    lock.tryLock(3000);

    const payload = e?.parameter?.payload || '{}';
    const body = JSON.parse(payload);

    const nickname = (body.nickname || '').trim();
    const memberIdFromClient = String(body.memberId || '').trim(); // ★ 追加
    const scores = body.scores || {};

    if (!nickname) return _corsJson({ ok:false, error:'nickname required', version: VERSION });

    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sh) return _corsJson({ ok:false, error:'sheet not found', version: VERSION });

    const master = getSakeMaster_();
    if (!master.ok || master.items.length === 0)
      return _corsJson({ ok:false, error:'sake master empty', version: VERSION });

    const mlen = master.items.length;

    // 送信者の memberId を決定（優先：payload.memberId）
    let senderMemberId = memberIdFromClient;
    if (!senderMemberId) {
      // name から members を引いて解決（同名は想定しない前提）
      const mfull = getMembersFull_();
      if (mfull.ok) {
        const hit = mfull.items.find(x => x.name === nickname);
        if (hit) senderMemberId = hit.id;
      }
    }

    // 自己投票禁止チェック
    if (senderMemberId) {
      // 自分の銘柄にスコアが入っていないか？
      for (let i=0; i<mlen; i++) {
        const key = `s${i}`;
        const val = scores[key];
        const exhibId = String(master.items[i].exhibitorMemberId || '').trim();
        if (exhibId && exhibId === senderMemberId) {
          if (val !== undefined && val !== null && val !== '' && !isNaN(val) && Number(val) > 0) {
            return _corsJson({
              ok:false,
              error:`cannot vote your own entry (index ${i})`,
              version: VERSION
            });
          }
        }
      }
    }

    // ここまでOKなら保存
    const row = [new Date(), nickname];
    for (let i = 0; i < mlen; i++) {
      const key = `s${i}`;
      const v = scores[key];
      row.push((v === undefined || v === null) ? '' : Number(v));
    }
    sh.appendRow(row);

    if (lock.hasLock()) lock.releaseLock();
    return _corsJson({ ok:true, version: VERSION });

  } catch (err) {
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
// members シートから "name" 列だけを返す（列順に依存しない）
function getMembers_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(MEMBERS_SHEET_NAME);
  if (!sh) return { ok:false, members:[], error:'members sheet not found' };

  const values = sh.getDataRange().getValues();
  if (values.length === 0) {
    return { ok:true, members:[], updatedAt: new Date().toISOString() };
  }

  const header = values[0] || [];
  const idx = (k) => header.indexOf(k);

  // ← ここがポイント：ヘッダ名で name 列を探す
  const iName = idx('name');
  if (iName < 0) {
    return { ok:false, members:[], error:'"name" header not found', updatedAt: new Date().toISOString() };
  }

  const rows = values.slice(1);
  const names = [];
  for (const r of rows) {
    const name = String(r[iName] || '').trim();
    if (name) names.push(name);
  }

  // 重複排除
  const uniq = Array.from(new Set(names));

  return { ok:true, members: uniq, updatedAt: new Date().toISOString() };
}

function getMembersFull_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(MEMBERS_SHEET_NAME);
  if (!sh) return { ok:false, items:[], error:'members sheet not found' };

  const values = sh.getDataRange().getValues();
  if (values.length === 0) return { ok:true, items:[], updatedAt:new Date().toISOString() };

  const header = values[0] || [];
  const idx = (k) => header.indexOf(k);
  const iId = idx('memberId');
  const iName = idx('name');
  if (iId < 0 || iName < 0) {
    return { ok:false, items:[], error:'header "memberId" or "name" not found' };
  }

  const rows = values.slice(1);
  const items = rows.map(r => ({
    id: String(r[iId] || '').trim(),
    name: String(r[iName] || '').trim(),
  })).filter(x => x.id && x.name);

  return { ok:true, items, updatedAt:new Date().toISOString() };
}






