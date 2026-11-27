(function () {
  "use strict";
  var CFG = window.CRUSCOTTO;
  var sb = window.supabase.createClient(CFG.url, CFG.anon, { auth: { persistSession: true, autoRefreshToken: true } });
  var TZ = "Europe/Rome";
  var AREAS = { maunsell: "Maunsell", medoacus: "Medoacus", linkedin: "LinkedIn", scuola: "Scuola", vita: "Vita" };
  var DEFAULTS = { maunsell: "#2F6FB5", medoacus: "#B8344A", linkedin: "#0E8C8C", scuola: "#7B5EA7", vita: "#D9822B" };
  var STATUS = { idea: "Idea", bozza: "Bozza", pubblicato: "Pubblicato" };
  var NEXT_STATUS = { idea: "bozza", bozza: "pubblicato", pubblicato: "bozza" };
  var NEXT_LABEL = { idea: "Segna come bozza", bozza: "Segna come pubblicato", pubblicato: "Rimetti in bozza" };
  var RUNS = [[6, 42], [14, 37], [17, 44]];
  var FORMS = {
    task: { label: "compito", coll: "tasks", fields: [["title", "Compito", "text", 1], ["area", "Area", "area"], ["due", "Scadenza", "date"]] },
    event: { label: "impegno", coll: "events", fields: [["title", "Titolo", "text", 1], ["date", "Giorno", "date", 1], ["start", "Inizio", "time"], ["end", "Fine", "time"], ["area", "Area", "area"], ["note", "Luogo o nota", "text"]] },
    post: { label: "post", coll: "posts", fields: [["title", "Titolo", "text", 1], ["area", "Area", "area"], ["channel", "Canale", "text"], ["lang", "Lingua", "lang"], ["when", "Data prevista", "date"], ["status", "Stato", "status"], ["body", "Testo", "ta"], ["note", "Nota", "tas"]] }
  };
  var S = { gcal: null, gsync: { busy: false, err: "", calendars: null }, brief: null, tasks: [], posts: [], events: [], blocks: [], notes: [], spese: [], fit: [], posta: [], postaState: null, colors: {}, filter: "tutto", open: {}, weekStart: null, evIndex: {}, edit: null, delArmed: false, ready: false };
  try { var f0 = localStorage.getItem("cf-filter"); if (f0 && (f0 === "tutto" || AREAS[f0])) S.filter = f0; } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeUrl(u) { return typeof u === "string" && /^https:\/\//.test(u) ? u : ""; }
  function areaTag(a) { return a && AREAS[a] ? '<span class="tag" data-area="' + esc(a) + '"><i class="da"></i>' + AREAS[a] + "</span>" : ""; }
  function show(a) { return S.filter === "tutto" || !a || a === S.filter; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function validHex(c) { return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c); }
  function validDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  /* ---------- date (Europe/Rome) ---------- */
  function romeParts() {
    var o = {};
    new Intl.DateTimeFormat("it-IT", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).forEach(function (x) { o[x.type] = x.value; });
    return o;
  }
  function todayKey() { var o = romeParts(); return o.year + "-" + o.month + "-" + o.day; }
  function keyOf(date) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
  function addDays(key, n) { var p = key.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
  function weekMonday(key) { var p = key.split("-").map(Number); return addDays(key, -((new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7)); }
  function weekDays() { var d = [], i; for (i = 0; i < 7; i++) d.push(addDays(S.weekStart, i)); return d; }
  function dayLabel(key, long) {
    var p = key.split("-").map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    return d.toLocaleDateString("it-IT", long ? { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" } : { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  }
  function isoWeek(key) {
    var p = key.split("-").map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2])), day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    return Math.ceil(((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7);
  }
  function hhmm(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("it-IT", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }); }

  /* ---------- livello dati: tabella docs di Supabase con la stessa interfaccia della pagina in Claude ---------- */
  var store = {}; // collection -> Map(id -> data)
  var listeners = {}; // collection -> [fn]
  var channels = {};
  function coll(c) { return store[c] || (store[c] = new Map()); }
  function notify(c) { (listeners[c] || []).forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }
  function snapList(c) { var out = []; coll(c).forEach(function (v, k) { out.push(Object.assign({ id: k }, v)); }); return out; }

  var DB = {
    watch: function (c, fn) {
      (listeners[c] = listeners[c] || []).push(fn);
      if (channels[c]) { fn(); return; }
      sb.from("docs").select("id,data").eq("collection", c).then(function (r) {
        if (r.error) { dbError(r.error); return; }
        var m = coll(c); m.clear();
        (r.data || []).forEach(function (row) { m.set(row.id, row.data || {}); });
        arrived(); notify(c);
      });
      channels[c] = sb.channel("docs-" + c)
        .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "collection=eq." + c }, function (p) {
          if (p.eventType === "DELETE") coll(c).delete(p.old.id);
          else coll(c).set(p.new.id, p.new.data || {});
          notify(c);
        })
        .subscribe();
    },
    set: function (c, id, data) {
      coll(c).set(id, data); notify(c);
      return sb.from("docs").upsert({ collection: c, id: id, data: data, updated_at: new Date().toISOString() }).then(chk);
    },
    update: function (c, id, patch) {
      coll(c).set(id, Object.assign({}, coll(c).get(id) || {}, patch)); notify(c);
      return sb.rpc("merge_doc", { p_collection: c, p_id: id, p_patch: patch }).then(chk);
    },
    add: function (c, data) {
      var id = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "").slice(0, 12);
      return DB.set(c, id, data);
    },
    del: function (c, id) {
      coll(c).delete(id); notify(c);
      return sb.from("docs").delete().eq("collection", c).eq("id", id).then(chk);
    }
  };
  function chk(r) { if (r && r.error) { throw r.error; } return r; }

  /* ---------- eventi: riepilogo di Claude + impegni tuoi + blocchi confermati ---------- */
  function guessArea(t, loc) {
    var s = (t || "") + " " + (loc || "");
    if (/\bC_M\b|ITIS|Fermi|Ricevimento genitori|Interrogazione|consiglio di classe|collegio docenti/i.test(s)) return "scuola";
    if (/Maunsell|Felician|New York|Today International|vacanz[ae] studio|West USA/i.test(s)) return "maunsell";
    if (/Medoacus/i.test(s)) return "medoacus";
    if (/LinkedIn/i.test(s)) return "linkedin";
    return "vita";
  }
  function eventsForWeek() { var days = weekDays(); return eventsFor(days[0], days[6]); }
  function eventsFor(from, to) {
    var list = [];
    if (S.gcal && Array.isArray(S.gcal.events)) {
      S.gcal.events.forEach(function (e) {
        list.push({ id: e.id, src: "gcal", title: e.title, date: e.date, start: e.start || "", end: e.end || "", note: e.note || "", area: guessArea(e.title, e.note) });
      });
    } else {
      ((S.brief && S.brief.events) || []).forEach(function (e, i) {
        list.push({ id: "b" + i, src: "brief", title: e.title, date: e.date, start: e.start || "", end: e.end || "", note: e.note || "", area: AREAS[e.area] ? e.area : guessArea(e.title, e.note) });
      });
    }
    S.events.forEach(function (d) { list.push({ id: d.id, src: "user", title: d.title || "(senza titolo)", date: d.date, start: d.start || "", end: d.end || "", note: d.note || "", area: AREAS[d.area] ? d.area : "vita" }); });
    S.blocks.forEach(function (b) {
      if (b.status === "confermato") list.push({ id: b.id, src: "block", title: "Blocco · " + b.title, date: b.date, start: b.start || "", end: b.end || "", note: b.why || "", area: AREAS[b.area] ? b.area : "vita" });
    });
    return list.filter(function (e) { return e.date >= from && e.date <= to && show(e.area); })
      .sort(function (a, b) { return (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")); });
  }

  /* ---------- rendering ---------- */
  function renderHead() {
    var key = todayKey();
    $("today").textContent = cap(dayLabel(key, true));
    $("week").textContent = "Settimana " + isoWeek(key);
    var o = romeParts(), now = Number(o.hour) * 60 + Number(o.minute), nxt = null, tomorrow = false, i;
    for (i = 0; i < RUNS.length; i++) { if (RUNS[i][0] * 60 + RUNS[i][1] > now) { nxt = RUNS[i]; break; } }
    if (!nxt) { nxt = RUNS[0]; tomorrow = true; }
    $("next").textContent = "Prossimo aggiornamento " + (tomorrow ? "domani " : "") + pad(nxt[0]) + ":" + pad(nxt[1]);
    var b = S.brief;
    $("upd").textContent = b && b.updatedAt ? "Aggiornato alle " + hhmm(b.updatedAt) + (b.run ? " · " + b.run : "") : "In attesa del primo aggiornamento";
    $("dot").className = "dot" + (b ? " live" : "");
  }
  function buildChips() {
    $("chips").innerHTML = [["tutto", "Tutto"]].concat(Object.keys(AREAS).map(function (k) { return [k, AREAS[k]]; })).map(function (x) {
      return '<button type="button" class="chip"' + (x[0] !== "tutto" ? ' data-area="' + x[0] + '"' : "") + ' data-filter="' + x[0] + '" aria-pressed="false">' + (x[0] !== "tutto" ? '<i class="da"></i>' : "") + x[1] + "</button>";
    }).join("");
    $("newarea").innerHTML = Object.keys(AREAS).map(function (k) { return '<option value="' + k + '">' + AREAS[k] + "</option>"; }).join("");
    markChips();
  }
  function markChips() {
    var c = document.querySelectorAll(".chip"), i;
    for (i = 0; i < c.length; i++) c[i].setAttribute("aria-pressed", String(c[i].getAttribute("data-filter") === S.filter));
  }
  function renderBrief() {
    var b = S.brief;
    $("summary").textContent = b && b.summary ? b.summary : "Il riepilogo compare dopo il primo aggiornamento automatico: agenda, email da gestire, compiti e bozze LinkedIn.";
    var pr = ((b && b.priorities) || []).filter(function (p) { return show(p.area); });
    $("prios").innerHTML = pr.length ? pr.map(function (p, i) {
      return '<li><span class="rank">' + (i + 1) + '</span><div><div class="row-meta">' + areaTag(p.area) + "</div><strong>" + esc(p.title) + '</strong><p class="why">' + esc(p.why) + "</p></div></li>";
    }).join("") : '<li><p class="empty">Nessuna priorità per questa area.</p></li>';
  }
  function evBtn(e) {
    S.evIndex[e.src + "|" + e.id] = e;
    var when = !e.start ? "Giorno" : esc(e.start) + (e.end ? "–" + esc(e.end) : "");
    return '<button type="button" class="evb" data-area="' + esc(e.area) + '" data-ev="' + esc(e.src + "|" + e.id) + '" aria-label="' + esc(AREAS[e.area] + ": " + e.title) + '"><span class="evt"><i class="da"></i>' + when + (e.src === "user" ? " · tuo" : "") + "</span><strong>" + esc(e.title) + "</strong>" + (e.note ? "<small>" + esc(e.note) + "</small>" : "") + "</button>";
  }
  function renderCal() {
    var days = weekDays(), key = todayKey(), evs = eventsForWeek();
    S.evIndex = {};
    $("cal-range").textContent = dayLabel(days[0], false) + " – " + dayLabel(days[6], false);
    $("c-cal").textContent = evs.length ? evs.length + (evs.length === 1 ? " impegno" : " impegni") : "";
    renderCalStatus();
    $("week-grid").innerHTML = days.map(function (d) {
      var l = evs.filter(function (e) { return e.date === d; });
      return '<div class="col' + (d === key ? " today" : "") + '"><h3>' + esc(cap(dayLabel(d, false))) + "</h3>" + (l.length ? l.map(evBtn).join("") : '<p class="none">Libero</p>') + "</div>";
    }).join("");
  }
  function renderMail() {
    var b = S.brief, rank = { alta: 0, media: 1, bassa: 2 };
    var m = ((b && b.emails) || []).filter(function (x) { return show(x.area); });
    m.sort(function (a, c) { return (rank[a.priority] == null ? 3 : rank[a.priority]) - (rank[c.priority] == null ? 3 : rank[c.priority]); });
    $("c-mail").textContent = m.length ? m.length + " da vedere" : "";
    var html = m.map(function (x) {
      var u = safeUrl(x.url);
      return '<div class="mail"><div class="row-meta"><span class="prio ' + esc(x.priority || "bassa") + '">' + esc(x.priority || "bassa") + "</span>" + areaTag(x.area) + "</div><strong>" + esc(x.subject) + '</strong><span class="from">' + esc(x.from) + "</span>" +
        (x.action ? '<p class="act">' + esc(x.action) + "</p>" : "") + (u ? '<p class="act"><a href="' + esc(u) + '" target="_blank" rel="noopener">Apri in Gmail</a></p>' : "") + "</div>";
    }).join("");
    if (!m.length) html = '<p class="empty">' + (b ? "Nessuna email da gestire per questa vista." : "Le email che richiedono una risposta compaiono dopo il primo aggiornamento.") + "</p>";
    if (b && b.emailStats) html += '<p class="foot">Controllate ' + esc(b.emailStats.scanned) + " conversazioni, " + esc(b.emailStats.flagged) + " richiedono attenzione. Il resto è posta di servizio e promozioni.</p>";
    $("mail").innerHTML = html;
  }
  function taskHtml(t) {
    return '<li class="task' + (t.done ? " done" : "") + '"><input type="checkbox" id="t-' + esc(t.id) + '" data-task="' + esc(t.id) + '"' + (t.done ? " checked" : "") + '><label for="t-' + esc(t.id) + '">' + esc(t.title) +
      '<span class="row-meta" style="margin:4px 0 0">' + areaTag(t.area) + (t.due ? '<span class="sub">entro ' + esc(dayLabel(t.due, false)) + "</span>" : "") + (t.source === "agente" ? '<span class="tag plain">proposto</span>' : "") + "</span></label>" +
      '<button type="button" class="lnk" data-edit="task|' + esc(t.id) + '">Modifica</button></li>';
  }
  function renderTasks() {
    badges();
    var all = S.tasks.filter(function (t) { return show(t.area); });
    var open = all.filter(function (t) { return !t.done; }), done = all.filter(function (t) { return t.done; });
    open.sort(function (a, b) { return String(a.due || "9999").localeCompare(String(b.due || "9999")) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")); });
    $("c-tasks").textContent = open.length ? open.length + " aperti" : "";
    $("tasks").innerHTML = open.length ? open.map(taskHtml).join("") : '<li class="empty">Nessun compito aperto. Aggiungine uno qui sotto, oppure aspetta le proposte dell\'aggiornamento successivo.</li>';
    $("donewrap").hidden = !done.length;
    $("donesum").textContent = "Completati (" + done.length + ")";
    $("done").innerHTML = done.map(taskHtml).join("");
  }
  function renderPosts() {
    var p = S.posts.filter(function (x) { return show(x.area); });
    p.sort(function (a, b) { return ((a.status === "pubblicato") - (b.status === "pubblicato")) || String(a.when || "9999").localeCompare(String(b.when || "9999")); });
    $("c-li").textContent = p.length ? p.filter(function (x) { return x.status !== "pubblicato"; }).length + " in programma" : "";
    if (!p.length) { $("posts").innerHTML = '<p class="empty">Il piano editoriale compare qui. Aggiungi un post con il pulsante in alto, oppure chiedi a Claude di prepararne di nuovi.</p>'; return; }
    $("posts").innerHTML = p.map(function (x) {
      var st = STATUS[x.status] ? x.status : "bozza", pub = st === "pubblicato";
      return '<details class="post' + (pub ? " published" : "") + '" data-post="' + esc(x.id) + '"' + (S.open[x.id] ? " open" : "") + "><summary>" +
        '<span class="row-meta" style="margin:0">' + areaTag(x.area) + '<span class="tag plain">' + esc(x.channel || "Profilo") + '</span><span class="tag plain">' + esc(x.lang || "it") + "</span>" +
        (pub ? '<span class="check">pubblicato</span>' : '<span class="tag plain">' + STATUS[st] + "</span>") + (x.when ? '<span class="sub">' + (pub ? "il " : "per ") + esc(dayLabel(x.when, false)) + "</span>" : "") + "</span><strong>" + esc(x.title) + "</strong></summary>" +
        '<div class="post-body"><div class="post-text">' + esc(x.body) + "</div>" + (x.note ? '<p class="sub" style="margin-top:8px">' + esc(x.note) + "</p>" : "") +
        '<div class="post-actions"><button type="button" class="btn primary" data-copy="' + esc(x.id) + '">Copia testo</button><button type="button" class="btn" data-pub="' + esc(x.id) + '">' + NEXT_LABEL[st] + "</button>" +
        '<a class="btn" href="https://www.linkedin.com/feed/?shareActive=true" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit">Apri LinkedIn</a>' +
        '<button type="button" class="btn" data-edit="post|' + esc(x.id) + '">Modifica</button></div></div></details>';
    }).join("");
  }
  function renderAreas() {
    var a = (S.brief && S.brief.areas) || {};
    var keys = Object.keys(AREAS).filter(function (k) { return a[k] && show(k); });
    $("areas").innerHTML = keys.length ? keys.map(function (k) { return "<li><div>" + areaTag(k) + "</div><p>" + esc(a[k]) + "</p></li>"; }).join("") : '<li><p class="empty">Lo stato di ogni area compare dopo il primo aggiornamento.</p></li>';
  }
  function renderPosta() {
    badges();
    var rank = { alta: 0, media: 1, bassa: 2 };
    var list = S.posta.filter(function (x) { return x.id !== "_stato" && show(x.area); });
    list.sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
    var st = S.postaState, line = "";
    if (st && st.ultimoGiro) line = "Ultimo giro alle " + hhmm(st.ultimoGiro) + (st.esito ? " · " + st.esito : "") + ". ";
    $("posta-state").textContent = line + "Legge le caselle Medoacus alle 12:00 e alle 18:00, senza spam, a Mac acceso.";
    var open = list.filter(function (x) { return x.needsReply === true; }).length;
    $("c-posta").textContent = list.length ? list.length + " messaggi" + (open ? " · " + open + " da rispondere" : "") : "";
    if (!list.length) { $("posta").innerHTML = '<p class="empty">Nessuna email registrata ancora. Compaiono qui dopo il primo giro di lettura.</p>'; return; }
    $("posta").innerHTML = list.slice(0, 40).map(function (x) {
      var d = x.date ? new Date(x.date) : null, when = d && !isNaN(d) ? cap(dayLabel(keyOf(d), false)) + ", " + hhmm(d.toISOString()) : "";
      var pr = rank[x.priority] != null ? x.priority : "bassa";
      return '<div class="pm"><div class="row-meta"><span class="prio ' + esc(pr) + '">' + esc(pr) + "</span>" + areaTag(x.area) + (x.account ? '<span class="tag acct">' + esc(x.account) + "</span>" : "") +
        (x.needsReply === true ? '<span class="tag reply">Da rispondere</span>' : "") + (when ? '<span class="sub">' + esc(when) + "</span>" : "") + "</div><strong>" + esc(x.subject) + '</strong><span class="from">' + esc(x.from) + "</span>" + (x.summary ? "<p>" + esc(x.summary) + "</p>" : "") + "</div>";
    }).join("");
  }

  function renderToday() {
    var key = todayKey(), tom = addDays(key, 1), o = romeParts(), now = o.hour + ":" + o.minute;
    var evs = eventsFor(key, key);
    var next = evs.filter(function (e) { return e.start && (e.end || e.start) >= now; })[0];
    var allday = evs.filter(function (e) { return !e.start; });
    $("c-today").textContent = evs.length ? evs.length + (evs.length === 1 ? " impegno" : " impegni") : "Giornata libera";
    var b = S.brief;
    $("t-summary").textContent = b && b.summary ? b.summary : "";
    $("t-summary").hidden = !(b && b.summary);
    var agenda = allday.concat(evs.filter(function (e) { return e.start; }));
    $("t-agenda").innerHTML = agenda.length ? agenda.map(function (e) {
      var past = e.start && (e.end || e.start) < now, isNext = next && e === next;
      return '<li class="' + (past ? "past " : "") + (isNext ? "next" : "") + '" data-area="' + esc(e.area) + '"><span class="tm">' + (e.start ? esc(e.start) : "Giorno") + "</span><span>" + esc(e.title) + (isNext ? ' <em class="nx">prossimo</em>' : "") + "</span></li>";
    }).join("") : '<li class="empty">Nessun impegno in calendario oggi.</li>';
    var due = S.tasks.filter(function (t) { return !t.done && t.due && t.due <= tom && show(t.area); });
    due.sort(function (a, c) { return String(a.due).localeCompare(String(c.due)); });
    $("t-tasks").innerHTML = due.length ? due.slice(0, 5).map(function (t) {
      var tag = t.due < key ? "in ritardo" : t.due === key ? "oggi" : "domani";
      return '<li><span class="due ' + (t.due < key ? "late" : "") + '">' + tag + "</span><span>" + esc(t.title) + "</span></li>";
    }).join("") + (due.length > 5 ? '<li class="more">e altri ' + (due.length - 5) + "</li>" : "") : '<li class="empty">Nessun compito in scadenza.</li>';
    var rank = { alta: 0, media: 1 };
    var reply = S.posta.filter(function (x) { return x.id !== "_stato" && x.needsReply === true && show(x.area); }).map(function (x) { return { s: x.subject, f: x.from, p: x.priority, k: "posta" }; });
    ((b && b.emails) || []).filter(function (x) { return rank[x.priority] != null && show(x.area); }).forEach(function (x) { reply.push({ s: x.subject, f: x.from, p: x.priority, k: "mail" }); });
    $("t-mail").innerHTML = reply.length ? reply.slice(0, 5).map(function (r) {
      return '<li><a href="#' + (r.k === "posta" ? "posta-card" : "h-mail") + '"><span class="prio ' + esc(r.p || "bassa") + '">' + esc(r.p || "bassa") + "</span> " + esc(r.s) + '<small>' + esc(r.f) + "</small></a></li>";
    }).join("") + (reply.length > 5 ? '<li class="more">e altre ' + (reply.length - 5) + "</li>" : "") : '<li class="empty">Nessuna email da rispondere.</li>';
  }
  function renderBlocks() {
    var key = todayKey();
    var b = S.blocks.filter(function (x) { return x.status === "proposto" && x.date >= key && show(x.area); });
    b.sort(function (a, c) { return (a.date + (a.start || "")).localeCompare(c.date + (c.start || "")); });
    $("c-blocks").textContent = b.length ? b.length + " da confermare" : "";
    if (!b.length) { $("blocks").innerHTML = '<p class="empty">Nessun blocco proposto. Claude cerca i tempi liberi nei tre aggiornamenti del giorno e ne propone fino a due per giorno.</p>'; return; }
    $("blocks").innerHTML = b.map(function (x) {
      return '<div class="block" data-area="' + esc(AREAS[x.area] ? x.area : "") + '"><div class="block-time"><b>' + esc(x.start || "") + "</b><span>" + esc(x.end || "") + "</span></div>" +
        '<div class="block-body"><div class="row-meta">' + areaTag(x.area) + '<span class="sub">' + esc(cap(dayLabel(x.date, false))) + "</span></div><strong>" + esc(x.title) + "</strong>" + (x.why ? '<p class="sub">' + esc(x.why) + "</p>" : "") +
        '</div><div class="block-act"><button type="button" class="btn primary" data-bconf="' + esc(x.id) + '">Conferma</button><button type="button" class="lnk" data-bdrop="' + esc(x.id) + '">Scarta</button></div></div>';
    }).join("");
  }
  var NOTE_ST = { nuovo: "In attesa di Claude", letto: "Letto da Claude" };
  function renderNotes() {
    var n = S.notes.slice().sort(function (a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); }).slice(0, 6);
    $("notes").innerHTML = n.map(function (x) {
      return "<li><div><p>" + esc(x.text) + '</p><span class="sub">' + esc(NOTE_ST[x.status] || x.status || "") + (x.createdAt ? " · " + esc(cap(dayLabel(keyOf(new Date(x.createdAt)), false)) + ", " + hhmm(x.createdAt)) : "") + '</span></div><button type="button" class="lnk" data-ndel="' + esc(x.id) + '">Elimina</button></li>';
    }).join("");
  }
  function renderStats() {
    $("st-ev").textContent = eventsForWeek().length;
    $("st-mail").textContent = ((S.brief && S.brief.emails) || []).filter(function (x) { return show(x.area); }).length;
    $("st-task").textContent = S.tasks.filter(function (t) { return !t.done && show(t.area); }).length;
  }

  /* ---------- schede ---------- */
  var TABS = ["oggi", "agenda", "compiti", "posta", "linkedin", "aree"];
  function setTab(t, scrollTo) {
    if (TABS.indexOf(t) < 0) t = "oggi";
    $("app").setAttribute("data-tab", t);
    var b = document.querySelectorAll("#tabbar button"), i;
    for (i = 0; i < b.length; i++) { if (b[i].getAttribute("data-go") === t) b[i].setAttribute("aria-current", "page"); else b[i].removeAttribute("aria-current"); }
    try { history.replaceState(null, "", "#" + t); } catch (e) {}
    if (scrollTo) { var el = $(scrollTo); if (el) { try { el.scrollIntoView(); } catch (e) {} } } else { window.scrollTo(0, 0); }
  }
  function tabFromHash() {
    var h = (location.hash || "").slice(1);
    if (h === "posta-card" || h === "h-mail") return ["posta", h];
    return [TABS.indexOf(h) >= 0 ? h : "oggi", null];
  }
  function badges() {
    var n = S.tasks.filter(function (t) { return !t.done && t.due && t.due <= addDays(todayKey(), 1); }).length;
    var m = S.posta.filter(function (x) { return x.id !== "_stato" && x.needsReply === true; }).length;
    $("bd-task").textContent = n; $("bd-task").hidden = !n;
    $("bd-mail").textContent = m; $("bd-mail").hidden = !m;
  }
  document.addEventListener("click", function (e) {
    var g = e.target.closest && e.target.closest("[data-go]");
    if (g) { setTab(g.getAttribute("data-go")); return; }
    var a = e.target.closest && e.target.closest('#t-mail a[href^="#"]');
    if (a) { e.preventDefault(); setTab("posta", a.getAttribute("href").slice(1)); }
  });
  window.addEventListener("hashchange", function () { var t = tabFromHash(); setTab(t[0], t[1]); });

  /* ---------- spese e allenamenti ---------- */
  var CATC = { Spesa: "#3F8A4E", Casa: "#2F6FB5", Trasporti: "#7B5EA7", Lavoro: "#D9822B", Svago: "#0E8C8C", Salute: "#B8344A", Altro: "#8A8F98" };
  function eur(n) { return n.toLocaleString("it-IT", { style: "currency", currency: "EUR" }); }
  function renderMoney() {
    var key = todayKey(), ym = key.slice(0, 7), prev = (function () { var p = key.split("-").map(Number), d = new Date(Date.UTC(p[0], p[1] - 2, 1)); return d.toISOString().slice(0, 7); })();
    var all = S.spese.slice().sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
    var cur = all.filter(function (x) { return String(x.date || "").slice(0, 7) === ym; }), pv = all.filter(function (x) { return String(x.date || "").slice(0, 7) === prev; });
    var tot = cur.reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0), ptot = pv.reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
    $("c-money").textContent = "Questo mese " + eur(tot);
    var by = {}; cur.forEach(function (x) { by[x.category || "Altro"] = (by[x.category || "Altro"] || 0) + (Number(x.amount) || 0); });
    var cats = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; });
    $("m-bars").innerHTML = (cats.length ? cats.map(function (c) { return '<div class="bar"><span>' + esc(c) + '</span><i style="--w:' + Math.max(4, Math.round(by[c] / (by[cats[0]] || 1) * 100)) + "%;--c:" + (CATC[c] || "#8A8F98") + '"></i><b>' + eur(by[c]) + "</b></div>"; }).join("") : '<p class="empty">Nessuna spesa questo mese.</p>') +
      (ptot ? '<p class="sub">Mese scorso: ' + eur(ptot) + ".</p>" : "");
    $("m-list").innerHTML = all.slice(0, 8).map(function (x) {
      return "<li><span>" + esc(dayLabel(x.date || key, false)) + "</span><span>" + esc(x.category || "") + (x.note ? " · " + esc(x.note) : "") + "</span><b>" + eur(Number(x.amount) || 0) + '</b><button type="button" class="lnk" data-delrow="spese|' + esc(x.id) + '" aria-label="Elimina">Elimina</button></li>';
    }).join("");
  }
  function renderFit() {
    var key = todayKey(), wk = weekMonday(key);
    var all = S.fit.slice().sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
    var w = all.filter(function (x) { return x.date >= wk; });
    var min = w.reduce(function (s, x) { return s + (Number(x.minutes) || 0); }, 0), km = w.reduce(function (s, x) { return s + (Number(x.km) || 0); }, 0);
    $("c-fit").textContent = w.length ? w.length + (w.length === 1 ? " allenamento" : " allenamenti") + " in settimana" : "";
    $("f-stats").innerHTML = '<div class="stat2"><b>' + w.length + "</b><span>sessioni</span></div><div class=\"stat2\"><b>" + min + '</b><span>minuti</span></div><div class="stat2"><b>' + (Math.round(km * 10) / 10).toLocaleString("it-IT") + "</b><span>km</span></div>";
    $("f-list").innerHTML = all.slice(0, 8).map(function (x) {
      return "<li><span>" + esc(dayLabel(x.date || key, false)) + "</span><span>" + esc(x.sport || "") + (x.note ? " · " + esc(x.note) : "") + "</span><b>" + esc(x.minutes) + " min" + (x.km ? " · " + esc(x.km) + " km" : "") + '</b><button type="button" class="lnk" data-delrow="allenamenti|' + esc(x.id) + '" aria-label="Elimina">Elimina</button></li>';
    }).join("");
  }
  $("money-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = Number($("m-amount").value.replace(",", "."));
    if (!(v > 0)) return;
    DB.add("spese", { date: todayKey(), amount: Math.round(v * 100) / 100, category: $("m-cat").value, note: $("m-note").value.trim(), createdAt: new Date().toISOString() }).then(function () { toast("Spesa salvata."); }).catch(fail);
    $("m-amount").value = ""; $("m-note").value = "";
  });
  $("fit-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var m = Number($("f-min").value);
    if (!(m > 0)) return;
    var k = Number($("f-km").value.replace(",", "."));
    DB.add("allenamenti", { date: todayKey(), sport: $("f-sport").value, minutes: m, km: k > 0 ? k : null, note: $("f-note").value.trim(), createdAt: new Date().toISOString() }).then(function () { toast("Allenamento salvato."); }).catch(fail);
    $("f-min").value = ""; $("f-km").value = ""; $("f-note").value = "";
  });
  document.addEventListener("click", function (e) {
    var d = e.target.closest && e.target.closest("[data-delrow]");
    if (!d) return;
    var p = d.getAttribute("data-delrow").split("|");
    if (d.getAttribute("data-armed") !== "1") { d.setAttribute("data-armed", "1"); d.textContent = "Conferma"; setTimeout(function () { d.setAttribute("data-armed", "0"); d.textContent = "Elimina"; }, 3000); return; }
    DB.del(p[0], p[1]).catch(fail);
  });
  function renderAll() { renderMoney(); renderFit(); badges(); renderToday(); renderStats(); renderHead(); renderBrief(); renderCal(); renderMail(); renderPosta(); renderBlocks(); renderTasks(); renderPosts(); renderAreas(); renderNotes(); }

  /* ---------- colori ---------- */
  function buildColors() {
    $("colorrows").innerHTML = Object.keys(AREAS).map(function (k) {
      return '<div class="crow" data-area="' + k + '"><i class="da"></i><label for="col-' + k + '">' + AREAS[k] + '</label><input type="color" id="col-' + k + '" data-col="' + k + '" value="' + DEFAULTS[k] + '"></div>';
    }).join("");
  }
  function applyColors() {
    var r = document.documentElement.style;
    Object.keys(AREAS).forEach(function (k) {
      var c = S.colors[k], el = $("col-" + k);
      if (validHex(c)) r.setProperty("--b-" + k, c); else r.removeProperty("--b-" + k);
      if (el) el.value = validHex(c) ? c : DEFAULTS[k];
    });
  }

  /* ---------- avvisi ---------- */
  var toastT = null;
  function toast(msg) { var t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2800); }
  function fail() { toast("Non sono riuscito a salvare. Controlla la connessione."); }
  function copyText(text) {
    var fb = function () {
      var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta); toast(ok ? "Testo copiato" : "Copia non riuscita: selezionalo a mano");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast("Testo copiato"); }, fb); else fb();
  }

  /* ---------- editor ---------- */
  function areaOpts() { return Object.keys(AREAS).map(function (k) { return [k, AREAS[k]]; }); }
  function selHtml(id, opts, val) { return '<select id="' + id + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === val ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + "</select>"; }
  function fieldHtml(f, cur, defs) {
    var k = f[0], type = f[2], req = f[3], v = cur && cur[k] != null ? cur[k] : (defs[k] != null ? defs[k] : ""), id = "f-" + k, wide = type === "text" || type === "ta" || type === "tas", inner;
    if (type === "area") inner = selHtml(id, areaOpts(), AREAS[v] ? v : defs.area);
    else if (type === "lang") inner = selHtml(id, [["it", "Italiano"], ["en", "Inglese"]], v || "it");
    else if (type === "status") inner = selHtml(id, [["idea", "Idea"], ["bozza", "Bozza"], ["pubblicato", "Pubblicato"]], STATUS[v] ? v : "bozza");
    else if (type === "ta") inner = '<textarea id="' + id + '" rows="12">' + esc(v) + "</textarea>";
    else if (type === "tas") inner = '<textarea id="' + id + '" rows="3">' + esc(v) + "</textarea>";
    else inner = '<input id="' + id + '" type="' + type + '" value="' + esc(v) + '" autocomplete="off"' + (req ? " required" : "") + ">";
    return '<div class="fld' + (wide ? " wide" : "") + '"><label for="' + id + '">' + esc(f[1]) + (req ? " *" : "") + "</label>" + inner + "</div>";
  }
  function showDlg() { var d = $("dlg"); if (d.open) return; try { d.showModal(); } catch (e) { d.setAttribute("open", ""); } }
  function closeDlg() { var d = $("dlg"); try { d.close(); } catch (e) { d.removeAttribute("open"); } S.edit = null; }
  function openEditor(kind, id) {
    var F = FORMS[kind], cur = null;
    if (id) {
      cur = (kind === "task" ? S.tasks : kind === "event" ? S.events : S.posts).filter(function (x) { return x.id === id; })[0];
      if (!cur) return;
    }
    var defs = { area: S.filter !== "tutto" ? S.filter : (kind === "post" ? "medoacus" : "vita"), status: "bozza", lang: "it", channel: kind === "post" ? "Pagina Medoacus" : "" };
    if (kind === "event" && !id) defs.date = todayKey();
    S.edit = { mode: "form", kind: kind, id: id || null };
    $("dlg-title").textContent = (id ? "Modifica " : "Nuovo ") + F.label;
    $("dfields").innerHTML = F.fields.map(function (f) { return fieldHtml(f, cur, defs); }).join("");
    $("ddel").hidden = !id; $("dsave").hidden = false; S.delArmed = false; $("ddel").textContent = "Elimina";
    showDlg();
  }
  function openInfo(e) {
    S.edit = { mode: "info" };
    $("dlg-title").textContent = e.title;
    var when = dayLabel(e.date, true) + (e.start ? " · " + e.start + (e.end ? "–" + e.end : "") : "");
    $("dfields").innerHTML = '<div class="fld wide"><p class="sub">' + esc(cap(when)) + (e.note ? " · " + esc(e.note) : "") + "</p></div>" +
      '<p class="sub fld wide">' + (e.src === "block" ? "Blocco confermato: Claude lo mette in Google Calendar al prossimo aggiornamento." : "Questo impegno arriva da Google Calendar. Per cambiarlo, modificalo in Google Calendar.") + "</p>";
    $("ddel").hidden = true; $("dsave").hidden = true;
    showDlg();
  }
  function saveEdit() {
    var ed = S.edit;
    if (!ed || ed.mode !== "form") return;
    var F = FORMS[ed.kind], data = {}, bad = null;
    F.fields.forEach(function (f) {
      var el = $("f-" + f[0]), val = el ? el.value : "";
      if (f[2] === "date") val = val || null; else val = val.replace(/^\s+|\s+$/g, "");
      if (f[3] && !val && !bad) bad = el;
      data[f[0]] = val;
    });
    if (bad) { toast("Compila i campi obbligatori"); try { bad.focus(); } catch (e) {} return; }
    var p;
    if (ed.id) p = DB.update(F.coll, ed.id, data);
    else {
      if (ed.kind === "task") { data.done = false; data.source = "tu"; }
      if (ed.kind === "event") data.source = "tu";
      data.createdAt = new Date().toISOString();
      p = DB.add(F.coll, data);
    }
    p.then(closeDlg, fail);
  }
  function deleteEdit() {
    var ed = S.edit;
    if (!ed || ed.mode !== "form" || !ed.id) return;
    if (!S.delArmed) { S.delArmed = true; $("ddel").textContent = "Conferma eliminazione"; return; }
    DB.del(FORMS[ed.kind].coll, ed.id).then(closeDlg, fail);
  }

  /* ---------- eventi della pagina ---------- */
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-filter],[data-copy],[data-pub],[data-edit],[data-ev],[data-new],[data-wk],[data-bconf],[data-bdrop],[data-ndel]");
    if (!el) return;
    if (el.hasAttribute("data-filter")) {
      S.filter = el.getAttribute("data-filter");
      try { localStorage.setItem("cf-filter", S.filter); } catch (x) {}
      markChips(); renderAll();
    } else if (el.hasAttribute("data-copy")) {
      var p = S.posts.filter(function (x) { return x.id === el.getAttribute("data-copy"); })[0];
      if (p) copyText(p.body || "");
    } else if (el.hasAttribute("data-pub")) {
      var id = el.getAttribute("data-pub"), q = S.posts.filter(function (x) { return x.id === id; })[0];
      if (q) DB.update("posts", id, { status: NEXT_STATUS[STATUS[q.status] ? q.status : "bozza"] }).catch(fail);
    } else if (el.hasAttribute("data-edit")) {
      var parts = el.getAttribute("data-edit").split("|"); openEditor(parts[0], parts[1]);
    } else if (el.hasAttribute("data-new")) {
      openEditor(el.getAttribute("data-new"), null);
    } else if (el.hasAttribute("data-ev")) {
      var ev = S.evIndex[el.getAttribute("data-ev")];
      if (ev) { if (ev.src === "user") openEditor("event", ev.id); else openInfo(ev); }
    } else if (el.hasAttribute("data-wk")) {
      var n = Number(el.getAttribute("data-wk"));
      S.weekStart = n === 0 ? weekMonday(todayKey()) : addDays(S.weekStart, n * 7);
      renderCal(); renderStats();
    } else if (el.hasAttribute("data-bconf")) {
      DB.update("blocks", el.getAttribute("data-bconf"), { status: "confermato" }).then(function () { toast("Confermato. Claude lo mette in calendario al prossimo aggiornamento."); }, fail);
    } else if (el.hasAttribute("data-bdrop")) {
      DB.update("blocks", el.getAttribute("data-bdrop"), { status: "scartato" }).catch(fail);
    } else if (el.hasAttribute("data-ndel")) {
      DB.del("notes", el.getAttribute("data-ndel")).catch(fail);
    }
  });
  document.addEventListener("toggle", function (e) { var d = e.target; if (d && d.getAttribute && d.getAttribute("data-post")) S.open[d.getAttribute("data-post")] = d.open; }, true);
  document.addEventListener("change", function (e) {
    var t = e.target, id = t && t.getAttribute && t.getAttribute("data-task");
    if (id) { DB.update("tasks", id, { done: t.checked }).catch(function () { renderTasks(); fail(); }); return; }
    var k = t && t.getAttribute && t.getAttribute("data-col");
    if (k) { var c = Object.assign({}, S.colors); c[k] = t.value; S.colors = c; DB.set("settings", "colors", c).catch(fail); }
  });
  document.addEventListener("input", function (e) { var k = e.target && e.target.getAttribute && e.target.getAttribute("data-col"); if (k && validHex(e.target.value)) document.documentElement.style.setProperty("--b-" + k, e.target.value); });
  $("colreset").addEventListener("click", function () { S.colors = {}; applyColors(); DB.set("settings", "colors", {}).catch(fail); });
  $("addform").addEventListener("submit", function (e) {
    e.preventDefault();
    var title = $("newtask").value.trim();
    if (!title) return;
    DB.add("tasks", { title: title, area: $("newarea").value, done: false, source: "tu", due: null, createdAt: new Date().toISOString() }).then(function () { $("newtask").value = ""; }, fail);
  });
  $("dform").addEventListener("submit", function (e) { e.preventDefault(); saveEdit(); });
  $("dcancel").addEventListener("click", closeDlg);
  $("ddel").addEventListener("click", deleteEdit);
  $("dlg").addEventListener("close", function () { S.edit = null; });

  /* ---------- Google Calendar tramite indirizzo iCal (letto dal server) ---------- */
  function renderCalStatus() {
    var g = S.gcal, st = S.gsync, t;
    if (st.busy) t = "Aggiorno Google Calendar…";
    else if (st.err) t = st.err;
    else if (g && g.syncedAt) {
      t = "Google Calendar · aggiornato alle " + hhmm(g.syncedAt) + " · " + g.calendars + (g.calendars === 1 ? " calendario" : " calendari");
      if (g.errors && g.errors.length) t += ". " + g.errors.join("; ");
    } else t = "Gli impegni arrivano dal riepilogo di Claude. Per vederli in diretta, collega Google Calendar qui sotto.";
    $("cal-status").textContent = t;
    $("ical-clear").hidden = !(g && g.syncedAt) && !st.calendars;
  }
  async function callSync(action, extra) {
    var sess = await sb.auth.getSession();
    var token = sess.data && sess.data.session && sess.data.session.access_token;
    if (!token) throw new Error("Accedi di nuovo.");
    var res = await fetch(CFG.url + "/functions/v1/sync-calendar", {
      method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.anon, Authorization: "Bearer " + token },
      body: JSON.stringify(Object.assign({ action: action }, extra || {}))
    });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(j.error || "Errore " + res.status);
    return j;
  }
  var lastSync = 0;
  async function syncCalendar(force) {
    if (S.gsync.busy || !S.ready) return;
    if (!force && Date.now() - lastSync < 240000) return;
    if (!force && S.gsync.calendars === 0) return;
    S.gsync.busy = true; S.gsync.err = ""; renderCalStatus();
    try {
      var j = await callSync("sync");
      S.gsync.calendars = j.calendars; lastSync = Date.now();
      if (j.calendars && j.ok === 0 && j.errors && j.errors.length) S.gsync.err = "Google Calendar non risponde: " + j.errors.join("; ");
    } catch (e) { S.gsync.err = "Non riesco ad aggiornare Google Calendar: " + e.message; }
    S.gsync.busy = false; renderCalStatus(); renderCal(); renderStats();
  }
  $("ical-save").addEventListener("click", async function () {
    var urls = $("ical-urls").value.split(/\s+/).filter(Boolean);
    $("ical-err").textContent = "";
    if (!urls.length) { $("ical-err").textContent = "Incolla almeno un indirizzo."; return; }
    $("ical-save").disabled = true;
    S.gsync.busy = true; renderCalStatus();
    try {
      var j = await callSync("save", { urls: urls });
      S.gsync.calendars = j.calendars; lastSync = Date.now();
      $("ical-urls").value = ""; $("cal-setup").open = false;
      toast(j.events + " impegni letti da Google Calendar");
      if (j.errors && j.errors.length) $("ical-err").textContent = j.errors.join("; ");
    } catch (e) { $("ical-err").textContent = e.message; }
    S.gsync.busy = false; $("ical-save").disabled = false; renderCalStatus(); renderCal(); renderStats();
  });
  $("ical-sync").addEventListener("click", function () { syncCalendar(true); });
  $("ical-clear").addEventListener("click", async function () {
    if (!window.confirm("Scollegare Google Calendar? Tornano gli impegni del riepilogo di Claude.")) return;
    try { await callSync("clear"); S.gsync.calendars = 0; S.gcal = null; toast("Google Calendar scollegato"); } catch (e) { $("ical-err").textContent = e.message; }
    renderCalStatus(); renderCal(); renderStats();
  });
  setInterval(function () { if (!document.hidden) syncCalendar(false); }, 300000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) syncCalendar(false); });

  /* ---------- appunti per Claude (con dettatura se il browser la offre) ---------- */
  $("voice-go").addEventListener("click", function () {
    var text = $("voice-text").value.replace(/^\s+|\s+$/g, "");
    if (!text) { toast("Scrivi o detta qualcosa prima"); return; }
    DB.add("notes", { text: text, status: "nuovo", createdAt: new Date().toISOString() }).then(function () { $("voice-text").value = ""; toast("Inviato. Claude lo legge al prossimo aggiornamento."); }, fail);
  });
  $("voice-clear").addEventListener("click", function () { $("voice-text").value = ""; $("voice-text").focus(); });
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition, rec = null;
  var mic = $("voice-mic"); mic.hidden = false;
  {
    mic.addEventListener("click", function () {
      if (!SR) { $("voice-text").focus(); toast("Tocca il microfono sulla tastiera del telefono per dettare."); return; }
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = "it-IT"; rec.interimResults = false; rec.continuous = true;
      rec.onresult = function (ev) {
        var t = "", i; for (i = ev.resultIndex; i < ev.results.length; i++) t += ev.results[i][0].transcript;
        var ta = $("voice-text"); ta.value = ta.value ? ta.value + " " + t.trim() : t.trim();
      };
      rec.onerror = function (ev) { if (ev.error === "not-allowed") toast("Microfono non consentito"); };
      rec.onend = function () { rec = null; mic.textContent = "Parla"; mic.setAttribute("aria-pressed", "false"); $("voice-state").textContent = ""; };
      try { rec.start(); mic.textContent = "Ferma"; mic.setAttribute("aria-pressed", "true"); $("voice-state").textContent = "Ti ascolto"; } catch (x) { rec = null; }
    });
  }

  /* ---------- notifiche push ---------- */
  function b64ToU8(s) { var p = "=".repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")), a = new Uint8Array(b.length), i; for (i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function pushSupported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
  async function refreshPushBtn() {
    var b = $("push-btn");
    if (!pushSupported()) { b.hidden = true; return; }
    var reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    b.hidden = !!sub && Notification.permission === "granted";
  }
  $("push-btn").addEventListener("click", async function () {
    try {
      var perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Notifiche non consentite"); return; }
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(CFG.vapid) });
      var r = await sb.from("push_subscriptions").upsert({ endpoint: sub.endpoint, subscription: sub.toJSON() });
      if (r.error) throw r.error;
      toast("Notifiche attive su questo dispositivo"); refreshPushBtn();
    } catch (e) { toast("Non riesco ad attivare le notifiche. Su iPhone installa prima l'app dalla schermata Home."); }
  });

  /* ---------- accesso ---------- */
  function setErr(m) { $("auth-err").textContent = m || ""; }
  function showAuth() { $("tabbar").hidden = true; $("app").hidden = true; $("auth").hidden = false; $("login-email").value = CFG.owner; }
  $("loginform").addEventListener("submit", async function (e) {
    e.preventDefault(); setErr("");
    var r = await sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-pass").value });
    if (r.error) { setErr("Email o password non corrette."); return; }
    $("login-pass").value = ""; start();
  });
  $("setupform").addEventListener("submit", async function (e) {
    e.preventDefault(); setErr("");
    try {
      var res = await fetch(CFG.url + "/functions/v1/setup-owner", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.anon, Authorization: "Bearer " + CFG.anon }, body: JSON.stringify({ code: $("setup-code").value, password: $("setup-pass").value }) });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok) { setErr(j.error || "Configurazione non riuscita."); return; }
      var r = await sb.auth.signInWithPassword({ email: CFG.owner, password: $("setup-pass").value });
      if (r.error) { setErr("Accesso creato, ma l'ingresso non è riuscito. Riprova dal modulo sopra."); return; }
      $("setup-pass").value = ""; $("setup-code").value = ""; start();
    } catch (x) { setErr("Non riesco a raggiungere il server."); }
  });
  $("logout").addEventListener("click", async function () {
    await sb.auth.signOut();
    Object.keys(channels).forEach(function (c) { try { sb.removeChannel(channels[c]); } catch (x) {} });
    channels = {}; listeners = {}; store = {}; S.ready = false; showAuth();
  });

  /* ---------- avvio ---------- */
  var timer = null;
  function arrived() { clearTimeout(timer); $("note").hidden = true; }
  function dbError() { clearTimeout(timer); $("note").textContent = "I dati non sono raggiungibili in questo momento. Controlla la connessione."; $("note").hidden = false; }
  function start() {
    $("auth").hidden = true; $("app").hidden = false; $("tabbar").hidden = false; setErr("");
    if (S.ready) return;
    S.ready = true;
    timer = setTimeout(function () { $("note").textContent = "I dati non sono ancora arrivati. Se compaiono, potrebbero non essere aggiornati."; $("note").hidden = false; }, 10000);
    DB.watch("brief", function () { var b = coll("brief").get("latest"); S.brief = b || null; renderAll(); });
    DB.watch("tasks", function () { S.tasks = snapList("tasks"); renderTasks(); renderStats(); });
    DB.watch("posts", function () { S.posts = snapList("posts"); renderPosts(); });
    DB.watch("events", function () { S.events = snapList("events"); renderCal(); renderStats(); });
    DB.watch("blocks", function () { S.blocks = snapList("blocks"); renderBlocks(); renderCal(); renderStats(); });
    DB.watch("spese", function () { S.spese = snapList("spese"); renderMoney(); });
    DB.watch("allenamenti", function () { S.fit = snapList("allenamenti"); renderFit(); });
    DB.watch("notes", function () { S.notes = snapList("notes"); renderNotes(); });
    DB.watch("posta", function () { S.postaState = coll("posta").has("_stato") ? coll("posta").get("_stato") : null; S.posta = snapList("posta"); renderPosta(); });
    DB.watch("gcal", function () { S.gcal = coll("gcal").get("feed") || null; renderCal(); renderStats(); });
    callSync("status").then(function (j) { S.gsync.calendars = j.calendars; renderCalStatus(); if (j.calendars) syncCalendar(true); }).catch(function () {});
    DB.watch("settings", function () { S.colors = Object.assign({}, coll("settings").get("colors") || {}); applyColors(); });
    if (pushSupported()) refreshPushBtn();
  }
  S.weekStart = weekMonday(todayKey());
  buildChips(); buildColors(); renderAll();
  setInterval(renderHead, 60000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
  document.body.classList.add("has-tabs"); (function () { var t = tabFromHash(); setTab(t[0], t[1]); })();
  sb.auth.getSession().then(function (r) { if (r.data && r.data.session) start(); else showAuth(); });
})();
