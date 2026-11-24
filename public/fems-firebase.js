/* FEMS on Firebase: provides window.claude.use('db' | 'user' | 'downloads') backed by
   Firebase Auth + Cloud Firestore, so the FEMS page runs unchanged outside claude.ai. */
(function () {
  'use strict';
  var CFG = window.FEMS_CONFIG;
  var OWNERS = (CFG.ownerEmails || []).map(function (e) { return String(e).toLowerCase(); });
  firebase.initializeApp(CFG.firebase);
  var auth = firebase.auth();
  var fs = firebase.firestore();
  if (CFG.emulator) {
    auth.useEmulator('http://' + CFG.emulator + ':9099');
    fs.useEmulator(CFG.emulator, 8080);
  }
  try { fs.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (e) {}
  if (!CFG.emulator) fs.enablePersistence({ synchronizeTabs: true }).catch(function () {});

  /* ---------------- helpers ---------------- */
  function E(code, message) { var e = new Error(message || code); e.code = code; e.__fems = true; return e; }
  function mapErr(e) {
    var c = (e && e.code) || '';
    if (c === 'permission-denied') return E('invalid_argument', 'You do not have permission to change this.');
    if (c === 'not-found') return E('invalid_argument', 'That record does not exist.');
    if (c === 'invalid-argument') return E('invalid_argument', e.message);
    if (c === 'resource-exhausted') return E('resource_exhausted', e.message);
    if (c === 'failed-precondition') return E('invalid_argument', e.message);
    return E('unavailable', (e && e.message) || 'Database unavailable');
  }
  // the store keeps plain JSON: Dates become ISO strings, undefined is dropped
  function clean(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw E('invalid_argument', 'A record must be an object.');
    return JSON.parse(JSON.stringify(d));
  }
  function isDenied(e) { return e && e.code === 'permission-denied'; }
  var META0 = Object.freeze({ fromCache: false, hasPendingWrites: false });
  function meta(s) { return { fromCache: !!s.metadata.fromCache, hasPendingWrites: !!s.metadata.hasPendingWrites }; }
  function dsnap(s) {
    var d = s.exists ? s.data() : undefined;
    return { id: s.id, exists: !!s.exists, data: function () { return d; }, metadata: meta(s) };
  }
  function missing(id) { return { id: id, exists: false, data: function () { return undefined; }, metadata: META0 }; }

  /* ---------------- query evaluation (client side, like the original store) ---------------- */
  function cmp(a, b) {
    if (a === b) return 0;
    if (a === undefined || a === null) return 1;
    if (b === undefined || b === null) return -1;
    if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
    return String(a) < String(b) ? -1 : 1;
  }
  function test(v, op, x) {
    switch (op) {
      case '==': return v === x || JSON.stringify(v) === JSON.stringify(x);
      case '!=': return v !== undefined && !(v === x || JSON.stringify(v) === JSON.stringify(x));
      case '<': return v !== undefined && v !== null && v < x;
      case '<=': return v !== undefined && v !== null && v <= x;
      case '>': return v !== undefined && v !== null && v > x;
      case '>=': return v !== undefined && v !== null && v >= x;
      case 'in': return (x || []).some(function (y) { return y === v; });
      case 'not-in': return v !== undefined && !(x || []).some(function (y) { return y === v; });
      case 'array-contains': return Array.isArray(v) && v.indexOf(x) >= 0;
    }
    throw E('invalid_argument', 'Unknown operator ' + op);
  }
  function applyQ(spec, docs) {
    var out = docs.filter(function (d) {
      if (!d.exists) return false;
      var o = d.data();
      return spec.where.every(function (w) { return test(o[w[0]], w[1], w[2]); });
    });
    if (spec.order) {
      var f = spec.order[0], dir = spec.order[1] === 'desc' ? -1 : 1;
      out.sort(function (a, b) {
        var va = a.data()[f], vb = b.data()[f];
        if ((va === undefined) !== (vb === undefined)) return va === undefined ? 1 : -1;
        return dir * cmp(va, vb) || (a.id < b.id ? -1 : 1);
      });
    }
    if (spec.limit) out = out.slice(0, spec.limit);
    return out;
  }
  function qsnap(docs, prev, m) {
    var changes = [];
    var prevIdx = {};
    (prev || []).forEach(function (d, i) { prevIdx[d.id] = i; });
    var nowIdx = {};
    docs.forEach(function (d, i) { nowIdx[d.id] = i; });
    (prev || []).forEach(function (d, i) { if (!(d.id in nowIdx)) changes.push({ type: 'removed', doc: d, oldIndex: i, newIndex: -1 }); });
    docs.forEach(function (d, i) {
      if (!(d.id in prevIdx)) changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i });
      else {
        var p = prev[prevIdx[d.id]];
        if (JSON.stringify(p.data()) !== JSON.stringify(d.data()) || prevIdx[d.id] !== i)
          changes.push({ type: 'modified', doc: d, oldIndex: prevIdx[d.id], newIndex: i });
      }
    });
    return { docs: docs, size: docs.length, empty: docs.length === 0, docChanges: function () { return changes; }, metadata: m || META0 };
  }

  /* ---------------- references ---------------- */
  function docRef(r) {
    return {
      id: r.id, path: r.path,
      get: function () {
        return r.get().then(dsnap, function (e) { if (isDenied(e)) return missing(r.id); throw mapErr(e); });
      },
      set: function (d) {
        var v; try { v = clean(d); } catch (e) { return Promise.reject(e); }
        return r.set(v).catch(function (e) { throw mapErr(e); });
      },
      update: function (d) {
        var v; try { v = clean(d); } catch (e) { return Promise.reject(e); }
        return r.get().then(function (s) {
          if (!s.exists) throw E('invalid_argument', 'That record does not exist.');
          return r.set(v, { merge: true });
        }).catch(function (e) { throw e && e.__fems ? e : mapErr(e); });
      },
      delete: function () { return r.delete().catch(function (e) { throw mapErr(e); }); },
      acquire: function (o) {
        var ttl = Math.min(600000, Math.max(1000, (o && o.ttlMs) || 30000));
        return fs.runTransaction(function (tx) {
          return tx.get(r).then(function (s) {
            var now = Date.now(), L = s.exists && s.data()._lease;
            if (L && L.exp > now && L.h !== o.holder) return { acquired: false, expiresAt: new Date(L.exp).toISOString() };
            var body = Object.assign({}, o.data || {}, { _lease: { h: o.holder, exp: now + ttl } });
            if (s.exists) tx.set(r, clean(body), { merge: true }); else tx.set(r, clean(body));
            return { acquired: true, version: 1, expiresAt: new Date(now + ttl).toISOString(), holder: o.holder };
          });
        }).catch(function (e) { throw mapErr(e); });
      },
      onSnapshot: function (next, error) {
        var dead = false;
        var un = r.onSnapshot(function (s) { if (!dead) next(dsnap(s)); }, function (e) {
          if (dead) return;
          if (isDenied(e)) { next(missing(r.id)); return; }
          dead = true; var x = mapErr(e); if (error) error(x); else console.error(x);
        });
        return function () { dead = true; un(); };
      },
      collection: function (p) { return colRef(r.collection(p)); }
    };
  }
  function query(c, spec) {
    function load() {
      return c.get().then(function (s) { return s.docs.map(dsnap); }, function (e) { if (isDenied(e)) return []; throw mapErr(e); });
    }
    return {
      where: function (f, op, v) { return query(c, { where: spec.where.concat([[f, op, v]]), order: spec.order, limit: spec.limit }); },
      orderBy: function (f, d) { return query(c, { where: spec.where, order: [f, d || 'asc'], limit: spec.limit }); },
      limit: function (n) { return query(c, { where: spec.where, order: spec.order, limit: n }); },
      get: function () { return load().then(function (all) { return qsnap(applyQ(spec, all), null); }); },
      onSnapshot: function (next, error) {
        var prev = null, dead = false;
        var un = c.onSnapshot(function (s) {
          if (dead) return;
          var docs = applyQ(spec, s.docs.map(dsnap));
          var snap = qsnap(docs, prev || [], meta(s)); prev = docs; next(snap);
        }, function (e) {
          if (dead) return;
          if (isDenied(e)) { var snap = qsnap([], prev || []); prev = []; next(snap); return; }
          dead = true; var x = mapErr(e); if (error) error(x); else console.error(x);
        });
        return function () { dead = true; un(); };
      }
    };
  }
  function colRef(c) {
    var q = query(c, { where: [], order: null, limit: 0 });
    q.path = c.path;
    q.doc = function (id) { return docRef(id ? c.doc(id) : c.doc()); };
    q.add = function (d) { var ref = docRef(c.doc()); return ref.set(d).then(function () { return ref; }); };
    return q;
  }
  var DB = Object.freeze({
    doc: function (p) { return docRef(fs.doc(p)); },
    collection: function (p) { return colRef(fs.collection(p)); }
  });

  /* ---------------- downloads ---------------- */
  var DOWNLOADS = Object.freeze({
    save: function (o) {
      return new Promise(function (res, rej) {
        try {
          var data = o.data, type = o.mimeType || o.type || '';
          if (!type) {
            var n = String(o.filename || '').toLowerCase();
            type = /\.pdf$/.test(n) ? 'application/pdf' : /\.xlsx$/.test(n) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : /\.csv$/.test(n) ? 'text/csv' : /\.json$/.test(n) ? 'application/json' : 'application/octet-stream';
          }
          var blob = data instanceof Blob ? data : new Blob([data], { type: type });
          var url = URL.createObjectURL(blob), a = document.createElement('a');
          a.href = url; a.download = o.filename || 'download'; document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
          res({ ok: true });
        } catch (e) { rej(E('unavailable', e.message)); }
      });
    }
  });

  /* ---------------- people ---------------- */
  var ME = null, MEMBER = null, OWNER = false, PROF = {};
  var PAL = ['#0f766e', '#2563eb', '#7c3aed', '#c2410c', '#be185d', '#15803d', '#0369a1', '#a16207'];
  function colorOf(id) { var h = 0; for (var i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0; return PAL[h % PAL.length]; }
  function initials(name, color) {
    var t = String(name || '?').trim().split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase() || '?';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="' + color + '"/><text x="32" y="41" font-family="Arial" font-size="24" font-weight="700" fill="#fff" text-anchor="middle">' + t.replace(/[<&>]/g, '') + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function profileOf(id, p) {
    var name = (p && p.name) || '', color = colorOf(id);
    return { id: id, name: name, avatarUrl: (p && p.photo && /^https:/.test(p.photo)) ? p.photo : initials(name, color), color: color,
      email: (p && p.email) || null, isMe: !!(ME && ME.uid === id), guest: false };
  }
  function canWrite() { return OWNER || !!(MEMBER && MEMBER.level === 'edit'); }
  var dirCache = null, dirAt = 0;
  function directory() {
    if (dirCache && Date.now() - dirAt < 60000) return Promise.resolve(dirCache);
    return fs.collection('profiles').get().then(function (s) {
      dirCache = s.docs.map(function (d) { PROF[d.id] = d.data(); return profileOf(d.id, d.data()); }); dirAt = Date.now(); return dirCache;
    }).catch(function () { return []; });
  }
  var USER = Object.freeze({
    isOwner: function () { return Promise.resolve(OWNER); },
    canEdit: function () { return Promise.resolve(OWNER); },
    can: function (n) { return Promise.resolve(n === 'data.write' ? canWrite() : n === 'files.write' || n === 'assets.write' ? OWNER : false); },
    id: function () { return Promise.resolve(ME ? ME.uid : null); },
    me: function () {
      var p = profileOf(ME.uid, { name: ME.displayName || (ME.email || '').split('@')[0], email: ME.email, photo: ME.photoURL });
      return Promise.resolve({ id: ME.uid, name: p.name, avatarUrl: p.avatarUrl, color: p.color, email: ME.email || null, isOwner: OWNER, canEdit: OWNER });
    },
    name: function () { return USER.me().then(function (m) { return m.name; }); },
    avatarUrl: function () { return USER.me().then(function (m) { return m.avatarUrl; }); },
    email: function () { return Promise.resolve(ME && ME.email || null); },
    profiles: function (ids) {
      ids = typeof ids === 'string' ? [ids] : Array.from(new Set(ids || []));
      var need = ids.filter(function (id) { return id && !(id in PROF) && /^[A-Za-z0-9_-]{6,128}$/.test(id); });
      return Promise.all(need.map(function (id) {
        return fs.doc('profiles/' + id).get().then(function (s) { PROF[id] = s.exists ? s.data() : null; }, function () { PROF[id] = null; });
      })).then(function () {
        var out = {}; ids.forEach(function (id) { out[id] = profileOf(id, PROF[id]); }); return out;
      });
    },
    search: function (q) {
      q = String(q || '').trim().toLowerCase();
      return directory().then(function (all) {
        var hits = all.filter(function (p) { return p.name && (!q || p.name.toLowerCase().indexOf(q) >= 0 || (p.email || '').toLowerCase().indexOf(q) >= 0); });
        return hits.slice(0, 8);
      });
    }
  });

  /* ---------------- sign-in gate ---------------- */
  var readyFn, READY = new Promise(function (r) { readyFn = r; }), isReady = false;
  window.claude = Object.freeze({
    use: function (n) {
      return READY.then(function () { return n === 'db' ? DB : n === 'user' ? USER : n === 'downloads' ? DOWNLOADS : null; });
    }
  });
  window.femsFirebase = { auth: auth, fs: fs, isOwner: function () { return OWNER; } };

  var gate;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function showGate(html) {
    if (!gate) {
      gate = document.createElement('div'); gate.id = 'fbGate';
      (document.body || document.documentElement).appendChild(gate);
    }
    gate.innerHTML = '<div class="fbcard"><div class="fbbrand"><b>FEMS</b><span>Facilities &amp; Engineering Management</span></div>' + html + '</div>';
    gate.hidden = false;
  }
  function hideGate() { if (gate) gate.hidden = true; }
  var mode = 'in', msg = '';
  function signInHtml() {
    return '<h2>' + (mode === 'up' ? 'Create an account' : mode === 'reset' ? 'Reset your password' : 'Sign in') + '</h2>' +
      (mode !== 'reset' ? '<button type="button" class="fbbtn fbg" data-fb="google"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Continue with Google</button><div class="fbor"><span>or with email</span></div>' : '') +
      '<form id="fbForm">' + (mode === 'up' ? '<label>Your name<input name="n" autocomplete="name" required></label>' : '') +
      '<label>Email<input name="e" type="email" autocomplete="email" required></label>' +
      (mode !== 'reset' ? '<label>Password<input name="p" type="password" autocomplete="' + (mode === 'up' ? 'new-password' : 'current-password') + '" minlength="6" required></label>' : '') +
      (msg ? '<p class="fbmsg">' + esc(msg) + '</p>' : '') +
      '<button class="fbbtn fbp" type="submit">' + (mode === 'up' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in') + '</button></form>' +
      '<p class="fblinks">' + (mode === 'in' ? '<a href="#" data-fb="up">Create an account</a> · <a href="#" data-fb="reset">Forgot password?</a>' : '<a href="#" data-fb="in">Back to sign in</a>') + '</p>';
  }
  function renderSignIn() { showGate(signInHtml()); }
  function waitingHtml(u) {
    return '<h2>Waiting for access</h2><p>You are signed in as <b>' + esc(u.email || u.displayName) + '</b>.</p>' +
      '<p>Ask your FEMS administrator or engineering head to give this account access. This page opens by itself once they do.</p>' +
      (u.emailVerified || !u.email ? '' : '<p class="fbmsg">Please also confirm your email address: we sent a link to ' + esc(u.email) + '. <a href="#" data-fb="verify">Send it again</a></p>') +
      '<button type="button" class="fbbtn" data-fb="out">Sign out</button>';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-fb]'); if (!t || !t.closest('#fbGate,#fbAccess,#fbAccBtn')) return;
    e.preventDefault(); var a = t.dataset.fb; msg = '';
    if (a === 'google') {
      var pr = new firebase.auth.GoogleAuthProvider(); pr.setCustomParameters({ prompt: 'select_account' });
      auth.signInWithPopup(pr).catch(function (x) {
        if (x && (x.code === 'auth/popup-blocked' || x.code === 'auth/operation-not-supported-in-this-environment')) return auth.signInWithRedirect(pr);
        if (x && x.code !== 'auth/popup-closed-by-user' && x.code !== 'auth/cancelled-popup-request') { msg = friendly(x); renderSignIn(); }
      });
    } else if (a === 'up' || a === 'in' || a === 'reset') { mode = a; renderSignIn(); }
    else if (a === 'out') { auth.signOut().then(function () { location.reload(); }); }
    else if (a === 'verify') { if (auth.currentUser) auth.currentUser.sendEmailVerification().then(function () { t.textContent = 'Sent'; }); }
  });
  document.addEventListener('submit', function (e) {
    if (!e.target || e.target.id !== 'fbForm') return; e.preventDefault();
    var f = e.target, em = f.e.value.trim(), pw = f.p ? f.p.value : '';
    var btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    var p = mode === 'up'
      ? auth.createUserWithEmailAndPassword(em, pw).then(function (c) { return c.user.updateProfile({ displayName: f.n.value.trim() }).then(function () { return c.user.sendEmailVerification(); }).then(function () { return c.user.reload(); }).then(function () { onUser(auth.currentUser); }); })
      : mode === 'reset' ? auth.sendPasswordResetEmail(em).then(function () { mode = 'in'; msg = 'Check your email for a link to set a new password.'; renderSignIn(); })
      : auth.signInWithEmailAndPassword(em, pw);
    p.catch(function (x) { msg = friendly(x); renderSignIn(); });
  });
  function friendly(x) {
    var c = (x && x.code) || '';
    return ({ 'auth/invalid-credential': 'That email or password is not right.', 'auth/wrong-password': 'That email or password is not right.', 'auth/user-not-found': 'No account uses that email. Create an account first.',
      'auth/email-already-in-use': 'An account already uses that email. Sign in instead.', 'auth/weak-password': 'Use a password of at least 6 characters.',
      'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.', 'auth/network-request-failed': 'No connection. Check the internet and try again.',
      'auth/unauthorized-domain': 'This web address is not allowed to sign in yet. Add it under Authentication › Settings › Authorized domains.' })[c] || (x && x.message) || 'Something went wrong.';
  }

  var memUnsub = null;
  function admit() {
    if (isReady) return; isReady = true; hideGate(); readyFn(); if (OWNER) ownerTools();
  }
  function onUser(u) {
    ME = u;
    if (!u) { if (isReady) { location.reload(); return; } mode = mode === 'up' ? 'up' : 'in'; renderSignIn(); return; }
    OWNER = !!(u.email && u.emailVerified && OWNERS.indexOf(u.email.toLowerCase()) >= 0);
    fs.doc('profiles/' + u.uid).set({ name: u.displayName || (u.email || '').split('@')[0], email: u.email || '', photo: u.photoURL || '', at: new Date().toISOString() }, { merge: true }).catch(function () {});
    if (OWNER) { admit(); return; }
    showGate('<p>Checking access…</p>');
    if (memUnsub) memUnsub();
    memUnsub = fs.doc('members/' + u.uid).onSnapshot(function (s) {
      var m = s.exists ? s.data() : null;
      if (m && m.level && m.level !== 'none') { var changed = isReady && JSON.stringify(m) !== JSON.stringify(MEMBER); MEMBER = m; if (changed) { location.reload(); return; } admit(); }
      else if (isReady) location.reload();
      else showGate(waitingHtml(u));
    }, function () { showGate(waitingHtml(u)); });
  }
  auth.onAuthStateChanged(onUser);
  auth.getRedirectResult().catch(function (x) { msg = friendly(x); if (!auth.currentUser) renderSignIn(); });

  /* ---------------- owner tools: who can open FEMS, import from the Claude version ---------------- */
  var ACC = null;
  function ownerTools() {
    var b = document.createElement('button'); b.id = 'fbAccBtn'; b.type = 'button'; b.textContent = 'Access'; b.title = 'Who can open FEMS';
    b.onclick = openAccess; document.body.appendChild(b);
  }
  function openAccess() {
    var box = document.getElementById('fbAccess');
    if (!box) { box = document.createElement('div'); box.id = 'fbAccess'; document.body.appendChild(box); }
    box.hidden = false; box.innerHTML = '<div class="fbcard fbwide"><p>Loading…</p></div>';
    Promise.all([fs.collection('profiles').get(), fs.collection('members').get(), fs.collection('co').get()]).then(function (r) {
      var mem = {}; r[1].docs.forEach(function (d) { mem[d.id] = d.data(); });
      var codes = r[2].docs.map(function (d) { return d.id; });
      ACC = { people: r[0].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }), mem: mem, codes: codes };
      drawAccess();
    }).catch(function (e) { box.innerHTML = '<div class="fbcard fbwide"><p class="fbmsg">' + esc(e.message) + '</p><button class="fbbtn" data-acc="close">Close</button></div>'; });
  }
  function drawAccess(note) {
    var box = document.getElementById('fbAccess'); if (!box || !ACC) return;
    var rows = ACC.people.filter(function (p) { return p.id !== (ME && ME.uid); }).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).map(function (p) {
      var m = ACC.mem[p.id] || {}, own = OWNERS.indexOf(String(p.email || '').toLowerCase()) >= 0;
      var cs = (m.codes || ['*']).join(', ');
      return '<tr data-uid="' + esc(p.id) + '"><td><b>' + esc(p.name || '(no name)') + '</b><br><small>' + esc(p.email) + '</small></td>' +
        '<td>' + (own ? 'Owner' : '<select data-k="level"><option value="none"' + (!m.level || m.level === 'none' ? ' selected' : '') + '>No access</option><option value="view"' + (m.level === 'view' ? ' selected' : '') + '>Can view</option><option value="edit"' + (m.level === 'edit' ? ' selected' : '') + '>Can view and save</option></select>') + '</td>' +
        '<td>' + (own ? 'All' : '<input data-k="codes" value="' + esc(cs) + '" placeholder="* = all companies">') + '</td>' +
        '<td>' + (own ? '' : '<button class="fbbtn small" data-acc="save">Save</button>') + '</td></tr>';
    }).join('');
    box.innerHTML = '<div class="fbcard fbwide"><div class="fbhead"><h2>Who can open FEMS</h2><button class="fbbtn small" data-acc="close">Close</button></div>' +
      '<p>Everyone who has signed in appears here. Give each person access, and list the company codes they may open (' + esc(ACC.codes.join(', ') || 'none yet') + '), or <code>*</code> for all.</p>' +
      (note ? '<p class="fbok">' + esc(note) + '</p>' : '') +
      '<div class="fbtable"><table><thead><tr><th>Person</th><th>Access</th><th>Companies</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="4">No one else has signed in yet. Ask your team to open this web address and sign in.</td></tr>') + '</tbody></table></div>' +
      '<h3>Move records from the Claude version</h3><p>In the Claude version, open the Administrator console and click <b>Export all data</b>. Then choose that file here.</p>' +
      '<label class="fbbtn small fbfile">Choose export file…<input type="file" accept=".json,application/json" data-acc="import" hidden></label> <span id="fbImp"></span>' +
      '<p style="margin-top:16px"><button class="fbbtn small" data-fb="out">Sign out of ' + esc(ME && ME.email) + '</button></p></div>';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-acc]'); if (!t || !OWNER) return;
    if (t.dataset.acc === 'close') { document.getElementById('fbAccess').hidden = true; return; }
    if (t.dataset.acc === 'save') {
      var tr = t.closest('tr'), uid = tr.dataset.uid, lv = tr.querySelector('[data-k=level]').value;
      var codes = tr.querySelector('[data-k=codes]').value.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
      if (!codes.length) codes = ['*'];
      var p = ACC.people.find(function (x) { return x.id === uid; }) || {};
      var op = lv === 'none' ? fs.doc('members/' + uid).delete() : fs.doc('members/' + uid).set({ level: lv, codes: codes, email: p.email || '', name: p.name || '', by: ME.email, at: new Date().toISOString() });
      t.disabled = true;
      op.then(function () { if (lv === 'none') delete ACC.mem[uid]; else ACC.mem[uid] = { level: lv, codes: codes }; drawAccess('Saved for ' + (p.name || p.email) + '.'); })
        .catch(function (x) { t.disabled = false; alert('Could not save: ' + x.message); });
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target; if (!t || t.dataset.acc !== 'import' || !OWNER || !t.files[0]) return;
    var out = document.getElementById('fbImp'), rd = new FileReader();
    rd.onload = function () {
      var B; try { B = JSON.parse(rd.result); } catch (x) { out.textContent = 'That file is not a FEMS export.'; return; }
      var P = Object.entries(B.docs || {}).filter(function (x) { return !/^data\/users\//.test(x[0]) && x[0].split('/').length % 2 === 0; });
      if (!P.length) { out.textContent = 'That file has no records.'; return; }
      if (!confirm('Copy ' + P.length + ' records into this FEMS? Records with the same name are replaced.')) return;
      var i = 0, fail = 0;
      (function step() {
        if (i >= P.length) { out.textContent = 'Done: ' + (P.length - fail) + ' records copied' + (fail ? ', ' + fail + ' failed' : '') + '. Reload the page to see them.'; return; }
        var b = fs.batch(); P.slice(i, i + 400).forEach(function (x) { b.set(fs.doc(x[0]), clean(x[1])); });
        var n = Math.min(400, P.length - i);
        b.commit().then(function () { i += n; out.textContent = 'Copying… ' + i + ' of ' + P.length; step(); },
          function (x) { fail += n; i += n; console.error(x); step(); });
      })();
    };
    rd.readAsText(t.files[0]);
  });
})();
