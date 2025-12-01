// ============================
// 要素参照
// ============================
const nicknameEl = document.getElementById('nickname');
const listEl = document.getElementById('sake-list');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const refreshBtn = document.getElementById('refreshBtn');
const msgEl = document.getElementById('msg');
const rankingEl = document.getElementById('ranking');
const metaEl = document.getElementById('meta');

// ============================
// 状態
// ============================
let SAKE_DATA = []; // 銘柄マスタ
const currentScores = {}; // key: s{idx} -> number
let eventsBound = false; // 二重イベント防止
const FETCH_TIMEOUT = 12000; // 固定タイムアウト（ms）
let visualSelectedIndex = null; // ビジュアル投票の単一選択
let VOTE_OPEN = true; // 受付状態（settingsで上書き）

// ============================
// ユーティリティ
// ============================
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function withTimeout(promise, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return Promise.race([
    promise(ctrl.signal),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), ms + 10)
    ),
  ]).finally(() => clearTimeout(t));
}

function setBusy(el, busy) {
  if (!el) return;
  el.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// 設定の取得とUI反映（取得失敗時のポリシー：受付中扱い）
async function loadVoteStatusAndApply() {
  try {
    const d = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=settings`, {
        cache: 'no-store',
        signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    VOTE_OPEN =
      String(d?.settings?.voteOpen ?? 'TRUE')
        .trim()
        .toUpperCase() === 'TRUE';
  } catch (e) {
    console.warn('settings load failed', e);
    VOTE_OPEN = true; // 必要なら false に変更可
  }
  applyVoteOpenUI();
}

function applyVoteOpenUI() {
  if (!VOTE_OPEN) {
    msgEl.textContent =
      '現在、投票受付は締め切られています。受付期間外のため送信できません。';
    sendBtn.disabled = true;
    sendBtn.setAttribute('aria-busy', 'false');
  } else {
    // 受付中に戻ったら、締切りメッセージだけ消す
    if (msgEl.textContent.includes('締め切られています')) {
      msgEl.textContent = '';
    }
    updateSendButtonState();
  }
}

// ============================
// データ取得
// ============================
async function fetchSakeMaster() {
  return withTimeout(async (signal) => {
    const res = await fetch(`${window.GAS_API_URL}?type=sakes`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); // { ok, items }
    if (!data.ok) throw new Error(data.error || 'failed to load sakes');
    SAKE_DATA = Array.isArray(data.items) ? data.items : [];
  });
}

async function populateMembers() {
  const sel = nicknameEl;
  return withTimeout(async (signal) => {
    const res = await fetch(`${window.GAS_API_URL}?type=members_full`, {
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); // { ok, items:[{id,name}] }
    sel.innerHTML = '';
    sel.appendChild(new Option('選択してください', '', true, false));
    if (data.ok && Array.isArray(data.items)) {
      data.items.forEach(({ id, name }) => {
        const opt = new Option(name, id); // 値=memberId
        opt.dataset.name = name; // 表示名も保持
        sel.appendChild(opt);
      });
    } else {
      sel.appendChild(new Option('メンバー取得に失敗', '', true, false));
    }
  });
}

async function fetchStats() {
  setBusy(rankingEl, true);
  try {
    const data = await withTimeout(async (signal) => {
      const res = await fetch(`${window.GAS_API_URL}?type=stats`, {
        method: 'GET',
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json(); // { items, updatedAt }
    });
    renderRanking(data);
  } catch (e) {
    console.error(e);
    metaEl.textContent =
      '集計の取得に失敗しました。時間をおいて再試行してください。';
  } finally {
    setBusy(rankingEl, false);
  }
}

// ============================
// 描画
// ============================
function renderInputs() {
  listEl.innerHTML = '';
  setBusy(listEl, true);

  const frag = document.createDocumentFragment();

  (SAKE_DATA || []).forEach((it, idx) => {
    const key = `s${idx}`;

    const rawImg = it.img || '';
    let imgSrc = rawImg;

    if (rawImg) {
      if (/^https?:\/\//.test(rawImg)) {
        // http / https ならそのまま
        imgSrc = rawImg;
      } else if (rawImg.startsWith('/')) {
        // すでに /images/... みたいなルート相対ならそのまま
        imgSrc = rawImg;
      } else {
        // images/xxx.jpg など相対パスの場合は、vote/ から見たパスにする
        imgSrc = '../' + rawImg.replace(/^\/+/, '');
      }
    }

    const wrap = document.createElement('div');
    wrap.className = 'item';
    wrap.dataset.index = String(idx);

    wrap.innerHTML = `
      <img class="thumb"
           src="${esc(imgSrc)}"
           alt="${esc(it.name || '')}"
           loading="lazy"
           decoding="async">
      <div class="body">
        <h3>${idx + 1}. ${esc(it.name || '')}</h3>
        <div class="meta-row">
          ${it.type ? `<span class="pill">【${esc(it.type)}】</span>` : ''}
          ${
            it.brewery
              ? it.breweryUrl
                ? `<a href="${esc(
                    it.breweryUrl
                  )}" class="pill link" target="_blank" rel="noopener noreferrer">${esc(
                    it.brewery
                  )}</a>`
                : `<span class="pill">${esc(it.brewery)}</span>`
              : ''
          }
          ${
            it.exhibitor
              ? `<span class="pill">出品者：${esc(it.exhibitor)}</span>`
              : ''
          }
        </div>

        <p class="desc clamp" data-desc="${key}">
            ${
              it.blur
                ? `<span class="clear">${esc(it.desc || '').slice(
                    0,
                    20
                  )}</span><span class="blurred">${esc(it.desc || '').slice(
                    20
                  )}</span>`
                : esc(it.desc || '')
            }
        </p>
        <button class="more-btn" type="button" data-more="${key}">続きを読む</button>

        <div class="star-row" data-row="${key}">
          <div class="stars" role="radiogroup" aria-label="${esc(
            it.name || ''
          )} の評価（0〜10）"></div>
          <div class="scale-labels" aria-hidden="true">
            <span class="label-min">1</span>
            <span class="label-mid">5</span>
            <span class="label-max">10</span>
          </div>
        </div>

        <div class="clear-wrap">
          <button class="clear-mini" type="button" data-clear="${key}" aria-label="この銘柄の評価をクリア">クリア</button>
        </div>
      </div>
    `;

    // 星10個
    const starsBox = wrap.querySelector('.stars');
    for (let v = 1; v <= 10; v++) {
      const span = document.createElement('span');
      span.className = 'star';
      span.setAttribute('role', 'radio');
      span.setAttribute('tabindex', '0');
      span.dataset.key = key;
      span.dataset.value = String(v);
      span.setAttribute('aria-label', `${v} 点`);
      span.textContent = '★';
      starsBox.appendChild(span);
    }

    // 画像クリックでビジュアル選択（単一）
    const img = wrap.querySelector('.thumb');
    img.addEventListener('click', () => {
      const memberId = (nicknameEl.value || '').trim();
      if (
        memberId &&
        String(SAKE_DATA[idx].exhibitorMemberId || '') === memberId
      ) {
        msgEl.textContent = '出品者はビジュアル投票できません。';
        return;
      }
      visualSelectedIndex = visualSelectedIndex === idx ? null : idx;
      updateVisualSelectionUI();
      updateSendButtonState();
    });

    frag.appendChild(wrap);
  });

  listEl.appendChild(frag);
  currentScoresReset();
  setBusy(listEl, false);

  if (!eventsBound) {
    listEl.addEventListener('click', onStarsClick);
    listEl.addEventListener('keydown', onStarsKeydown);
    listEl.addEventListener('click', onClearMini);
    listEl.addEventListener('click', onMoreToggle);
    eventsBound = true;
  }

  applySelfVoteDisable(); // 自己銘柄の星UI無効化
  updateVisualSelectionUI();
}

// 選択見た目（inline styleで最小実装）
function updateVisualSelectionUI() {
  listEl.querySelectorAll('.item').forEach((item) => {
    const idx = Number(item.dataset.index || -1);
    const selected = visualSelectedIndex === idx;
    item.style.border = selected ? '2px solid var(--primary)' : '';
    item.style.boxShadow = selected ? '0 0 0 2px rgba(26,115,232,0.12)' : '';
  });
}

function renderRanking({ items = [], updatedAt = '' } = {}) {
  rankingEl.innerHTML = '';

  if (!items.length) {
    rankingEl.innerHTML = `<li>まだ集計データがありません</li>`;
  } else {
    const top3 = items.filter((it) => it.count > 0).slice(0, 3);
    if (!top3.length) {
      rankingEl.innerHTML = `<li>まだ投票がありません</li>`;
    } else {
      const frag = document.createDocumentFragment();
      top3.forEach((it, i) => {
        const li = document.createElement('li');
        const medal = ['🥇', '🥈', '🥉'][i] || '';
        li.innerHTML = `
          ${medal} <strong>${esc(it.name)}</strong>
          — 平均 <strong>${Number(it.avg).toFixed(2)}</strong> 点（${
          it.count
        }票）
        `;
        frag.appendChild(li);
      });
      rankingEl.appendChild(frag);
    }
  }

  metaEl.textContent = updatedAt
    ? `最終更新: ${new Date(updatedAt).toLocaleString()}`
    : '';
}

function hasVisualVote() {
  return visualSelectedIndex !== null;
}

// ============================
// イベントハンドラ
// ============================
function onMoreToggle(e) {
  const btn = e.target.closest('[data-more]');
  if (!btn) return;
  const key = btn.dataset.more;
  const p = listEl.querySelector(`[data-desc="${key}"]`);
  if (!p) return;

  const isClamped = p.classList.contains('clamp');
  p.classList.toggle('clamp', !isClamped);
  btn.textContent = isClamped ? '閉じる' : '続きを読む';
}

function currentScoresReset() {
  (SAKE_DATA || []).forEach((_, idx) => (currentScores[`s${idx}`] = 0));
  updateAllStarsUI();
  updateSendButtonState();
}

function onClearMini(e) {
  const btn = e.target.closest('[data-clear]');
  if (!btn) return;
  const key = btn.dataset.clear;
  currentScores[key] = 0;
  updateStarsUI(key);
  updateSendButtonState();
  msgEl.textContent = '入力をリセットしました。';
}

function onStarsClick(e) {
  const star = e.target.closest('.star');
  if (!star) return;
  const key = star.dataset.key;
  const value = Number(star.dataset.value);
  currentScores[key] = currentScores[key] === value ? 0 : value; // 同値で0に
  updateStarsUI(key);
  updateSendButtonState();
}

function onStarsKeydown(e) {
  const star = e.target.closest('.star');
  if (!star) return;
  const key = star.dataset.key;
  let v = currentScores[key];
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    v = Math.min(10, v + 1);
    e.preventDefault();
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    v = Math.max(0, v - 1);
    e.preventDefault();
  }
  currentScores[key] = v;
  updateStarsUI(key);
  updateSendButtonState();
}

function updateAllStarsUI() {
  (SAKE_DATA || []).forEach((_, idx) => updateStarsUI(`s${idx}`));
}

function updateStarsUI(key) {
  const v = currentScores[key] || 0;
  const row = listEl.querySelector(`[data-row="${key}"]`);
  if (!row) return;
  row.querySelectorAll('.star').forEach((el) => {
    const val = Number(el.dataset.value);
    const checked = val === v && v > 0;
    el.classList.toggle('active', val <= v && v > 0);
    el.setAttribute('aria-checked', String(checked));
  });
}

function hasAnyScore() {
  return Object.values(currentScores).some((v) => v > 0);
}

function updateSendButtonState() {
  const nickname = (nicknameEl.value || '').trim();
  const canSendCore = Boolean(nickname) && (hasAnyScore() || hasVisualVote());
  sendBtn.disabled = !VOTE_OPEN || !canSendCore; // 締切なら常に無効
}

// ============================
// 送信
// ============================
async function handleSend() {
  // 直前に受付状態を再確認（サーバ優先）
  try {
    const d = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=settings`, {
        cache: 'no-store',
        signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    const open =
      String(d?.settings?.voteOpen ?? 'TRUE')
        .trim()
        .toUpperCase() === 'TRUE';
    if (!open) {
      msgEl.textContent =
        '現在、投票受付は締め切られています。受付期間外のため送信できません。';
      sendBtn.disabled = true;
      return;
    }
  } catch (err) {
    console.error('設定の取得に失敗しました:', err);
    // 取得に失敗した場合はサーバ側の検証に委ねて続行
  }

  // 入力バリデーション（採点 or ビジュアル）
  const memberId = (nicknameEl.value || '').trim();
  const nickname = nicknameEl.selectedOptions[0]?.dataset?.name || '';
  if (!memberId) {
    msgEl.textContent = '参加者を選択してください。';
    nicknameEl.focus();
    return;
  }
  if (!hasAnyScore() && !hasVisualVote()) {
    msgEl.textContent = '採点またはビジュアル投票を行ってください。';
    return;
  }

  // ペイロード作成
  const scores = {};
  for (const [k, v] of Object.entries(currentScores)) {
    if (v > 0) scores[k] = v;
  }
  const payload = { nickname, memberId, scores };
  if (hasVisualVote()) {
    payload.visual = { sakeIndex: visualSelectedIndex };
  }

  // 送信
  sendBtn.disabled = true;
  sendBtn.setAttribute('aria-busy', 'true');
  msgEl.textContent = '送信中...';

  try {
    const form = new URLSearchParams();
    form.append('payload', JSON.stringify(payload));

    const { ok, status, json, text } = await withTimeout(async (signal) => {
      const res = await fetch(window.GAS_API_URL, {
        method: 'POST',
        body: form,
        signal,
      });
      const t = await res.text();
      let j;
      try {
        j = JSON.parse(t);
      } catch {}
      return { ok: res.ok, status: res.status, json: j, text: t };
    });

    if (ok && json?.ok) {
      msgEl.textContent = '送信しました。最新の集計を反映します。';
      await fetchStats();
      // 成功後の後片付け
      visualSelectedIndex = null;
      updateVisualSelectionUI();
      currentScoresReset();
    } else {
      const err = String(json?.error || text || '').toLowerCase();
      if (err.includes('voting closed')) {
        msgEl.textContent =
          '現在、投票受付は締め切られています。受付期間外のため送信できません。';
        sendBtn.disabled = true;
      } else if (err.includes('nickname required')) {
        msgEl.textContent = '参加者を選択してください。';
      } else if (err.includes('sheet not found')) {
        msgEl.textContent =
          'スプレッドシートが見つかりません。管理者に連絡してください。';
      } else {
        msgEl.textContent = `送信に失敗しました（${status}）：${
          json?.error ?? text ?? ''
        }`;
      }
    }
  } catch (err) {
    console.error(err);
    msgEl.textContent =
      '通信エラーが発生しました。ネットワークをご確認ください。';
  } finally {
    sendBtn.disabled = false;
    sendBtn.setAttribute('aria-busy', 'false');
    updateSendButtonState(); // 受付状態と入力状況を再計算
  }
}

