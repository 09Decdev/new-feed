/* news-poster GUI — app logic (UI-SPEC v1). Vanilla JS, no framework, no inline scripts. */
'use strict';

(function () {
  var TOKEN_KEY = 'poster-token';
  var POLL_MS = 2000;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') n.textContent = attrs[k];
        else if (k === 'class') n.className = attrs[k];
        else if (k === 'dataset') Object.assign(n.dataset, attrs[k]);
        else n.setAttribute(k, attrs[k]);
      });
    }
    if (children) {
      var arr = Array.isArray(children) ? children : [children];
      for (var i = 0; i < arr.length; i++) {
        var c = arr[i];
        if (c === null || c === undefined || c === false) continue;
        n.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
      }
    }
    return n;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var now = new Date();
    var hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
  }
  function fmtLogTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function fmtMinMs(ms) {
    if (!ms) return '';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' phút';
    return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  }
  function truncateMid(s, max) {
    if (!s) return '';
    if (s.length <= max) return s;
    var a = Math.ceil((max - 1) / 2), b = Math.floor((max - 1) / 2);
    return s.slice(0, a) + '…' + s.slice(-b);
  }
  function safeUrl(url) {
    if (!url) return null;
    try {
      var u = new URL(url, window.location.origin);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (e) { /* ignore */ }
    return null;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  var state = {
    token: (function () { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } })(),
    appShown: false,
    tab: 'dashboard',
    loggedOut: false,
    pollTimer: null,
    inFlight: {},
    connErr: 0,
    status: null,
    authStatus: null,
    lastPopup: null,
    communities: [],
    communitiesAt: 0,
    communitiesLoaded: false,
    communitiesLoading: false,
    communityPermission: null,
    // logs
    logLoaded: false,
    logLastSeq: 0,
    logLines: [],           // {seq, level, ts, message, node, passes}
    logFilter: 'all',
    logFollow: true,
    pendingNew: 0,
    // history
    history: [],
    historyFilter: 'all',
    // config
    config: null,
    secrets: {
      LLM_API_KEY: { set: false, mode: 'GIỮ', value: '' },
      GOOGLE_CLIENT_SECRET_WEB: { set: false, mode: 'GIỮ', value: '' },
    },
    test: { previewShown: false },
  };

  function api(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (path.indexOf('/api/') === 0 && state.token) headers['Authorization'] = 'Bearer ' + state.token;

    var p;
    try {
      p = fetch(path, {
        method: method,
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      onConnErr();
      return Promise.resolve({ ok: false, status: -1, body: null });
    }
    return p
      .then(function (res) {
        var ct = res.headers.get('content-type') || '';
        var parse = ct.indexOf('application/json') !== -1
          ? res.json().catch(function () { return null; })
          : Promise.resolve(null);
        return parse.then(function (body) {
          if (res.status === 401) {
            if (!opts.noAuthRedirect) handleApi401();
            return { ok: false, status: 401, body: body };
          }
          if (!res.ok) {
            if (res.status >= 500) onConnErr(); else onConnOk();
            return { ok: false, status: res.status, body: body };
          }
          onConnOk();
          return { ok: true, status: res.status, body: body };
        });
      })
      .catch(function () {
        onConnErr();
        return { ok: false, status: -1, body: null };
      });
  }
  function humanErr(r, fallback) {
    if (r && r.body) {
      if (r.body.data && r.body.data.humanMessage) return r.body.data.humanMessage;
      if (r.body.humanMessage) return r.body.humanMessage;
      if (r.body.data && r.body.data.message) return r.body.data.message;
      if (r.body.message) return r.body.message;
    }
    return fallback || 'Có lỗi xảy ra.';
  }

  // ── Kết nối / banner ───────────────────────────────────────────────────────
  function onConnErr() { state.connErr += 1; renderConn(); }
  function onConnOk() { if (state.connErr > 0) { state.connErr = 0; renderConn(); } }
  function renderConn() {
    var c = $('#conn');
    var b = $('#banner');
    if (state.connErr > 0) {
      c.textContent = '⌂ Mất kết nối';
      c.className = 'conn conn--err';
      b.hidden = false;
      b.textContent = '';
      b.appendChild(document.createTextNode('⌂ Mất kết nối máy chủ — đang thử lại tự động…'));
      var btn = el('button', { type: 'button', class: 'btn btn--sm btn--bordered' }, 'Thử lại');
      btn.addEventListener('click', function () { pollTick(); });
      b.appendChild(btn);
    } else {
      c.textContent = '⌂ Trực tuyến';
      c.className = 'conn conn--ok';
      b.hidden = true;
      b.textContent = '';
    }
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function toast(msg, kind) {
    var root = $('#toast-root');
    if (!root) return;
    while (root.childNodes.length > 4) root.removeChild(root.firstChild);
    var t = el('div', { class: 'toast' + (kind ? ' toast--' + kind : ''), role: 'status' }, msg);
    root.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, 4200);
  }

  // ── Token gate trong-trang (không navigation) ──────────────────────────────
  function showTokenScreen(msg) {
    state.appShown = false;
    stopPolling();
    $('#app').hidden = true;
    $('#token-screen').hidden = false;
    $('#token-err').hidden = true;
    $('#token-cnt').hidden = true;
    $('#token-input').value = '';
    if (msg) setTokenError(msg);
    setTimeout(function () { $('#token-input').focus(); }, 50);
  }
  function setTokenError(msg) {
    var e = $('#token-err');
    e.textContent = msg;
    e.hidden = false;
    $('#token-input').setAttribute('aria-invalid', 'true');
  }
  function hideTokenScreen() {
    $('#token-screen').hidden = true;
    $('#app').hidden = false;
  }
  function handleApi401() {
    if ($('#app').hidden) return; // chưa đăng nhập — không phải mất phiên
    if (state.loggedOut) return;
    state.loggedOut = true;
    stopPolling();
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    state.token = '';
    showTokenScreen('Phiên truy cập hết hạn — nhập lại mã truy cập.');
  }
  function startVerifyCountdown(lockedUntil) {
    if (!lockedUntil || lockedUntil <= Date.now()) {
      setTokenError('Quá nhiều lần thử sai — thử lại sau một lúc.');
      return;
    }
    var input = $('#token-input'), btn = $('#token-btn');
    input.disabled = true; btn.disabled = true;
    var cnt = $('#token-cnt'); cnt.hidden = false; $('#token-err').hidden = true;
    var tick = function () {
      var left = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      if (left <= 0) {
        cnt.hidden = true;
        input.disabled = false; btn.disabled = false;
        return;
      }
      cnt.textContent = 'Hệ thống khóa tạm thời do nhập sai quá nhiều — thử lại sau ' + left + 's';
      setTimeout(tick, 1000);
    };
    tick();
  }
  function bindTokenScreen() {
    $('#token-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('#token-input'), btn = $('#token-btn');
      var token = input.value.trim();
      if (!token) return;
      btn.disabled = true;
      btn.textContent = 'Kiểm tra…';
      $('#token-err').hidden = true;
      input.removeAttribute('aria-invalid');
      api('/api/auth/verify', { method: 'POST', body: { token: token }, noAuthRedirect: true })
        .then(function (r) {
          btn.disabled = false;
          btn.textContent = 'Vào';
          if (r.ok && r.body && r.body.ok && r.body.data && r.body.data.authenticated) {
            state.token = token;
            state.loggedOut = false;
            try { sessionStorage.setItem(TOKEN_KEY, token); } catch (err) {}
            hideTokenScreen();
            enterApp();
          } else if (r.status === 429 || (r.body && r.body.code === 'RATE_LIMITED')) {
            startVerifyCountdown(r.body && r.body.lockedUntil ? r.body.lockedUntil : 0);
          } else if (r.status === 401) {
            setTokenError('Mã không đúng — kiểm tra GUI_TOKEN trong .env.');
          } else {
            setTokenError(humanErr(r, 'Kiểm tra mã truy cập thất bại.'));
          }
        });
    });
  }

  // ── Poll engine ────────────────────────────────────────────────────────────
  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(pollTick, POLL_MS);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }
  function pollTick() {
    if (!state.appShown) return;
    // Heartbeat: trạng thái (badge/banner/lock) luôn cập nhật ở MỌI tab, không chỉ Dashboard.
    fetchStatus();
    if (state.tab === 'dashboard') {
      fetchAuthStatus();
      maybeFetchCommunities();
    } else if (state.tab === 'logs') {
      if (state.logLoaded) doFetchLogs();
    } else if (state.tab === 'history') {
      fetchHistory();
    }
  }

  // ── Tab + lifecycle ────────────────────────────────────────────────────────
  function activateTab(name) {
    state.tab = name;
    $$('.tab').forEach(function (t) {
      var on = t.dataset.panel === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.tab-panel').forEach(function (p) { p.hidden = p.id !== 'panel-' + name; });
    if (name === 'dashboard') {
      // init() đã fetch status; poll heartbeat sẽ cập nhật — tránh fetch đúp lúc boot.
      fetchAuthStatus();
      maybeFetchCommunities();
    } else if (name === 'logs') {
      if (!state.logLoaded) doFetchLogs(true); else doFetchLogs();
    } else if (name === 'history') {
      fetchHistory();
      if (!state.config) fetchConfig();
    } else if (name === 'config') {
      fetchConfig();
      fetchCommunities();
    }
  }
  function enterApp() {
    state.appShown = true;
    hideTokenScreen();
    activateTab('dashboard');
    startPolling();
  }
  function bindNavigation() {
    var order = ['dashboard', 'logs', 'history', 'config'];
    order.forEach(function (name) {
      $('#tab-' + name).addEventListener('click', function () { activateTab(name); });
    });
    $('#tabs').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var i = order.indexOf(state.tab);
      i = e.key === 'ArrowRight' ? (i + 1) % order.length : (i - 1 + order.length) % order.length;
      e.preventDefault();
      activateTab(order[i]);
      $('#tab-' + order[i]).focus();
    });
    $('#brand').addEventListener('click', function () { activateTab('dashboard'); });
  }

  // ── Status (Dashboard + header) ────────────────────────────────────────────
  function mapState(st) {
    switch (st) {
      case 'RUNNING':  return { label: '● Đang chạy', cls: 'badge--success' };
      case 'STOPPED':  return { label: '⏸ Đã dừng', cls: 'badge--neutral' };
      case 'STARTING': return { label: '… Đang khởi động', cls: 'badge--info' };
      case 'STOPPING': return { label: '… Đang dừng', cls: 'badge--warning' };
      case 'ERROR':    return { label: '⚠ Lỗi', cls: 'badge--error' };
      default:         return { label: '…', cls: 'badge--neutral' };
    }
  }
  function fetchStatus() {
    if (state.inFlight['/api/status']) return;
    state.inFlight['/api/status'] = true;
    api('/api/status').then(function (r) {
      state.inFlight['/api/status'] = false;
      if (r.ok && r.body && r.body.ok) {
        state.status = r.body.data;
        renderHeader();
        if (state.tab === 'dashboard') renderDashboard();
      }
    });
  }
  function fetchAuthStatus() {
    if (state.inFlight['/api/auth-status']) return;
    state.inFlight['/api/auth-status'] = true;
    api('/api/auth-status').then(function (r) {
      state.inFlight['/api/auth-status'] = false;
      if (r.ok && r.body && r.body.ok) {
        state.authStatus = r.body.data;
        if ((state.authStatus.hasSession || state.authStatus.lastOAuthError) && state.lastPopup && !state.lastPopup.closed) {
          try { state.lastPopup.close(); } catch (e) {}
          state.lastPopup = null;
        }
        if (state.tab === 'dashboard') renderGoogle();
      }
    });
  }
  function maybeFetchCommunities() {
    if (state.communitiesLoading) { applyCommunityPermission(); if (state.tab === 'dashboard' && state.status) renderGoogle(); return; }
    if (state.communitiesLoaded && Date.now() - state.communitiesAt < 60000) {
      applyCommunityPermission();
      if (state.tab === 'dashboard' && state.status) renderGoogle();
      return;
    }
    state.communitiesLoading = true;
    api('/api/communities').then(function (r) {
      state.communitiesLoading = false;
      if (r.ok && r.body && r.body.ok) {
        state.communities = r.body.data.items || [];
        state.communitiesAt = Date.now();
        state.communitiesLoaded = true;
        applyCommunityPermission();
      } else {
        state.communityPermission = null;
      }
      if (state.tab === 'dashboard') renderGoogle();
    });
  }
  function applyCommunityPermission() {
    var st = state.status;
    if (!st) { state.communityPermission = null; return; }
    var id = st.config && st.config.COMMUNITY_ID;
    if (!id) { state.communityPermission = null; return; }
    var it = state.communities.filter(function (x) { return x.id === id; })[0];
    state.communityPermission = it ? !!it.canPost : null;
  }

  function renderHeader() {
    var st = state.status;
    if (!st) return;
    var map = mapState(st.state);
    var badge = $('#hdr-badge');
    badge.textContent = map.label;
    badge.dataset.state = st.state;
    badge.className = 'badge ' + map.cls;
    $('#hdr-cycle').textContent = st.lastCycleAt
      ? 'Gần nhất ·' + Math.max(0, Math.round((Date.now() - st.lastCycleAt) / 1000)) + 's'
      : 'Chưa chạy chu kỳ nào';
    updateTestPostEnabled();
  }

  function makeBadge(cls, text) { return el('span', { class: 'badge badge--' + cls, text: text }); }
  function setSelectValue(sel, value) {
    if (!value) return;
    var found = false;
    $$('option', sel).forEach(function (o) { if (String(o.value) === String(value)) found = true; });
    if (!found) sel.appendChild(el('option', { value: value, text: value }));
    sel.value = value;
  }
  function kvRow(label, value, mono) {
    var d = el('div');
    d.appendChild(el('dt', { text: label }));
    d.appendChild(el('dd', { class: mono ? 'mono' : '', text: value === null || value === undefined || value === '' ? '—' : value }));
    return d;
  }

  function renderDashboard() {
    var st = state.status;
    var badge = $('#dash-badge');
    var sub = $('#dash-status-sub');
    var map = mapState(st ? st.state : '');
    badge.textContent = map.label;
    badge.dataset.state = st ? st.state : '';
    badge.className = 'badge ' + map.cls;

    if (!st) {
      sub.textContent = 'Đang tải…';
    } else {
      if (st.state === 'ERROR') {
        sub.textContent = (st.humanMessage || st.errorMessage || 'Lỗi').split('\n')[0];
      } else if (st.cycleProgress && st.cycleProgress.total > 0) {
        sub.textContent = 'Đang xử lý item ' + st.cycleProgress.done + '/' + st.cycleProgress.total;
      } else {
        sub.textContent = st.lastCycleAt ? 'từ ' + fmtDate(st.lastCycleAt) : 'chưa chạy lần nào';
      }
      renderConfigCard(st);
      renderLastPost(st);
      renderStats(st);
      renderControls(st);
    }
    renderGoogle();
  }

  function renderControls(st) {
    var start = $('#btn-start'), stop = $('#btn-stop'), lockEl = $('#dash-lock'), errEl = $('#dash-state-err');
    var transitions = st.state === 'STARTING' || st.state === 'STOPPING';
    var held = st.lock && st.lock.held;

    start.hidden = st.state === 'RUNNING';
    stop.hidden = st.state === 'STOPPED' || st.state === 'ERROR';
    start.disabled = transitions || !!held;
    stop.disabled = transitions;
    start.textContent = st.state === 'STARTING' ? 'Đang khởi động…' : '▶ Bắt đầu';
    stop.textContent = st.state === 'STOPPING' ? '… Đang dừng' : '⏹ Dừng';
    start.title = held ? ('Đã có vòng lặp khác chạy (PID ' + (st.lock.pid != null ? st.lock.pid : '?') + ')') : '';
    errEl.hidden = true;

    if (held) {
      lockEl.hidden = false;
      lockEl.textContent = '⚠ Đã có vòng lặp khác đang chạy (PID ' + (st.lock.pid != null ? st.lock.pid : '?') + '). Hãy dừng nó ở terminal/PM2 rồi mới Bắt đầu.';
    } else {
      lockEl.hidden = true;
    }
    if (st.state === 'ERROR') {
      errEl.hidden = false;
      errEl.textContent = (st.humanMessage || st.errorMessage || 'Bot gặp lỗi — xem Nhật ký để biết chi tiết.');
    }
  }
  function setControlMsg(msg) {
    var e = $('#dash-state-err');
    e.textContent = msg;
    e.hidden = !msg;
  }

  function renderConfigCard(st) {
    var box = $('#dash-config');
    box.textContent = '';
    var c = st.config || {};
    box.appendChild(kvRow('Feed', truncateMid(String(c.RSS_FEED_URL || ''), 40), true));
    box.appendChild(kvRow('Mỗi chu kỳ', String(c.RSS_LIMIT_PER_CYCLE || 0) + ' bài (' + fmtMinMs(c.POST_INTERVAL_MS) + ')'));
    box.appendChild(kvRow('Cộng đồng', String(c.COMMUNITY_ID || '—'), true));
    box.appendChild(kvRow('Định dạng', String(c.LAYOUT_TYPE || '—')));
    box.appendChild(kvRow('Chế độ', c.DRY_RUN ? 'Chế độ thử' : 'Đăng thật'));
    var rewriteC = c.REWRITE_WITH_AI ? 'AI viết lại' : 'Không viết lại';
    box.appendChild(kvRow('AI', rewriteC));
  }

  function renderLastPost(st) {
    var box = $('#dash-lastpost');
    box.textContent = '';
    var lp = st.lastPostResult;
    if (!lp) {
      box.appendChild(el('p', { class: 'note', text: 'Chưa có bài nào được đăng.' }));
      return;
    }
    if (lp.ok) {
      box.appendChild(makeBadge('success', '✓ Đăng thành công'));
      if (lp.title) box.appendChild(el('p', { text: lp.title }));
      if (lp.postId) box.appendChild(el('p', { class: 'mono note', text: 'postId: ' + lp.postId }));
    } else {
      box.appendChild(makeBadge('error', '⨯ Thất bại'));
      if (lp.title) box.appendChild(el('p', { text: lp.title }));
      box.appendChild(el('p', { class: 'msg msg--error msg--flat', text: lp.humanMessage || lp.reason || 'Đăng bài thất bại.' }));
    }
    box.appendChild(el('p', { class: 'note', text: fmtDate(lp.ts) }));
  }

  function renderStats(st) {
    var box = $('#dash-stats');
    box.textContent = '';
    box.appendChild(kvRow('Chu kỳ đã chạy', String(st.cycleCount != null ? st.cycleCount : 0)));
    box.appendChild(kvRow('Bài hôm nay', String(st.postedToday != null ? st.postedToday : 0)));
  }

  function renderGoogle() {
    var box = $('#dash-google');
    box.textContent = '';
    var a = state.authStatus;
    if (!a) { box.appendChild(el('p', { class: 'note', text: 'Đang tải…' })); return; }
    if (a.hasSession) {
      var msg = '✅ Đã kết nối';
      if (a.accessExpiresAt && a.accessExpiresAt > Date.now()) {
        msg += ' — token còn ~' + Math.max(1, Math.round((a.accessExpiresAt - Date.now()) / 60000)) + ' phút';
      }
      box.appendChild(makeBadge('success', msg));
    } else if (a.lastOAuthError) {
      box.appendChild(makeBadge('error', '⛔ Kết nối Google thất bại'));
      box.appendChild(el('p', { class: 'msg msg--error msg--flat', text: describeOAuthError(a.lastOAuthError) }));
      var rbtn = el('button', { type: 'button', class: 'btn btn--bordered btn--sm' }, '🔄 Thử lại / Đăng nhập');
      rbtn.addEventListener('click', openSetupOAuth);
      box.appendChild(el('div', { class: 'field-row' }, rbtn));
    } else if (a.accessExpiresAt && a.accessExpiresAt <= Date.now() && a.hasGoogleRefresh) {
      box.appendChild(makeBadge('warning', '⚠ Token đã hết hạn — bot sẽ tự làm mới khi chạy.'));
    } else {
      box.appendChild(makeBadge('error', '⛔ Chưa kết nối Google'));
      var btn = el('button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'Kết nối Google');
      btn.addEventListener('click', openSetupOAuth);
      box.appendChild(el('div', { class: 'field-row' }, btn));
    }
    var perm = state.communityPermission;
    if (perm === true) {
      box.appendChild(makeBadge('success', '✓ Có quyền đăng bài (POST_CONTENT)'));
    } else if (perm === false) {
      box.appendChild(makeBadge('warning', '⚠ Không có quyền POST_CONTENT trong community đã cấu hình — vòng lặp sẽ không chạy.'));
    } else if (a.hasSession && !state.communitiesLoading) {
      box.appendChild(el('p', { class: 'note', text: 'Không khớp được quyền trong community (COMMUNITY_ID) — kiểm tra ở tab Cấu hình.' }));
    }
  }
  function describeOAuthError(e) {
    if (!e) return 'Không thể xác thực với Google.';
    var m = String(e);
    if (/2fa|two.?factor|totp|2-step|twofactor/i.test(m)) return 'Tài khoản cần xác minh 2 bước (2FA). Dùng App Password (myaccount.google.com/apppasswords) hoặc đăng nhập lại.';
    if (/register|no account|account_not|not found/i.test(m)) return 'Tài khoản Google chưa được cấp quyền hoặc chưa đăng ký — kiểm tra nhà cung cấp.';
    return 'Lỗi xác thực: ' + m;
  }
  function openSetupOAuth() {
    api('/api/setup/start', { method: 'POST' }).then(function (r) {
      var box = $('#dash-google');
      var after = function (msg, cls) {
        box.appendChild(el('p', { class: 'msg msg--' + cls, text: msg }));
      };
      if (!r.ok || !r.body || !r.body.ok) {
        after(humanErr(r, 'Kết nối Google từ giao diện chưa sẵn sàng (Wave 4). Hãy chạy `npm run setup` trong terminal để đăng nhập.'), 'warning');
        return;
      }
      var consentUrl = r.body.data && r.body.data.consentUrl;
      if (consentUrl) {
        state.lastPopup = window.open(consentUrl, '_blank', 'noopener,noreferrer');
      } else {
        after('Mở trang đăng nhập Google… (không nhận được URL consent từ server).', 'warning');
      }
    });
  }

  // ── Start/Stop ─────────────────────────────────────────────────────────────
  function bindControls() {
    $('#btn-start').addEventListener('click', function () {
      var btn = $('#btn-start');
      btn.disabled = true; btn.textContent = 'Đang khởi động…';
      api('/api/start', { method: 'POST' }).then(function (r) {
        if (r.ok && r.body && r.body.ok) {
          setControlMsg('');
          toast('Đang khởi động…');
        } else {
          setControlMsg(humanErr(r, 'Không thể khởi động bot.'));
          btn.disabled = false; btn.textContent = '▶ Bắt đầu';
        }
        fetchStatus();
      });
    });
    $('#btn-stop').addEventListener('click', function () {
      var btn = $('#btn-stop');
      btn.disabled = true; btn.textContent = '… Đang dừng';
      api('/api/stop', { method: 'POST' }).then(function (r) {
        if (r.ok && r.body && r.body.ok) {
          setControlMsg('');
          toast('Đang dừng bot…');
        } else {
          setControlMsg(humanErr(r, 'Không thể dừng bot.'));
        }
        fetchStatus();
      });
    });
  }

  // ── Logs tab ───────────────────────────────────────────────────────────────
  function logClass(l) {
    var m = l.message || '';
    if (/\[FAIL\]/.test(m) || l.level === 'error' || /error|failed|thất bại|không đăng được/i.test(m)) return 'error';
    if (/\[SKIP\]/.test(m) || l.level === 'warn') return 'warn';
    if (/\[OK\]/.test(m)) return 'ok';
    if (/\[LLM\]/.test(m)) return 'llm';
    if (/\[(IMG|DRY)\]/.test(m)) return 'muted';
    return 'info';
  }
  function logFilterFn(l) {
    if (state.logFilter === 'error') {
      return /\[FAIL\]/.test(l.message) || l.level === 'error' || /error|failed|thất bại|không đăng được/i.test(l.message);
    }
    if (state.logFilter === 'skip') return /\[SKIP\]/.test(l.message);
    return true;
  }
  function makeLogLine(l) {
    var line = {
      seq: l.seq,
      level: l.level,
      ts: l.ts,
      message: l.message || '',
      passes: null,
      node: null,
    };
    var cls = logClass(line);
    var row = el('div', { class: 'log-line log-line--' + cls });
    row.appendChild(el('span', { class: 'log-time', text: fmtLogTime(line.ts) }));
    row.appendChild(el('span', { class: 'log-text', text: line.message }));
    line.passes = logFilterFn(line);
    row.hidden = !line.passes;
    line.node = row;
    return line;
  }
  function setLineVisibility(l) {
    l.passes = logFilterFn(l);
    if (l.node) l.node.hidden = !l.passes;
  }
  function doFetchLogs(full) {
    if (state.inFlight['/api/logs']) return;
    state.inFlight['/api/logs'] = true;
    var since = full ? '' : state.logLastSeq;
    api('/api/logs' + (since ? '?since=' + encodeURIComponent(since) : '')).then(function (r) {
      state.inFlight['/api/logs'] = false;
      if (!r.ok || !r.body || !r.body.ok) return;
      var d = r.body.data;
      if (d.reset) {
        state.logLines = (d.lines || []).map(makeLogLine);
        state.logLastSeq = d.lastSeq || 0;
        rebuildLogView();
      } else {
        var fresh = (d.lines || []).filter(function (l) { return l.seq > state.logLastSeq; });
        if (fresh.length) {
          var lines = fresh.map(makeLogLine);
          lines.forEach(function (ln) { state.logLines.push(ln); });
          appendLogNodes(lines.map(function (ln) { return ln.node; }));
        }
        state.logLastSeq = d.lastSeq || state.logLastSeq;
      }
      if (!state.logLoaded) { state.logLoaded = true; applyLogFilter(); }
    });
  }
  function rebuildLogView() {
    var panel = $('#log-panel');
    panel.textContent = '';
    var frag = document.createDocumentFragment();
    state.logLines.forEach(function (l) { frag.appendChild(l.node); });
    panel.appendChild(frag);
    updateLogEmpty();
    if (state.logFollow) scrollLogBottom(); else updateJumpBadge();
  }
  function appendLogNodes(nodes) {
    var panel = $('#log-panel');
    var atBot = isLogAtBottom();
    var frag = document.createDocumentFragment();
    nodes.forEach(function (n) { frag.appendChild(n); });
    panel.appendChild(frag);
    updateLogEmpty();
    if (state.logFollow && (atBot || isLogAtBottom())) {
      scrollLogBottom();
    } else if (state.logLoaded) {
      state.pendingNew += nodes.length;
      updateJumpBadge();
    }
  }
  function applyLogFilter() {
    state.logLines.forEach(setLineVisibility);
    updateLogEmpty();
    if (state.logFollow) scrollLogBottom();
  }
  function updateLogEmpty() {
    var visible = state.logLines.filter(function (l) { return l.passes; }).length;
    $('#log-empty').hidden = !(visible === 0);
  }
  function isLogAtBottom() {
    var p = $('#log-panel');
    return p.scrollTop + p.clientHeight >= p.scrollHeight - 24;
  }
  function scrollLogBottom() {
    var p = $('#log-panel');
    p.scrollTop = p.scrollHeight;
  }
  function updateJumpBadge() {
    var j = $('#log-jump');
    if (state.pendingNew > 0 && !state.logFollow) {
      j.hidden = false;
      j.textContent = '↓ ' + state.pendingNew + ' dòng mới';
    } else {
      j.hidden = true;
    }
  }
  function bindLogs() {
    var panel = $('#log-panel');
    $('#log-filter').addEventListener('change', function () {
      state.logFilter = this.value;
      applyLogFilter();
    });
    $('#log-clear').addEventListener('click', function () {
      panel.textContent = '';
      state.logLines = [];
      updateLogEmpty();
      toast('Đã xóa hiển thị nhật ký.');
    });
    $('#log-follow').addEventListener('click', function () {
      state.logFollow = !state.logFollow;
      this.classList.toggle('is-on', state.logFollow);
      this.setAttribute('aria-pressed', state.logFollow ? 'true' : 'false');
      if (state.logFollow) { scrollLogBottom(); state.pendingNew = 0; updateJumpBadge(); }
      else updateJumpBadge();
    });
    $('#log-jump').addEventListener('click', function () {
      state.logFollow = true;
      $('#log-follow').classList.add('is-on');
      $('#log-follow').setAttribute('aria-pressed', 'true');
      state.pendingNew = 0;
      scrollLogBottom();
      updateJumpBadge();
    });
    panel.addEventListener('scroll', function () {
      if (isLogAtBottom()) {
        state.pendingNew = 0;
        updateJumpBadge();
      } else if (state.logFollow) {
        state.logFollow = false;
        $('#log-follow').classList.remove('is-on');
        $('#log-follow').setAttribute('aria-pressed', 'false');
      }
    });
  }

  // ── History tab ────────────────────────────────────────────────────────────
  function fetchHistory() {
    if (state.inFlight['/api/history']) return;
    state.inFlight['/api/history'] = true;
    api('/api/history?limit=100').then(function (r) {
      state.inFlight['/api/history'] = false;
      var herr = $('#hist-err');
      if (!r.ok || !r.body || !r.body.ok) {
        herr.textContent = humanErr(r, 'Không tải được lịch sử.');
        herr.hidden = false;
        return;
      }
      herr.hidden = true;
      state.history = r.body.data.entries || [];
      applyHistoryFilter();
    });
  }
  function applyHistoryFilter() {
    var f = state.historyFilter;
    var rows = state.history;
    if (f !== 'all') rows = rows.filter(function (e) { return e.status === f; });
    renderHistoryRows(rows);
  }
  function statusBadge(e) {
    if (e.status === 'posted') return makeBadge('success', '✓ Đăng');
    if (e.status === 'skipped') return makeBadge('info', '⟳ Bỏ qua');
    if (e.status === 'failed') return makeBadge('error', '⨯ Thất bại');
    return makeBadge('neutral', '—');
  }
  function renderHistoryRows(rows) {
    var tbody = $('#hist-tbody');
    tbody.textContent = '';
    var empty = $('#hist-empty');
    var err = $('#hist-err');
    err.hidden = true;
    if (!rows.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    var frag = document.createDocumentFragment();
    rows.forEach(function (e) {
      var tr = el('tr');
      var tdSt = el('td'); tdSt.appendChild(statusBadge(e)); tr.appendChild(tdSt);
      var tdTitle = el('td', { class: 'trunc' });
      var sp = el('span', { text: e.title || '—' });
      sp.title = e.title || '';
      tdTitle.appendChild(sp);
      var href = safeUrl(e.link);
      if (href) {
        var a = el('button', { type: 'button', class: 'src-link', text: '↗ nguồn' });
        a.addEventListener('click', function () {
          window.open(href, '_blank', 'noopener,noreferrer');
        });
        tdTitle.appendChild(a);
      }
      tr.appendChild(tdTitle);
      tr.appendChild(el('td', { text: fmtDate(e.ts) }));
      tr.appendChild(el('td', { class: 'mono', text: e.postId ? e.postId : '—' }));
      tr.appendChild(el('td', { text: e.humanMessage || e.reason || '—' }));
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }
  function updateTestPostEnabled() {
    var btn = $('#hist-testpost');
    if (!btn) return;
    var st = state.status;
    var busy = st && (st.state === 'STARTING' || st.state === 'RUNNING' || st.state === 'STOPPING');
    var held = st && st.lock && st.lock.held;
    var dis = !!(busy || held);
    btn.disabled = dis;
    if (busy) btn.title = 'Bot đang chạy — dừng bot trước khi đăng thử.';
    else if (held) btn.title = 'Đã có vòng lặp khác đang chạy (PID ' + (st && st.lock && st.lock.pid != null ? st.lock.pid : '?') + ') — dừng nó ở terminal/PM2 rồi thử lại.';
    else btn.title = '';
  }
  function bindHistory() {
    $('#hist-refresh').addEventListener('click', fetchHistory);
    $('#hist-status-filter').addEventListener('change', function () {
      state.historyFilter = this.value;
      applyHistoryFilter();
    });
    $('#hist-testpost').addEventListener('click', openTestModal);
  }

  // ── Modal đăng thử ─────────────────────────────────────────────────────────
  var lastOpener = null;
  function modalBusyState() {
    var st = state.status;
    return {
      busy: !!(st && (st.state === 'STARTING' || st.state === 'RUNNING' || st.state === 'STOPPING')),
      held: !!(st && st.lock && st.lock.held),
      pid: st && st.lock && st.lock.pid != null ? st.lock.pid : null,
    };
  }
  function openTestModal() {
    lastOpener = document.activeElement;
    state.test.previewShown = false;
    $('#test-modal').hidden = false;
    $('#test-preview-box').hidden = true;
    $('#test-preview-box').textContent = '';
    $('#test-note').hidden = true;
    $('#test-err').hidden = true;
    if (state.config && state.config.config) {
      $('#test-url').value = state.config.config.RSS_FEED_URL;
    } else {
      $('#test-url').value = '';
      api('/api/config').then(function (r) {
        if (r.ok && r.body && r.body.ok) {
          state.config = r.body.data;
          if (!$('#test-url').value) $('#test-url').value = (state.config.config || {}).RSS_FEED_URL || '';
        }
      });
    }
    var m = modalBusyState();
    if (m.busy) {
      showTestNote('Bot đang ' + (state.status ? state.status.state : 'chạy') + ' — dừng bot trước khi đăng thử.');
    } else if (m.held) {
      showTestNote('Đã có vòng lặp khác đang chạy (PID ' + (m.pid != null ? m.pid : '?') + ') — dừng nó ở terminal/PM2 rồi thử lại.');
    }
    updateTestActives(m);
    var checked = document.querySelector('#test-modal input[name="test-src"]:checked');
    if (checked) checked.focus();
  }
  function closeTestModal() {
    $('#test-modal').hidden = true;
    if (lastOpener && typeof lastOpener.focus === 'function') { try { lastOpener.focus(); } catch (e) {} }
  }
  function showTestNote(msg) { var n = $('#test-note'); n.textContent = msg; n.hidden = false; }
  function showTestErr(msg) { var e = $('#test-err'); e.textContent = msg; e.hidden = false; }
  function hideTestMessages() { $('#test-note').hidden = true; $('#test-err').hidden = true; }
  function modalInputState() {
    var src = document.querySelector('#test-modal input[name="test-src"]:checked');
    var isUrl = src && src.value === 'url';
    var cfgUrl = state.config && state.config.config ? state.config.config.RSS_FEED_URL : '';
    var url = isUrl ? $('#test-url').value.trim() : cfgUrl;
    var limit = parseInt($('#test-count').value, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = 1;
    if (limit > 50) limit = 50;
    return { url: url, limit: limit, dryRun: $('#test-dryrun').checked, isUrl: isUrl };
  }
  function updateTestActives(m) {
    m = m || modalBusyState();
    var dis = m.busy || m.held;
    $('#test-preview').disabled = dis;
    $('#test-post').disabled = dis || !(!$('#test-dryrun').checked && state.test.previewShown);
    $('#test-post').title = dis ? 'Không thể đăng thử khi bot đang chạy hoặc vòng lặp khác đang giữ khóa.' : '';
  }
  function doTestPreview() {
    var input = modalInputState();
    var btn = $('#test-preview');
    hideTestMessages();
    if (!input.url) {
      showTestErr(input.isUrl ? 'Nhập URL feed RSS để xem trước (ô URL đang trống).' : 'Chưa có RSS_FEED_URL trong cấu hình — chọn "URL bất kỳ" và nhập feed.');
      return;
    }
    var okUrl = safeUrl(input.url);
    if (!okUrl) { showTestErr('URL không hợp lệ — chỉ chấp nhận http/https.'); return; }
    input.url = okUrl;
    btn.disabled = true; btn.textContent = 'Đang xem trước…';
    api('/api/post', { method: 'POST', body: { mode: 'rss', rssUrl: input.url, limit: input.limit, dryRun: true } })
      .then(function (r) {
        btn.disabled = false; btn.textContent = 'Xem trước';
        if (!r.ok) { showTestErr(humanErr(r, 'Không xem trước được.')); return; }
        var inner = r.body && r.body.data;
        if (!inner || inner.ok === false) { showTestErr((inner && inner.humanMessage) || 'Feed không có bài nào để xem trước.'); return; }
        renderPreview(inner.previews || [], inner.count || 0);
        state.test.previewShown = true;
        updateTestActives();
      });
  }
  function renderPreview(previews, count) {
    var box = $('#test-preview-box');
    box.hidden = false;
    box.textContent = '';
    var txt = '';
    if (count != null) txt += '— ' + count + ' bài sẽ được xử lý —\n\n';
    previews.forEach(function (p, i) {
      txt += (i + 1) + '. ' + (p.title || '') + '\n\n' + (p.content || '') + '\n' + (p.link || '') + '\n\n---\n\n';
    });
    if (!previews.length) txt += '(không có bài nào)';
    box.appendChild(document.createTextNode(txt));
  }
  function doTestPost() {
    var input = modalInputState();
    var btn = $('#test-post');
    hideTestMessages();
    if (!input.url) {
      showTestErr(input.isUrl ? 'Nhập URL feed RSS (ô URL đang trống).' : 'Chưa có RSS_FEED_URL trong cấu hình — chọn "URL bất kỳ" và nhập feed.');
      return;
    }
    var okUrl = safeUrl(input.url);
    if (!okUrl) { showTestErr('URL không hợp lệ — chỉ chấp nhận http/https.'); return; }
    input.url = okUrl;
    btn.disabled = true; btn.textContent = 'Đang đăng…';
    api('/api/post', { method: 'POST', body: { mode: 'rss', rssUrl: input.url, limit: input.limit, dryRun: false } })
      .then(function (r) {
        if (!r.ok) {
          showTestErr(humanErr(r, 'Đăng bài thất bại.'));
          btn.disabled = false; btn.textContent = '✓ Đăng bài này';
          return;
        }
        var inner = r.body && r.body.data;
        if (inner && inner.ok === false) {
          showTestErr((inner.humanMessage) || 'Đăng bài thất bại.');
          btn.disabled = false; btn.textContent = '✓ Đăng bài này';
          return;
        }
        toast((inner && inner.humanMessage) || 'Đã đăng ✓');
        closeTestModal();
        fetchHistory();
        fetchStatus();
      });
  }
  function bindModal() {
    $('#test-close').addEventListener('click', closeTestModal);
    $('.modal-overlay').addEventListener('click', closeTestModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#test-modal').hidden) closeTestModal();
    });
    $$('#test-modal input[name="test-src"]').forEach(function (r) {
      r.addEventListener('change', function () {
        $('#test-url-row').hidden = document.querySelector('#test-modal input[name="test-src"]:checked').value !== 'url';
        state.test.previewShown = false;
        updateTestActives();
      });
    });
    $('#test-dryrun').addEventListener('change', function () {
      state.test.previewShown = false;
      hideTestMessages();
      updateTestActives();
      $('#test-preview-box').hidden = true;
    });
    $('#test-count').addEventListener('input', function () { state.test.previewShown = false; updateTestActives(); });
    $('#test-url').addEventListener('input', function () { state.test.previewShown = false; updateTestActives(); });
    $('#test-preview').addEventListener('click', doTestPreview);
    $('#test-post').addEventListener('click', doTestPost);
  }

  // ── Config tab ─────────────────────────────────────────────────────────────
  function fetchConfig() {
    if (state.inFlight['/api/config']) return;
    state.inFlight['/api/config'] = true;
    api('/api/config').then(function (r) {
      state.inFlight['/api/config'] = false;
      if (!r.ok || !r.body || !r.body.ok) {
        setCfgMsg(humanErr(r, 'Không tải được cấu hình.'), 'error');
        return;
      }
      state.config = r.body.data;
      setCfgMsg('');
      fillConfigForm();
    });
  }
  function fillConfigForm() {
    if (!state.config) return;
    var c = state.config.config;
    $('#cfg-rss-url').value = c.RSS_FEED_URL || '';
    $('#cfg-limit').value = c.RSS_LIMIT_PER_CYCLE != null ? c.RSS_LIMIT_PER_CYCLE : '';
    $('#cfg-interval').value = c.POST_INTERVAL_MS != null ? c.POST_INTERVAL_MS : '';
    $('#cfg-interval-hint').textContent = c.POST_INTERVAL_MS ? '≈ ' + Math.round(c.POST_INTERVAL_MS / 60000) + ' phút' : '';
    $('#cfg-community').value = c.COMMUNITY_ID || '';
    setSelectValue($('#cfg-layout'), c.LAYOUT_TYPE || 'CLASSIC');
    $('#cfg-dryrun').checked = !!c.DRY_RUN;
    $('#cfg-rewrite').checked = !!c.REWRITE_WITH_AI;
    $('#cfg-llm-url').value = c.LLM_BASE_URL || '';
    $('#cfg-llm-model').value = c.LLM_MODEL || '';
    $('#cfg-gid').value = c.GOOGLE_CLIENT_ID_WEB || '';
    state.secrets.LLM_API_KEY.set = !!(c.LLM_API_KEY && c.LLM_API_KEY.set);
    state.secrets.GOOGLE_CLIENT_SECRET_WEB.set = !!(c.GOOGLE_CLIENT_SECRET_WEB && c.GOOGLE_CLIENT_SECRET_WEB.set);
    renderSecrets();
  }
  function setCfgMsg(msg, kind) {
    kind = kind || 'flat';
    var e = $('#cfg-save-msg');
    e.textContent = msg;
    e.className = 'msg msg--' + kind;
    e.hidden = kind === 'flat';
  }
  function renderSecrets() {
    renderSecretField('LLM_API_KEY', 'LLM_API_KEY_SET', 'LLM_API_KEY', $('#cfg-secret-LLM_API_KEY'));
    renderSecretField('GOOGLE_CLIENT_SECRET_WEB', 'GOOGLE_CLIENT_SECRET_WEB_SET', 'GOOGLE_CLIENT_SECRET_WEB', $('#cfg-secret-GOOGLE_CLIENT_SECRET_WEB'));
  }
  function renderSecretField(envKey, setKey, label, box) {
    box.textContent = '';
    var s = state.secrets[envKey];
    if (!s) return;
    var row = el('div', { class: 'secret-row' });
    row.appendChild(el('span', { class: 'note', text: label }));
    if (s.mode === 'GIỮ') {
      row.appendChild(el('span', { class: 'secret-mask', text: '••••••••' }));
      var st = el('span', { class: 'secret-state ' + (s.set ? 'secret-set-true' : 'secret-set-false'), text: s.set ? 'đã đặt' : 'chưa đặt' });
      row.appendChild(st);
      var setBtn = el('button', { type: 'button', class: 'btn btn--bordered btn--sm', text: 'Đặt mới' });
      setBtn.addEventListener('click', function () { s.mode = 'SỬA'; s.value = ''; renderSecrets(); });
      row.appendChild(setBtn);
      var delBtn = el('button', { type: 'button', class: 'btn btn--bordered btn--sm', text: 'Xóa' });
      delBtn.addEventListener('click', function () { s.mode = 'XÓA'; s.value = ''; renderSecrets(); });
      row.appendChild(delBtn);
    } else if (s.mode === 'SỬA') {
      var input = el('input', { type: 'password', placeholder: 'Nhập giá trị mới…', 'aria-label': label });
      input.value = s.value;
      input.addEventListener('input', function () { s.value = input.value; });
      row.appendChild(input);
      var cancel = el('button', { type: 'button', class: 'btn btn--bordered btn--sm', text: 'Hủy' });
      cancel.addEventListener('click', function () { s.mode = 'GIỮ'; s.value = ''; renderSecrets(); });
      row.appendChild(cancel);
    } else if (s.mode === 'XÓA') {
      row.appendChild(el('span', { class: 'msg msg--warning msg--flat', text: 'Sẽ bị xóa khi lưu' }));
      var unDel = el('button', { type: 'button', class: 'btn btn--bordered btn--sm', text: 'Hủy xóa' });
      unDel.addEventListener('click', function () { s.mode = 'GIỮ'; s.value = ''; renderSecrets(); });
      row.appendChild(unDel);
    }
    box.appendChild(row);
  }
  function collectConfigBody() {
    var body = {};
    var err = null;
    var need = function (label) { if (err === null) err = label; };
    var v = function (sel) { return $(sel).value.trim(); };

    var rssUrl = v('#cfg-rss-url');
    var community = v('#cfg-community');
    var llmUrl = v('#cfg-llm-url');
    var llmModel = v('#cfg-llm-model');
    var rewriteOn = $('#cfg-rewrite').checked;
    if (!rssUrl) need('RSS_FEED_URL không được bỏ trống.');
    if (!community) need('COMMUNITY_ID không được bỏ trống.');
    if (rewriteOn && !llmUrl) need('LLM_BASE_URL không được bỏ trống khi bật AI viết lại.');
    if (rewriteOn && !llmModel) need('LLM_MODEL không được bỏ trống khi bật AI viết lại.');

    var limit = parseInt(v('#cfg-limit'), 10);
    var interval = parseInt(v('#cfg-interval'), 10);
    if (!Number.isInteger(limit) || limit <= 0) need('RSS_LIMIT_PER_CYCLE phải là số nguyên dương.');
    if (!Number.isInteger(interval) || interval <= 0) need('POST_INTERVAL_MS phải là số nguyên dương.');

    if (err) return { error: err };
    body.RSS_FEED_URL = rssUrl;
    body.RSS_LIMIT_PER_CYCLE = limit;
    body.POST_INTERVAL_MS = interval;
    body.COMMUNITY_ID = community;
    body.LAYOUT_TYPE = $('#cfg-layout').value;
    body.DRY_RUN = $('#cfg-dryrun').checked;
    body.REWRITE_WITH_AI = $('#cfg-rewrite').checked;
    if (llmUrl) body.LLM_BASE_URL = llmUrl;
    if (llmModel) body.LLM_MODEL = llmModel;

    var se = state.secrets;
    if (se.LLM_API_KEY.mode === 'SỬA' && se.LLM_API_KEY.value.trim()) body.LLM_API_KEY_SET = se.LLM_API_KEY.value.trim();
    if (se.LLM_API_KEY.mode === 'XÓA') body.LLM_API_KEY_SET = '';
    if (se.GOOGLE_CLIENT_SECRET_WEB.mode === 'SỬA' && se.GOOGLE_CLIENT_SECRET_WEB.value.trim()) body.GOOGLE_CLIENT_SECRET_WEB_SET = se.GOOGLE_CLIENT_SECRET_WEB.value.trim();
    if (se.GOOGLE_CLIENT_SECRET_WEB.mode === 'XÓA') body.GOOGLE_CLIENT_SECRET_WEB_SET = '';
    return { body: body };
  }
  function doSaveConfig() {
    var btn = $('#cfg-save');
    setCfgMsg('');
    var res = collectConfigBody();
    if (res.error) { setCfgMsg(res.error, 'error'); return; }
    btn.disabled = true; btn.textContent = 'Đang lưu…';
    api('/api/config', { method: 'POST', body: res.body }).then(function (r) {
      if (r.ok && r.body && r.body.ok) {
        setCfgMsg('');
        toast((r.body.data && r.body.data.humanMessage) || 'Đã lưu ✓ — áp dụng từ chu kỳ kế tiếp.');
        var written = (r.body.data && r.body.data.written) || [];
        var deleted = (r.body.data && r.body.data.deleted) || [];
        if (written.indexOf('LLM_API_KEY') !== -1) state.secrets.LLM_API_KEY.set = true;
        if (deleted.indexOf('LLM_API_KEY') !== -1) state.secrets.LLM_API_KEY.set = false;
        if (written.indexOf('GOOGLE_CLIENT_SECRET_WEB') !== -1) state.secrets.GOOGLE_CLIENT_SECRET_WEB.set = true;
        if (deleted.indexOf('GOOGLE_CLIENT_SECRET_WEB') !== -1) state.secrets.GOOGLE_CLIENT_SECRET_WEB.set = false;
        state.secrets.LLM_API_KEY.mode = 'GIỮ'; state.secrets.LLM_API_KEY.value = '';
        state.secrets.GOOGLE_CLIENT_SECRET_WEB.mode = 'GIỮ'; state.secrets.GOOGLE_CLIENT_SECRET_WEB.value = '';
        renderSecrets();
        fetchStatus();
      } else {
        setCfgMsg(humanErr(r, 'Lưu cấu hình thất bại.'), 'error');
      }
      btn.disabled = false; btn.textContent = '💾 Lưu cấu hình';
    });
  }
  function doFeedCheck() {
    var url = $('#cfg-rss-url').value.trim();
    var box = $('#cfg-feed-result');
    var btn = $('#cfg-feed-check');
    box.textContent = '';
    if (!url) {
      box.appendChild(el('div', { class: 'feed-err-box', text: 'Nhập URL feed RSS để kiểm tra.' }));
      return;
    }
    btn.disabled = true; btn.textContent = 'Đang kiểm tra…';
    api('/api/rss-preview?url=' + encodeURIComponent(url)).then(function (r) {
      btn.disabled = false; btn.textContent = '🧪 Kiểm tra feed';
      if (!r.ok || !r.body || !r.body.ok) {
        box.appendChild(el('div', { class: 'feed-err-box', text: 'Không đọc được feed: ' + (humanErr(r, 'kiểm tra URL hoặc kết nối.') ) }));
        return;
      }
      var items = (r.body.data && r.body.data.items) || [];
      if (!items.length) {
        box.appendChild(el('div', { class: 'feed-err-box', text: 'Feed đọc được nhưng không có bài nào — kiểm tra lại URL feed.' }));
        return;
      }
      box.appendChild(el('div', { class: 'feed-ok-box', text: '✓ Đọc được ' + items.length + ' bài. Bài "nóng" nhất:' }));
      box.appendChild(renderFeedItem(items[0]));
      if (items.length > 1) {
        box.appendChild(el('div', { class: 'feed-ok-box', text: '— ' + (items.length - 1) + ' bài còn lại —' }));
        items.slice(1, 6).forEach(function (it, i) {
          box.appendChild(el('p', { class: 'note', text: (i + 2) + '. ' + (it.title || '') }));
        });
      }
    });
  }
  function renderFeedItem(it) {
    var p = el('div', { class: 'feed-preview' });
    p.appendChild(el('h4', { text: it.title || '' }));
    p.appendChild(el('p', { text: it.content || '' }));
    if (it.link) p.appendChild(el('p', { text: 'Nguồn: ' + it.link }));
    return p;
  }
  function fetchCommunities() {
    if (state.inFlight['/api/communities-gui']) return;
    state.inFlight['/api/communities-gui'] = true;
    api('/api/communities').then(function (r) {
      state.inFlight['/api/communities-gui'] = false;
      var wrap = $('#cfg-communities');
      wrap.textContent = '';
      if (!r.ok || !r.body || !r.body.ok) {
        var msg = r.status === 401 || (r.body && r.body.code === 'AUTH_FAILED')
          ? 'Không xác thực được với nền tảng — hãy chạy `npm run setup` để đăng nhập lại.'
          : 'Chưa lấy được danh sách cộng đồng — kiểm tra kết nối Google ở Dashboard.';
        wrap.appendChild(el('p', { class: 'msg msg--warning', text: msg }));
        return;
      }
      var items = (r.body.data && r.body.data.items) || [];
      if (!items.length) {
        wrap.appendChild(el('p', { class: 'note', text: 'Chưa có cộng đồng nào trong tài khoản này.' }));
        return;
      }
      wrap.appendChild(buildCommunitiesTable(items));
      var pick = el('div', { class: 'field-row' });
      var sel = el('select', { 'aria-label': 'Chọn cộng đồng để điền COMMUNITY_ID' });
      sel.appendChild(el('option', { value: '' }, '— Chọn cộng đồng để điền —'));
      var usable = items.filter(function (it) { return it.canPost; });
      usable.forEach(function (it) {
        sel.appendChild(el('option', { value: it.id }, (it.name ? it.name : '?') + ' (' + it.id + ')'));
      });
      if (!usable.length) {
        pick.appendChild(el('span', { class: 'note', text: 'Không có cộng đồng nào với quyền đăng bài (POST_CONTENT).' }));
      } else {
        sel.addEventListener('change', function () {
          if (sel.value) { $('#cfg-community').value = sel.value; setCfgMsg(''); }
        });
        pick.appendChild(sel);
      }
      wrap.appendChild(pick);
    });
  }
  function buildCommunitiesTable(items) {
    var div = el('div', { class: 'tbl-wrap' });
    var t = el('table', { class: 'tbl' });
    var thead = el('thead');
    var hr = el('tr');
    ['ID', 'Tên', 'Vai trò', 'Quyền'].forEach(function (h) { hr.appendChild(el('th', { scope: 'col', text: h })); });
    thead.appendChild(hr);
    t.appendChild(thead);
    var tb = el('tbody');
    items.forEach(function (it) {
      var tr = el('tr');
      tr.appendChild(el('td', { class: 'mono', text: it.id }));
      tr.appendChild(el('td', { text: it.name || '?' }));
      tr.appendChild(el('td', {}, makeBadge('info', it.role || 'MEMBER')));
      tr.appendChild(el('td', {}, it.canPost ? makeBadge('success', '✓ Đăng') : makeBadge('neutral', '—')));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    div.appendChild(t);
    return div;
  }
  function bindConfig() {
    $('#cfg-interval').addEventListener('input', function () {
      var n = parseInt(this.value, 10);
      $('#cfg-interval-hint').textContent = Number.isInteger(n) && n > 0 ? '≈ ' + Math.round(n / 60000) + ' phút' : '';
    });
    $('#cfg-feed-check').addEventListener('click', doFeedCheck);
    $('#cfg-save').addEventListener('click', doSaveConfig);
    $('#cfg-communities-refresh').addEventListener('click', fetchCommunities);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function bindStaticEvents() {
    bindTokenScreen();
    bindNavigation();
    bindControls();
    bindLogs();
    bindHistory();
    bindModal();
    bindConfig();
  }
  function init() {
    bindStaticEvents();
    api('/api/status').then(function (r) {
      if (r.ok && r.body && r.body.ok) {
        state.status = r.body.data;
        enterApp();
      } else if (r.status === 401) {
        showTokenScreen();
      } else {
        showTokenScreen('Không kết nối được máy chủ GUI. Kiểm tra server đang chạy (`npm run web`).');
      }
    });
  }

  init();
})();