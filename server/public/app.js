/* Mombasa Ni Yetu Polls - voter client.
   All tallying happens on the server; this file only renders what it is sent,
   and the server sends percentages only, never counts. */
(function () {
  'use strict';

  var S = {
    cfg: null, poll: { phase: 'idle' }, results: null,
    picked: null, voted: false, busy: false, showTable: false,
    otpRequired: false, otpVerified: false, captchaToken: '', stale: false
  };
  var CAND = [];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function byId(id) {
    for (var i = 0; i < CAND.length; i++) if (CAND[i].id === id) return CAND[i];
    return null;
  }
  function pctTxt(v) { return (Math.round(v * 10) / 10).toFixed(1) + '%'; }

  function api(path, opts) {
    return fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')'));
        return j;
      });
    });
  }

  /* ------------------------------- countdown ------------------------------ */
  function tick() {
    var p = S.poll.phase, pill = $('statusPill'), txt = $('statusTxt'),
        val = $('cdVal'), lbl = $('cdLbl');
    pill.className = 'pill' + (p === 'open' ? ' live' : (p === 'closed' ? ' shut' : ''));
    if (p === 'idle') {
      txt.textContent = 'Not started'; val.textContent = '--:--:--';
      lbl.textContent = 'Awaiting start';
    } else if (p === 'closed') {
      txt.textContent = 'Closed'; val.textContent = '00:00:00';
      lbl.textContent = 'Poll closed';
    } else {
      txt.textContent = 'Live';
      // With no closing time the clock counts up from when the poll opened.
      var closing = !!S.poll.closesAt;
      var ms = closing ? Math.max(0, S.poll.closesAt - Date.now())
                       : Math.max(0, Date.now() - (S.poll.opensAt || Date.now()));
      var h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000),
          s = Math.floor(ms % 60000 / 1000);
      val.textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m +
                        ':' + (s < 10 ? '0' : '') + s;
      lbl.textContent = closing ? 'Time remaining' : 'Time open';
      if (closing && ms === 0) { S.poll.phase = 'closed'; render(); }
    }
  }

  /* --------------------------------- form --------------------------------- */
  /* Options come from the server, so the choices a voter can pick can never
     drift from the values the server accepts. */
  function fillSelect(id, values, placeholder) {
    var sel = $(id);
    sel.innerHTML = '<option value="">' + esc(placeholder) + '</option>' +
      values.map(function (v) {
        return '<option value="' + esc(v) + '">' + esc(v) + '</option>';
      }).join('');
  }
  function buildForm(cfg) {
    fillSelect('ageBracket', cfg.ageBrackets, 'Select your age bracket');
    fillSelect('constituency', cfg.constituencies, 'Select your constituency');
    fillSelect('gender', cfg.genders, 'Select');
  }

  /* ------------------------------- candidates ----------------------------- */
  function buildCards() {
    var host = $('candList'); host.innerHTML = '';
    CAND.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'cand';
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', 'Vote for ' + c.name + ', ' + c.party);
      b.dataset.id = c.id;
      b.innerHTML =
        '<span class="cand-rail" style="background:' + c.color + '"></span>' +
        '<span class="cand-photo"><img src="' + c.photo + '" alt="Portrait of ' +
          esc(c.name) + '" loading="lazy"></span>' +
        '<span class="cand-info">' +
          '<span class="cand-name">' + esc(c.name) + '</span>' +
          '<span class="cand-party"><img src="' + c.logo + '" alt="' + esc(c.party) +
            ' party logo"><span>' + esc(c.party) + '</span></span>' +
        '</span>' +
        '<span class="chip">Vote</span>';
      b.addEventListener('click', function () {
        S.picked = c.id; $('e-cand').hidden = true; paintCards(); openDialog();
      });
      host.appendChild(b);
    });
  }
  function paintCards() {
    var kids = $('candList').children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].setAttribute('aria-pressed',
        kids[i].dataset.id === S.picked ? 'true' : 'false');
    }
  }

  /* -------------------------------- results ------------------------------- */
  function renderResults() {
    var r = S.results;
    if (!r) return;

    var lead = $('leaderBox');
    if (!r.hasVotes) {
      lead.innerHTML = '<div class="leader"><div class="leader-txt">' +
        '<div class="leader-lbl">No votes yet</div>' +
        '<div class="leader-party">Standings appear as soon as votes are cast.</div>' +
        '</div></div>';
    } else {
      var top = r.leader || (r.tiedLeaders && r.tiedLeaders[0]) || r.standings[0];
      var c = byId(top.id) || {};
      lead.innerHTML = '<div class="leader" style="--pc:' + (c.color || 'var(--accent)') + '">' +
        (c.photo ? '<img src="' + c.photo + '" alt="">' : '') +
        '<div class="leader-txt"><div class="leader-lbl">' +
          (r.tiedLeaders ? 'Joint lead' : 'Currently leading') + '</div>' +
        '<div class="leader-name">' + esc(top.name) + '</div>' +
        '<div class="leader-party">' + esc(top.party) + '</div></div>' +
        '<div class="leader-pct">' + pctTxt(top.pct) + '</div></div>';
    }

    $('bars').innerHTML = r.standings.map(function (s) {
      var c = byId(s.id) || {};
      return '<div class="bar-row" tabindex="0" style="--pc:' +
        (c.color || 'var(--accent)') + '" aria-label="' + esc(s.name) + ', ' +
        esc(s.party) + ', ' + pctTxt(s.pct) + '">' +
        '<span class="bar-rail"></span>' +
        (c.photo ? '<img class="bar-face" src="' + c.photo + '" alt="">' : '<span></span>') +
        '<div class="bar-mid"><div class="bar-label">' +
          '<span class="bar-name">' + esc(s.name) + '</span>' +
          '<span class="bar-party">' + esc(s.party) + '</span></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + s.pct +
            '%"></div></div></div>' +
        '<div class="bar-pct">' + pctTxt(s.pct) + '</div></div>';
    }).join('');

    $('tableBody').innerHTML = r.standings.map(function (s) {
      return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.party) +
             '</td><td class="num">' + pctTxt(s.pct) + '</td></tr>';
    }).join('');

    demo('ageBars', r.demographics.age);
    demo('genBars', r.demographics.gender);

    $('stamp').textContent = S.stale
      ? 'Live connection interrupted — figures may be out of date.'
      : 'Last updated ' + new Date(r.updatedAt).toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        }) + ' · updates automatically';
  }

  function demo(hostId, rows) {
    $(hostId).innerHTML = rows.map(function (d) {
      return '<div class="drow"><span class="dl">' + esc(d.label) + '</span>' +
        '<span class="dp">' + pctTxt(d.pct) + '</span>' +
        '<span class="dtrack"><span class="dfill" style="width:' + d.pct +
        '%"></span></span></div>';
    }).join('');
  }

  /* ------------------------- optional verification ------------------------ */
  function mountExtras() {
    if (S.otpRequired && !$('otpBlock')) {
      var box = document.createElement('div');
      box.id = 'otpBlock';
      box.style.cssText = 'margin-top:16px;padding-top:15px;border-top:1px solid var(--line)';
      box.innerHTML =
        '<div class="demo-h">Verify your phone number</div>' +
        '<div class="grid2">' +
          '<div class="field"><label class="lbl" for="otpPhone">Phone number</label>' +
            '<input type="text" id="otpPhone" inputmode="tel" placeholder="07XX XXX XXX">' +
            '<span class="hint">Stored only as a one-way hash, never in readable form.</span>' +
          '</div>' +
          '<div class="field"><label class="lbl" for="otpCode">6-digit code</label>' +
            '<input type="text" id="otpCode" inputmode="numeric" maxlength="6" ' +
              'placeholder="000000"></div>' +
        '</div>' +
        '<div class="adminrow" style="margin-top:12px">' +
          '<button type="button" class="btn btn-ghost" id="otpSend">Send code</button>' +
          '<button type="button" class="btn btn-ghost" id="otpCheck">Verify</button>' +
          '<span class="stamp" id="otpMsg"></span></div>';
      var dlg = $('detailsDlg');
      dlg.insertBefore(box, dlg.querySelector('.submitbar'));
      $('otpSend').addEventListener('click', function () {
        $('otpMsg').textContent = 'Sending…';
        api('/api/otp/request', { method: 'POST',
          body: JSON.stringify({ phone: $('otpPhone').value }) })
          .then(function () { $('otpMsg').textContent = 'Code sent. Check your messages.'; })
          .catch(function (e) { $('otpMsg').textContent = e.message; });
      });
      $('otpCheck').addEventListener('click', function () {
        api('/api/otp/verify', { method: 'POST',
          body: JSON.stringify({ phone: $('otpPhone').value, code: $('otpCode').value }) })
          .then(function () {
            S.otpVerified = true;
            $('otpMsg').textContent = 'Verified. You can now cast your vote.';
          })
          .catch(function (e) { $('otpMsg').textContent = e.message; });
      });
    }

    if (S.cfg.captchaSiteKey && !$('capBlock')) {
      var cap = document.createElement('div');
      cap.id = 'capBlock';
      cap.style.cssText = 'margin-top:14px';
      cap.innerHTML = '<div class="h-captcha" data-sitekey="' +
        esc(S.cfg.captchaSiteKey) + '" data-callback="onCaptcha"></div>';
      $('castBtn').parentNode.insertBefore(cap, $('castBtn'));
      var sc = document.createElement('script');
      sc.src = 'https://hcaptcha.com/1/api.js'; sc.async = true; sc.defer = true;
      document.head.appendChild(sc);
      window.onCaptcha = function (t) { S.captchaToken = t; };
    }
  }

  /* -------------------------------- voting -------------------------------- */
  function validate() {
    var ok = true;
    function mark(fid, eid, bad) {
      $(fid).classList.toggle('bad', bad); $(eid).hidden = !bad; if (bad) ok = false;
    }
    mark('f-name', 'e-name', $('fullName').value.trim().length < 2);
    mark('f-age', 'e-age', !$('ageBracket').value);
    mark('f-con', 'e-con', !$('constituency').value);
    mark('f-gen', 'e-gen', !$('gender').value);
    if (!S.picked) { $('e-cand').hidden = false; ok = false; } else { $('e-cand').hidden = true; }
    return ok;
  }

  function cast() {
    if (S.busy) return;
    if (!validate()) {
      var bad = document.querySelector('.field.bad, .err:not([hidden])');
      if (bad) bad.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (S.otpRequired && !S.otpVerified) {
      $('castNote').textContent = 'Verify your phone number before voting.';
      return;
    }
    S.busy = true; $('castBtn').disabled = true; $('castBtn').textContent = 'Recording…';

    api('/api/vote', {
      method: 'POST',
      body: JSON.stringify({
        fullName: $('fullName').value.trim(),
        ageBracket: $('ageBracket').value,
        constituency: $('constituency').value,
        gender: $('gender').value,
        candidateId: S.picked,
        captchaToken: S.captchaToken
      })
    }).then(function (j) {
      S.busy = false; S.voted = true; S.results = j.results;
      closeDialog(); render();
      var rv = $('resultsView'); if (rv) rv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      S.busy = false; $('castBtn').disabled = false; $('castBtn').textContent = 'Submit Vote';
      $('castNote').textContent = e.message;
      if (/already/i.test(e.message)) { S.voted = true; loadResults(); }
    });
  }

  /* ---------------------------- details dialog ---------------------------- */
  function openDialog() {
    if (!S.picked) {
      $('e-cand').hidden = false;
      $('candList').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    $('e-cand').hidden = true;
    var c = byId(S.picked);
    $('dlgPick').innerHTML = c ? (
      '<img src="' + c.photo + '" alt="">' +
      '<div><div class="dp-lbl">Your choice</div>' +
      '<div class="dp-name">' + esc(c.name) + '</div>' +
      '<div class="dp-party">' + esc(c.party) + '</div></div>') : '';
    var d = $('detailsDlg');
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    setTimeout(function () { var n = $('fullName'); if (n) n.focus(); }, 40);
  }
  function closeDialog() {
    var d = $('detailsDlg');
    if (!d) return;
    if (typeof d.close === 'function') { if (d.open) d.close(); }
    else d.removeAttribute('open');
  }

  /* --------------------------------- views -------------------------------- */
  function noticeOnly(kind) {
    closeDialog();
    $('voteView').hidden = true; $('resultsView').hidden = true; $('bootState').hidden = true;
    var n = $('noticeBox'); n.hidden = false; n.className = 'notice';
    n.innerHTML = {
      idle: '<h2>Voting has not opened yet</h2><p>The poll has not been opened by ' +
            'the administrator. Check back shortly.</p>',
      closedNoVote: '<h2>The poll has closed</h2><p>Voting is closed. Results were shown ' +
            'only to people who cast a vote while the poll was open.</p>',
      offline: '<h2>Cannot reach the poll</h2><p>The results service is unavailable. ' +
            'Please reload the page in a moment.</p>'
    }[kind];
  }

  function render() {
    $('bootState').hidden = true;
    var p = S.poll.phase;

    if (S.voted || (p === 'closed' && S.poll.publishAfterClose && S.results)) {
      closeDialog();
      $('noticeBox').hidden = true; $('voteView').hidden = true; $('resultsView').hidden = false;
      $('confirmBox').hidden = !S.voted;
      renderResults();
    } else if (p === 'open') {
      $('noticeBox').hidden = true; $('resultsView').hidden = true; $('voteView').hidden = false;
      mountExtras(); paintCards();
    } else if (p === 'closed') {
      noticeOnly('closedNoVote');
    } else {
      noticeOnly('idle');
    }

    $('footContact').textContent = (S.poll.contactEmail)
      ? 'Data deletion or correction requests: ' + S.poll.contactEmail : '';
  }

  function loadResults() {
    return api('/api/results').then(function (r) {
      S.results = r; S.stale = false; render();
    }).catch(function () { /* not entitled to see results yet */ });
  }

  /* Polling fallback for hosts without websockets. Only runs while the tab is
     visible, so a forgotten tab does not keep hitting the server. */
  function startPolling() {
    var every = 4000;
    setInterval(function () {
      if (document.hidden) return;
      api('/api/config').then(function (cfg) {
        var was = S.poll.phase;
        S.poll = cfg.poll;
        if (cfg.voted && !S.voted) S.voted = true;
        if (was !== S.poll.phase) { tick(); render(); }
      }).catch(function () {});
      if (S.voted || (S.poll.phase === 'closed' && S.poll.publishAfterClose)) loadResults();
    }, every);
  }

  /* --------------------------------- boot --------------------------------- */
  $('castBtn').addEventListener('click', cast);
  $('dlgClose').addEventListener('click', closeDialog);
  $('detailsDlg').addEventListener('click', function (e) {
    if (e.target === this) closeDialog();   // click outside the card closes it
  });
  $('tblToggle').addEventListener('click', function () {
    S.showTable = !S.showTable;
    $('tableView').hidden = !S.showTable; $('bars').hidden = S.showTable;
    this.setAttribute('aria-expanded', S.showTable ? 'true' : 'false');
    this.textContent = S.showTable ? 'View as chart' : 'View as table';
  });
  setInterval(tick, 1000);

  api('/api/config').then(function (cfg) {
    S.cfg = cfg; CAND = cfg.candidates; S.poll = cfg.poll;
    S.voted = cfg.voted; S.otpRequired = cfg.otpRequired;
    buildForm(cfg); buildCards(); tick(); render();
    if (S.voted) loadResults();

    // Websockets where the host supports them (local, Render, Docker);
    // short polling where it cannot hold a connection open (Vercel).
    if (typeof io === 'function') {
      var socket = io({ withCredentials: true });
      socket.on('connect', function () { S.stale = false; });
      socket.on('disconnect', function () { S.stale = true; renderResults(); });
      socket.on('poll', function (p) {
        S.poll = Object.assign({}, S.poll, p); tick(); render();
      });
      socket.on('results', function (r) { S.results = r; render(); });
    } else {
      startPolling();
    }
  }).catch(function () {
    noticeOnly('offline');
  });
})();