// ============================
// 参加者セレクト連動
// ============================
const nicknameConfirmEl = document.getElementById('nicknameConfirm');
const selectedNameEl = document.getElementById('selectedName');

function syncNicknameSelects() {
  // 上部のセレクト内容を下部にコピー
  nicknameConfirmEl.innerHTML = nicknameEl.innerHTML;

  // 双方向の連動
  nicknameEl.addEventListener('change', () => {
    const id = nicknameEl.value;
    const name = nicknameEl.selectedOptions[0]?.dataset?.name || '';
    if (nicknameConfirmEl) nicknameConfirmEl.value = id;
    if (selectedNameEl) selectedNameEl.textContent = name || '未選択';
    updateSendButtonState();
    applySelfVoteDisable();
  });

  nicknameConfirmEl?.addEventListener('change', () => {
    const id = nicknameConfirmEl.value;
    const opt = Array.from(nicknameEl.options).find((o) => o.value === id);
    nicknameEl.value = id;
    const name = opt?.dataset?.name || '';
    if (selectedNameEl) selectedNameEl.textContent = name || '未選択';
    updateSendButtonState();
    applySelfVoteDisable();
  });
}

function applySelfVoteDisable() {
  const memberId = (nicknameEl.value || '').trim();
  // いったん全解除
  listEl.querySelectorAll('.item').forEach((item) => {
    item.style.opacity = '';
    item.style.pointerEvents = '';
    item
      .querySelectorAll('.star')
      .forEach((s) => s.setAttribute('aria-disabled', 'false'));
    item.removeAttribute('data-self-disabled');
    const img = item.querySelector('.thumb');
    if (img) img.style.pointerEvents = ''; // 画像クリックも戻す
  });

  if (!memberId) return;

  (SAKE_DATA || []).forEach((it, idx) => {
    if (String(it.exhibitorMemberId || '') === memberId) {
      const key = `s${idx}`;
      const row = listEl.querySelector(`[data-row="${key}"]`);
      const card = row?.closest('.item');
      if (!card) return;

      card.style.opacity = '0.6';
      row.style.pointerEvents = 'none';
      card.setAttribute('data-self-disabled', 'true');
      row
        .querySelectorAll('.star')
        .forEach((s) => s.setAttribute('aria-disabled', 'true'));

      // 画像クリックも不可
      const img = card.querySelector('.thumb');
      if (img) img.style.pointerEvents = 'none';

      // 既に選択していたら解除
      if (visualSelectedIndex === idx) {
        visualSelectedIndex = null;
        updateVisualSelectionUI();
      }

      currentScores[key] = 0;
      updateStarsUI(key);
      card
        .querySelector('.desc')
        ?.setAttribute('title', '出品者は自己投票できません');
    }
  });

  updateSendButtonState();
}

// ============================
// 起動
// ============================
function bindTopLevelEvents() {
  nicknameEl.addEventListener('change', updateSendButtonState);
  sendBtn.addEventListener('click', handleSend);
  clearBtn.addEventListener('click', () => {
    currentScoresReset();
    msgEl.textContent = '全ての評価をリセットしました。';
  });
  refreshBtn.addEventListener('click', fetchStats);
}

async function init() {
  setBusy(listEl, true);
  setBusy(rankingEl, true);

  try {
    await Promise.all([fetchSakeMaster(), populateMembers(), fetchStats()]);
    syncNicknameSelects();
    renderInputs();
    bindTopLevelEvents();
    await loadVoteStatusAndApply(); // 受付状態を取得してUI反映
    // 受付中のときのみ初期メッセージを消す（締切り表示は残す）
    if (VOTE_OPEN) msgEl.textContent = '';
  } catch (e) {
    console.error(e);
    msgEl.textContent =
      '銘柄データの読み込みに失敗しました。リロードしてください。';
  } finally {
    setBusy(listEl, false);
    setBusy(rankingEl, false);
  }
}

init();
