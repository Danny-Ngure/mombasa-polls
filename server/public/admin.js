/* Mombasa Ni Yetu Polls - administrator client. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
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
  function say(m) {
    $('msg').textContent = m;
    setTimeout(function () { if ($('msg').textContent === m) $('msg').textContent = ''; }, 4200);
  }

  var state = null;

  function render() {
    var p = state.poll, t = state.totals;
    $('statusPill').className = 'pill' +
      (p.phase === 'open' ? ' live' : (p.phase === 'closed' ? ' shut' : ''));
    $('statusTxt').textContent =
      p.phase === 'open' ? 'Live' : (p.phase === 'closed' ? 'Closed' : 'Not started');

    $('stats').innerHTML =
      'Status <b>' + (p.phase === 'open' ? 'Open' : p.phase === 'closed' ? 'Closed' : 'Not started') + '</b>' +
      'Total votes <b>' + t.total + '</b>' +
      'Counted <b>' + t.counted + '</b>' +
      'Marked invalid <b>' + t.invalid + '</b>' +
      (p.closesAt ? 'Closes <b>' + new Date(p.closesAt).toLocaleString() + '</b>' : '') +
      'Verification <b>' + (state.otpEnabled ? 'Phone OTP' : 'None') + '</b>' +
      'CAPTCHA <b>' + (state.captchaEnabled ? 'On' : 'Off') + '</b>';

    var ctl = $('controls'); ctl.innerHTML = '';
    function mk(label, cls, action, hours) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ' + cls; b.textContent = label;
      b.addEventListener('click', function () {
        api('/api/admin/poll', { method: 'POST',
          body: JSON.stringify({ action: action, hours: hours }) })
          .then(function () { say('Updated.'); return load(); })
          .catch(function (e) { say(e.message); });
      });
      ctl.appendChild(b);
    }
    if (p.phase === 'idle') mk('Open poll', 'btn-primary', 'start');
    if (p.phase === 'open') mk('Close poll now', 'btn-danger', 'close');
    if (p.phase === 'closed') mk('Re-open poll', 'btn-ghost', 'start');

    if (document.activeElement !== $('pubAfter')) $('pubAfter').checked = !!p.publishAfterClose;
    if (document.activeElement !== $('contactAddr')) $('contactAddr').value = p.contactEmail || '';
    $('retDays').textContent = state.retentionDays;

    $('tallyRows').innerHTML = t.perCandidate.slice()
      .sort(function (a, b) { return b.count - a.count; })
      .map(function (c) {
        return '<tr><td>' + esc(c.name) + '</td><td class="num">' + c.count + '</td></tr>';
      }).join('');

    $('rows').innerHTML = state.submissions.slice()
      .sort(function (a, b) { return b.createdAt - a.createdAt; })
      .map(function (s) {
        return '<tr class="' + (s.invalid ? 'tbl-invalid' : '') + '">' +
          '<td>' + new Date(s.createdAt).toLocaleString() + '</td>' +
          '<td>' + esc(s.fullName) + '</td>' +
          '<td>' + esc(s.constituency) + '</td>' +
          '<td>' + esc(s.ageBracket) + '</td>' +
          '<td>' + esc(s.gender === 'Other' && s.genderOther
                       ? 'Other: ' + s.genderOther : s.gender) + '</td>' +
          '<td>' + esc(s.candidate) + '</td>' +
          '<td>' + esc(s.voterRef) + '</td>' +
          '<td>' + esc((s.flags || []).join(' ')) + '</td>' +
          '<td>' + (s.invalid ? 'Invalid' : 'Counted') + '</td>' +
          '<td><button type="button" class="btn btn-ghost" data-id="' + esc(s.id) +
            '" data-inv="' + (s.invalid ? '0' : '1') + '">' +
            (s.invalid ? 'Restore' : 'Mark invalid') + '</button></td></tr>';
      }).join('') || '<tr><td colspan="10">No submissions yet.</td></tr>';

    Array.prototype.forEach.call($('rows').querySelectorAll('[data-id]'), function (b) {
      b.addEventListener('click', function () {
        api('/api/admin/vote/' + encodeURIComponent(b.dataset.id) + '/invalid', {
          method: 'POST', body: JSON.stringify({ invalid: b.dataset.inv === '1' })
        }).then(function () { say('Tally updated.'); return load(); })
          .catch(function (e) { say(e.message); });
      });
    });

    $('auditRows').innerHTML = state.audit.map(function (a) {
      return '<tr><td>' + new Date(a.at).toLocaleString() + '</td><td>' + esc(a.action) +
        '</td><td>' + esc(a.detail) + '</td><td>' + esc(a.actor) + '</td></tr>';
    }).join('') || '<tr><td colspan="4">No administrative actions recorded.</td></tr>';
  }

  function load() {
    return api('/api/admin/state').then(function (s) {
      state = s; $('loginPanel').hidden = true; $('dash').hidden = false; render();
    });
  }

  $('loginBtn').addEventListener('click', function () {
    $('loginMsg').textContent = '';
    api('/api/admin/login', { method: 'POST',
      body: JSON.stringify({ username: $('u').value, password: $('p').value }) })
      .then(load)
      .catch(function (e) { $('loginMsg').textContent = e.message; });
  });
  $('p').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('loginBtn').click();
  });

  $('saveBtn').addEventListener('click', function () {
    api('/api/admin/settings', { method: 'POST', body: JSON.stringify({
      publishAfterClose: $('pubAfter').checked, contactEmail: $('contactAddr').value.trim()
    }) }).then(function () { say('Settings saved.'); return load(); })
      .catch(function (e) { say(e.message); });
  });

  $('purgeBtn').addEventListener('click', function () {
    if (!window.confirm('Permanently anonymise submissions older than the retention period? '
      + 'Names and constituencies will be destroyed. This cannot be undone.')) return;
    api('/api/admin/purge', { method: 'POST' })
      .then(function (r) { say(r.purged + ' submission(s) anonymised.'); return load(); })
      .catch(function (e) { say(e.message); });
  });

  $('outBtn').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST' }).then(function () { location.reload(); });
  });

  // Already signed in? Go straight to the dashboard.
  load().catch(function () { $('loginPanel').hidden = false; });

  var socket = io({ withCredentials: true });
  socket.on('admin:dirty', function () { load().catch(function () {}); });
  socket.on('poll', function () { load().catch(function () {}); });
})();
