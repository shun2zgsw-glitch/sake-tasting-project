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

// ============================
// データ取得
// ============================
async function fetchSakeMaster() {
  return withTimeout(async (signal) => {
    const res = await fetch(`${window.GAS_API_URL}?type=sakes`, { signal });
    const data = await res.json(); // { ok, items }
    if (!data.ok) throw new Error(data.error || 'failed to load sakes');
    SAKE_DATA = Array.isArray(data.items) ? data.items : [];
  });
}

async function populateMembers() {
  const sel = nicknameEl;
  return withTimeout(async (signal) => {
    const res = await fetch(`${window.GAS_API_URL}?type=members`, { signal });
    const data = await res.json(); // { ok, members }
    sel.innerHTML = '';
    sel.appendChild(new Option('選択してください', '', true, false));
    if (data.ok && Array.isArray(data.members)) {
      // アルファベット順 or そのまま。必要なら sort してください
      data.members.forEach((name) => sel.appendChild(new Option(name, name)));
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

    const wrap = document.createElement('div');
    wrap.className = 'item';
    wrap.innerHTML = `
      <img class="thumb"
           src="${esc(it.img || '')}"
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

        <p class="desc clamp" data-desc="${key}">${esc(it.desc || '')}</p>
        <button class="more-btn" type="button" data-more="${key}">続きを読む</button>

        <!-- 星の行：右側に1/5/10目盛 -->
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

        <!-- クリアは星の下・左寄せ -->
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

    frag.appendChild(wrap);
  });

  listEl.appendChild(frag);
  currentScoresReset();
  setBusy(listEl, false);

  if (!eventsBound) {
    // デリゲーション（1回だけ）
    listEl.addEventListener('click', onStarsClick);
    listEl.addEventListener('keydown', onStarsKeydown);
    listEl.addEventListener('click', onClearMini);
    listEl.addEventListener('click', onMoreToggle);
    eventsBound = true;
  }
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
  const canSend = Boolean(nickname) && hasAnyScore();
  sendBtn.disabled = !canSend;
}

// ============================
// 送信
// ============================
async function handleSend() {
  const nickname = (nicknameEl.value || '').trim();
  if (!nickname) {
    msgEl.textContent = '参加者を選択してください。';
    nicknameEl.focus();
    return;
  }
  if (!hasAnyScore()) {
    msgEl.textContent = '1つ以上の銘柄に採点してください。';
    return;
  }

  const scores = {};
  for (const [k, v] of Object.entries(currentScores)) {
    if (v > 0) scores[k] = v;
  }
  const payload = { nickname, scores };

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
    } else {
      msgEl.textContent = `送信に失敗しました（${status}）：${
        json?.error ?? text ?? ''
      }`;
    }
  } catch (err) {
    console.error(err);
    msgEl.textContent =
      '通信エラーが発生しました。ネットワークをご確認ください。';
  } finally {
    sendBtn.disabled = false;
    sendBtn.setAttribute('aria-busy', 'false');
  }
}

// ============================
// 参加者セレクト連動
// ============================

// 下部セレクトと表示欄を取得
const nicknameConfirmEl = document.getElementById('nicknameConfirm');
const selectedNameEl = document.getElementById('selectedName');

// 上部の populateMembers() 実行後に呼ばれるようにする関数
function syncNicknameSelects() {
  // 上部のセレクト内容を下部にコピー
  nicknameConfirmEl.innerHTML = nicknameEl.innerHTML;

  // 双方向の連動イベントを設定
  nicknameEl.addEventListener('change', () => {
    const selected = nicknameEl.value;
    nicknameConfirmEl.value = selected;
    selectedNameEl.textContent = selected || '未選択';
    updateSendButtonState();
  });

  nicknameConfirmEl.addEventListener('change', () => {
    const selected = nicknameConfirmEl.value;
    nicknameEl.value = selected;
    selectedNameEl.textContent = selected || '未選択';
    updateSendButtonState();
  });
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
    msgEl.textContent = '';
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
