// ============================================================
//  主催者ダッシュボード ロジック
// ============================================================
(function () {
  let cfg = null;          // ゲーム設定
  let net = null;          // {ip, port}
  let eventId = localStorage.getItem("currentEventId") || null;
  let ev = null;           // 現在のイベント
  let pollTimer = null;
  let selectedGame = "lol";
  let lastEntryHash = "";
  let qrMode = "lan";        // "public" | "lan"
  let qrModeUserSet = false; // ユーザーが手動で選んだか
  let netPollTimer = null;

  // ---- 起動 ----
  init();
  async function init() {
    cfg = await getConfig();
    net = await api("GET", "/api/netinfo");
    // 既定: オンライン公開が使えるなら優先、無ければLAN
    qrMode = net.publicUrl ? "public" : "lan";
    bindSetup();
    bindDash();
    startNetPoll();
    // 進行中のイベントがあれば再開（PC再起動などで中断しても継続できる）
    if (eventId) {
      try { await loadEvent(); return; }
      catch (e) { eventId = null; localStorage.removeItem("currentEventId"); }
    }
    // それ以外は「QR生成してスタート」画面を表示（既存イベントは一覧から再開可能）
    showSetup();
  }

  // ============================================================
  //  セットアップ画面
  // ============================================================
  function defaultTitle() {
    const d = new Date();
    return "即興カスタム " + (d.getMonth() + 1) + "/" + d.getDate();
  }

  function selectGame(g) {
    selectedGame = g;
    $$("#gameSeg .opt").forEach(o => o.classList.toggle("active", o.dataset.g === g));
  }

  function bindSetup() {
    $$("#gameSeg .opt").forEach(opt => {
      opt.addEventListener("click", () => selectGame(opt.dataset.g));
    });
    // 前回選んだゲームを記憶して既定選択（毎回選ぶ手間を削減）
    selectGame(localStorage.getItem("lastGame") || "lol");

    $("#createBtn").addEventListener("click", async () => {
      const btn = $("#createBtn");
      btn.disabled = true;
      const body = {
        game: selectedGame,
        title: ($("#evTitle").value || "").trim() || defaultTitle(),
        teamSize: parseInt($("#evTeamSize").value) || 5,
      };
      try {
        localStorage.setItem("lastGame", selectedGame);
        const res = await api("POST", "/api/event", body);
        eventId = res.event.id;
        localStorage.setItem("currentEventId", eventId);
        await loadEvent();
        toast("QRを生成しました！参加者に読み取ってもらいましょう", "ok");
      } catch (e) { toast(e.message, "err"); }
      finally { btn.disabled = false; }
    });

    $("#newEventBtn").addEventListener("click", () => {
      stopPoll();
      $("#evTitle").value = "";
      showSetup();
    });
  }

  async function showSetup() {
    stopPoll();
    $("#dash").classList.add("hidden");
    $("#setup").classList.remove("hidden");
    $("#eventBadge").classList.add("hidden");
    $("#newEventBtn").classList.add("hidden");
    await renderEventList();
  }

  async function renderEventList() {
    const box = $("#eventList");
    box.innerHTML = "";
    let list = [];
    try { list = (await api("GET", "/api/events")).events; } catch (e) {}
    if (!list.length) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    box.append(el("div", { class: "sub", style: "margin:6px 4px 10px" }, "既存のイベントを開く"));
    list.reverse().forEach(ev => {
      const gColor = ev.game === "lol" ? "var(--lol)" : "var(--valo)";
      const tags = [];
      tags.push(ev.count + "人");
      if (ev.hasTeams) tags.push("チーム分け済");
      if (ev.hasBracket) tags.push("トーナメント有");
      const item = el("div", { class: "ev-item" },
        el("span", { class: "g", style: "color:" + gColor + ";background:" + (ev.game === "lol" ? "rgba(200,155,60,.15)" : "rgba(255,70,85,.15)") },
          cfg[ev.game].label),
        el("div", {},
          el("div", { style: "font-weight:700" }, ev.title),
          el("div", { class: "meta" }, tags.join(" ・ ")),
        ),
        el("div", { class: "spacer", style: "flex:1" }),
        el("button", { class: "btn sm danger", onclick: (e) => { e.stopPropagation(); deleteEvent(ev.id); } }, "削除"),
        el("span", { class: "muted", style: "margin-left:4px" }, "開く →"),
      );
      item.addEventListener("click", async () => {
        eventId = ev.id;
        localStorage.setItem("currentEventId", eventId);
        await loadEvent();
      });
      box.append(item);
    });
  }

  async function deleteEvent(id) {
    if (!confirm("このイベントを削除しますか？（元に戻せません）")) return;
    try {
      await api("DELETE", "/api/event/" + id);
      if (eventId === id) { eventId = null; localStorage.removeItem("currentEventId"); }
      toast("削除しました", "ok");
      renderEventList();
    } catch (e) { toast(e.message, "err"); }
  }

  // ============================================================
  //  イベント読み込み & ポーリング
  // ============================================================
  async function loadEvent() {
    const res = await api("GET", "/api/event/" + eventId);
    ev = res.event;
    $("#setup").classList.add("hidden");
    $("#eventList").classList.add("hidden");
    $("#dash").classList.remove("hidden");
    const badge = $("#eventBadge");
    badge.className = "badge-game " + ev.game;
    badge.textContent = cfg[ev.game].label;
    badge.classList.remove("hidden");
    $("#newEventBtn").classList.remove("hidden");

    renderQR();
    renderGameBanner();
    renderAll();
    startPoll();
  }

  function renderGameBanner() {
    const b = $("#gameBanner");
    b.className = "game-banner " + ev.game;
    if (ev.game === "lol") {
      b.innerHTML = "<div class='big'>LoL</div><div class='sub'>League of Legends</div>";
    } else {
      b.innerHTML = "<div class='big'>VALORANT</div>";
    }
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(async () => {
      try {
        const res = await api("GET", "/api/event/" + eventId);
        const newEv = res.event;
        const hash = JSON.stringify(newEv.entries.map(e => [e.id, e.tier, e.division, e.primaryPos, e.secondaryPos, e.nickname]));
        // 受付タブだけ自動反映 (チーム/表は手動操作を壊さない)
        if (hash !== lastEntryHash) {
          ev.entries = newEv.entries;
          lastEntryHash = hash;
          renderEntries();
        }
        ev.open = newEv.open;
      } catch (e) {}
    }, 2500);
  }
  function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  // ============================================================
  //  ダッシュボード操作バインド
  // ============================================================
  function bindDash() {
    $$(".stepnav .step").forEach(s => {
      s.addEventListener("click", () => switchStep(s.dataset.step));
    });

    $("#openToggle").addEventListener("change", async (e) => {
      try {
        await api("POST", "/api/event/" + eventId + "/settings", { open: e.target.checked });
        ev.open = e.target.checked;
        $("#openLabel").textContent = e.target.checked ? "受付中" : "受付終了";
      } catch (err) { toast(err.message, "err"); }
    });

    $("#copyUrl").addEventListener("click", () => {
      navigator.clipboard.writeText(joinUrl()).then(() => toast("URLをコピーしました", "ok"));
    });
    $("#openQrFull").addEventListener("click", openQrModal);

    $$("#qrModeBar .qm-opt").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        qrMode = btn.dataset.mode;
        qrModeUserSet = true;
        renderQR();
      });
    });

    $("#genAll").addEventListener("click", () => generateAll());
    $("#genTeams").addEventListener("click", () => generateTeams());
    $("#rerollTeams").addEventListener("click", () => generateTeams());
    $("#genBracket").addEventListener("click", () => generateBracket());
  }

  function switchStep(step) {
    $$(".stepnav .step").forEach(s => s.classList.toggle("active", s.dataset.step === step));
    $$(".step-pane").forEach(p => p.classList.add("hidden"));
    $("#step-" + step).classList.remove("hidden");
  }

  // ============================================================
  //  描画
  // ============================================================
  function renderAll() {
    $("#openToggle").checked = ev.open !== false;
    $("#openLabel").textContent = ev.open !== false ? "受付中" : "受付終了";
    lastEntryHash = JSON.stringify(ev.entries.map(e => [e.id, e.tier, e.division, e.primaryPos, e.secondaryPos, e.nickname]));
    renderEntries();
    renderTeams();
    renderBracket();
  }

  // ---- QR ----
  // クラウド/独自ドメインで公開されている場合は、そのままアクセス中のURLを使う
  function isHosted() {
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return false;
    if (/^192\.168\./.test(h) || /^10\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  }
  function baseUrl() {
    if (isHosted()) return location.origin;
    if (qrMode === "public" && net.publicUrl) return net.publicUrl;
    return net.lanUrl || ("http://" + net.ip + ":" + net.port);
  }
  function joinUrl() {
    return baseUrl() + "/join?ev=" + eventId;
  }
  function renderQR() {
    if (!eventId) return;
    const url = joinUrl();
    $("#joinUrl").textContent = url;
    $("#joinUrl").href = url;
    const box = $("#qrcode");
    box.innerHTML = "";
    new QRCode(box, { text: url, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M });
    renderQrModeUI();
  }

  function renderQrModeUI() {
    // クラウド公開時はモード切替不要（常に公開URL）
    if (isHosted()) {
      $("#qrModeBar").classList.add("hidden");
      $("#tunnelStatus").innerHTML =
        "<span class='dot ready'></span>公開URL — このQR/URLをそのまま参加者に共有できます";
      return;
    }
    const hasPublic = !!net.publicUrl;
    $("#qmPublic").classList.toggle("active", qrMode === "public");
    $("#qmLan").classList.toggle("active", qrMode === "lan");
    $("#qmPublic").disabled = !hasPublic;

    const st = $("#tunnelStatus");
    if (qrMode === "public" && hasPublic) {
      const fixed = net.tunnelFixed;
      st.innerHTML = "<span class='dot ready'></span>" +
        (fixed ? "固定URLで公開中 — 毎回この同じURLでアクセスできます"
               : "オンライン公開中 — 4G/5G・別Wi-Fiからでもエントリーできます");
    } else if (!hasPublic && net.tunnelStatus === "starting") {
      st.innerHTML = "<span class='dot starting'></span>オンライン公開URLを準備中... (数秒〜十数秒)";
    } else if (!hasPublic && (net.tunnelStatus === "disabled" || net.tunnelStatus === "off")) {
      st.innerHTML = "<span class='dot off'></span>オンライン公開はオフ。同じWi-Fi内のみ有効です";
    } else if (!hasPublic && net.tunnelStatus === "error") {
      st.innerHTML = "<span class='dot off'></span>オンライン公開に失敗（ネット未接続など）。LANで利用できます";
    } else if (qrMode === "lan") {
      st.innerHTML = "<span class='dot off'></span>同じWi-Fiに接続した端末のみエントリーできます";
    } else {
      st.innerHTML = "";
    }
  }

  function startNetPoll() {
    if (isHosted()) return; // クラウド公開時はトンネル不要
    if (netPollTimer) clearInterval(netPollTimer);
    netPollTimer = setInterval(async () => {
      // 公開URLがまだ無いときだけ取得を続ける
      if (net.publicUrl) { clearInterval(netPollTimer); netPollTimer = null; return; }
      try {
        const n = await api("GET", "/api/netinfo");
        const becameReady = !net.publicUrl && n.publicUrl;
        net = n;
        if (becameReady && !qrModeUserSet) qrMode = "public"; // 準備でき次第 自動でオンラインに
        if (!$("#dash").classList.contains("hidden")) renderQR();
      } catch (e) {}
    }, 2000);
  }
  function openQrModal() {
    const url = joinUrl();
    $("#qrModalTitle").textContent = ev.title;
    $("#qrModalUrl").textContent = url;
    const box = $("#qrBig");
    box.innerHTML = "";
    new QRCode(box, { text: url, width: 320, height: 320, correctLevel: QRCode.CorrectLevel.M });
    $("#qrModal").classList.remove("hidden");
  }

  // ---- ランク表示 ----
  function rankInfo(e) {
    const g = cfg[ev.game];
    const t = g.tiers.find(x => x.key === e.tier);
    if (!t) return { label: "未設定", short: "?", color: "#8a96b8" };
    let div = "";
    if (!t.apex && e.division) {
      div = ev.game === "lol" ? ({ "4": "4", "3": "3", "2": "2", "1": "1" }[e.division] || "") : e.division;
    }
    const colors = {
      IRON: "#7a6f63", BRONZE: "#a9714b", SILVER: "#9fb0c3", GOLD: "#e6c14b",
      PLATINUM: "#3fd0c9", EMERALD: "#2fd17a", DIAMOND: "#5b9eff", MASTER: "#b566ff",
      GRANDMASTER: "#ff5b6e", CHALLENGER: "#f5e07a", ASCENDANT: "#3bd17a",
      ASCENDANT2: "#3bd17a", IMMORTAL: "#d4456b", RADIANT: "#fff2b0",
    };
    return {
      label: t.label + (div ? " " + (ev.game === "lol" ? ["", "I", "II", "III", "IV"][["1", "2", "3", "4"].indexOf(e.division) + 1] : div) : ""),
      short: t.label.slice(0, 2) + div,
      color: colors[e.tier] || "#8a96b8",
    };
  }
  function posLabel(key) {
    const p = cfg[ev.game].positions.find(x => x.key === key);
    return p ? p.label : key;
  }
  function posShort(key) {
    return key; // TOP/JG/... or DUEL...
  }

  // ---- エントリー一覧 ----
  function renderEntries() {
    const active = ev.entries.filter(e => e.active !== false);
    $("#entryCount").textContent = active.length;
    const list = $("#entryList");
    list.innerHTML = "";
    active.forEach(e => {
      const ri = rankInfo(e);
      const row = el("div", { class: "entry-row" },
        el("span", { class: "rank-chip", style: "background:" + hexA(ri.color, .18) + ";color:" + ri.color }, ri.label),
        el("div", {},
          el("div", { class: "name" }, e.nickname),
          e.riotId ? el("div", { class: "riot" }, e.riotId) : null,
        ),
        el("div", { class: "pos-badges" },
          el("span", { class: "posbadge p1" }, posShort(e.primaryPos)),
          e.secondaryPos ? el("span", { class: "posbadge p2" }, posShort(e.secondaryPos)) : null,
        ),
        el("button", {
          class: "btn sm danger del",
          onclick: () => deleteEntry(e.id),
        }, "✕"),
      );
      list.append(row);
    });
  }

  async function deleteEntry(id) {
    if (!confirm("このエントリーを削除しますか？")) return;
    try {
      await api("DELETE", "/api/event/" + eventId + "/entry/" + id);
      ev.entries = ev.entries.filter(e => e.id !== id);
      renderEntries();
      toast("削除しました", "ok");
    } catch (e) { toast(e.message, "err"); }
  }

  // ============================================================
  //  チーム分け
  // ============================================================
  async function generateTeams() {
    try {
      const res = await api("POST", "/api/event/" + eventId + "/teams/generate", {});
      ev.teams = res.teams;
      ev.bracket = null;
      ev.bracketView = null;
      renderTeams();
      renderBracket();
      switchStep("teams");
      toast("チーム分けを生成しました", "ok");
    } catch (e) { toast(e.message, "err"); }
  }

  // チーム分け → トーナメント表作成 を一気に実行
  async function generateAll() {
    const btn = $("#genAll");
    btn.disabled = true; const orig = btn.textContent; btn.textContent = "作成中...";
    try {
      const t = await api("POST", "/api/event/" + eventId + "/teams/generate", {});
      ev.teams = t.teams;
      ev.bracket = null; ev.bracketView = null;
      renderTeams();
      const seeding = $("#seedingSel").value;
      const b = await api("POST", "/api/event/" + eventId + "/bracket/generate", { seeding });
      ev.bracket = b.bracket;
      ev.bracketView = b.bracketView;
      renderBracket();
      switchStep("bracket");
      toast("チーム分けとトーナメント表を作成しました！", "ok");
    } catch (e) {
      toast(e.message, "err");
      if (ev.teams) switchStep("teams"); // チームは出来ているので表示
    } finally { btn.disabled = false; btn.textContent = orig; }
  }

  function entryById(id) { return ev.entries.find(e => e.id === id); }

  function renderTeams() {
    const area = $("#teamsArea");
    const subsArea = $("#subsArea");
    area.innerHTML = "";
    subsArea.innerHTML = "";
    $("#rerollTeams").disabled = !(ev.teams && ev.teams.teams);
    if (!ev.teams || !ev.teams.teams || !ev.teams.teams.length) {
      $("#teamMeta").textContent = "";
      $("#balanceInfo").innerHTML = "";
      return;
    }
    const t = ev.teams;
    let sizeLabel;
    if (t.sizeMin && t.sizeMax) {
      sizeLabel = (t.sizeMin === t.sizeMax) ? ("各" + t.sizeMin + "人")
                                            : ("各" + t.sizeMin + "〜" + t.sizeMax + "人");
    } else {
      sizeLabel = "各" + t.teamSize + "人";
    }
    $("#teamMeta").textContent = t.numTeams + "チーム / " + sizeLabel;

    // バランス指標
    const totals = t.teams.map(x => x.total);
    const spread = Math.max(...totals) - Math.min(...totals);
    const avgTotal = totals.reduce((a, b) => a + b, 0) / totals.length;
    const pct = avgTotal ? Math.round((spread / avgTotal) * 100) : 0;
    const cls = pct <= 8 ? "good" : "warn";
    $("#balanceInfo").innerHTML = "戦力差 <span class='" + cls + "'>" + Math.round(spread) +
      " pt (±" + pct + "%)</span>";

    const lolRole = cfg[ev.game].roleRequired;
    t.teams.forEach((team, ti) => {
      const card = el("div", { class: "team-card", "data-team": ti });
      const nameInput = el("input", { class: "tname", value: team.name, type: "text" });
      nameInput.addEventListener("change", () => { team.name = nameInput.value; saveTeams(); });
      card.append(el("div", { class: "head" },
        nameInput,
        el("div", { class: "strength" },
          el("div", { class: "v" }, "平均 " + team.avg),
          el("div", { class: "l" }, "合計 " + team.total),
        ),
      ));
      const mem = el("div", { class: "members" });
      team.members.forEach((m, mi) => {
        const e = entryById(m.entryId);
        if (!e) return;
        const ri = rankInfo(e);
        const slot = el("div", { class: "slot" + (lolRole ? " lol" : "") }, m.pos);
        const fitTag = m.fit === "primary" ? null
          : el("span", { class: "tag " + (m.fit === "secondary" ? "secondary" : "fill") },
              m.fit === "secondary" ? "第2希望" : "オフロール");
        const row = el("div", {
          class: "member", draggable: "true",
          "data-team": ti, "data-idx": mi,
        },
          slot,
          el("div", {},
            el("div", { class: "mname" }, e.nickname),
            el("div", { class: "mrank", style: "color:" + ri.color }, ri.label),
          ),
          el("div", { class: "mright" }, fitTag, el("span", { class: "swap" }, "⠿")),
        );
        attachDrag(row);
        mem.append(row);
      });
      card.append(mem);
      area.append(card);
    });

    // 補欠
    if (t.subs && t.subs.length) {
      const panel = el("div", { class: "subs-panel" },
        el("h3", {}, "🪑 補欠 / 待機 (" + t.subs.length + "人)"));
      const list = el("div", { class: "subs-list" });
      t.subs.forEach(s => {
        const e = entryById(s.entryId);
        if (!e) return;
        const ri = rankInfo(e);
        list.append(el("div", { class: "sub-chip" },
          e.nickname + " ", el("span", { class: "muted", style: "color:" + ri.color }, ri.label)));
      });
      panel.append(list);
      subsArea.append(panel);
    }
  }

  // ---- ドラッグ&ドロップで入れ替え ----
  let dragSrc = null;
  function attachDrag(row) {
    row.addEventListener("dragstart", () => { dragSrc = row; row.classList.add("dragging"); });
    row.addEventListener("dragend", () => { row.classList.remove("dragging"); $$(".member").forEach(m => m.classList.remove("dragover")); });
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("dragover"); });
    row.addEventListener("dragleave", () => row.classList.remove("dragover"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("dragover");
      if (!dragSrc || dragSrc === row) return;
      swapMembers(
        +dragSrc.dataset.team, +dragSrc.dataset.idx,
        +row.dataset.team, +row.dataset.idx
      );
    });
  }

  function swapMembers(t1, i1, t2, i2) {
    const teams = ev.teams.teams;
    const a = teams[t1].members[i1];
    const b = teams[t2].members[i2];
    // ポジションは枠を維持して人を入れ替え
    const tmpPos = a.pos;
    a.pos = b.pos; b.pos = tmpPos;
    teams[t1].members[i1] = b;
    teams[t2].members[i2] = a;
    recalcTeam(teams[t1]); recalcTeam(teams[t2]);
    renderTeams();
    saveTeams();
  }
  function recalcTeam(team) {
    team.total = team.members.reduce((s, m) => s + (m.score || 0), 0);
    team.avg = Math.round(team.total / Math.max(1, team.members.length) * 10) / 10;
  }

  async function saveTeams() {
    try { await api("POST", "/api/event/" + eventId + "/teams", { teams: ev.teams }); }
    catch (e) { toast(e.message, "err"); }
  }

  // ============================================================
  //  トーナメント
  // ============================================================
  async function generateBracket() {
    try {
      const seeding = $("#seedingSel").value;
      const res = await api("POST", "/api/event/" + eventId + "/bracket/generate", { seeding });
      ev.bracket = res.bracket;
      ev.bracketView = res.bracketView;
      renderBracket();
      switchStep("bracket");
      toast("トーナメント表を作成しました", "ok");
    } catch (e) { toast(e.message, "err"); }
  }

  const ROUND_NAMES = (total, r) => {
    const fromEnd = total - r;
    if (fromEnd === 1) return "決勝";
    if (fromEnd === 2) return "準決勝";
    if (fromEnd === 3) return "準々決勝";
    return "ROUND " + (r + 1);
  };

  function renderBracket() {
    const area = $("#bracketArea");
    const banner = $("#champBanner");
    area.innerHTML = "";
    banner.classList.add("hidden");
    if (!ev.bracket) return;
    const view = ev.bracketView || null;
    if (!view) { fetchBracketView(); return; }

    const bracket = el("div", { class: "bracket" });
    view.rounds.forEach((round, r) => {
      const col = el("div", { class: "br-round" });
      col.append(el("div", { class: "rt" }, ROUND_NAMES(view.numRounds, r)));
      round.forEach(match => col.append(renderMatch(match, view.numRounds)));
      bracket.append(col);
    });
    area.append(bracket);

    if (view.champion) {
      banner.classList.remove("hidden");
      banner.innerHTML = "";
      banner.append(
        el("div", { class: "crown" }, "👑"),
        el("div", { class: "ct" }, "CHAMPION"),
        el("div", { class: "cn" }, view.champion.name),
      );
    }
  }

  function renderMatch(match, totalRounds) {
    const m = el("div", { class: "match" });
    [["a", match.a], ["b", match.b]].forEach(([side, team]) => {
      const isWin = match.winner && team && match.winner.id === team.id;
      const otherBye = (side === "a" ? match.b : match.a) === null && team;
      let cls = "slot";
      if (!team) { cls += " empty"; }
      if (isWin) cls += " win";
      const emptyLabel = match.round === 0 ? "BYE（不戦勝）" : "勝者待ち";
      const slot = el("div", { class: cls },
        el("span", { class: "seed" }, ""),
        el("span", { class: "nm" }, team ? team.name : emptyLabel),
      );
      if (team && match.a && match.b) {
        slot.addEventListener("click", () => setResult(match.id, isWin ? null : team.id));
      }
      m.append(slot);
    });
    return m;
  }

  async function setResult(matchId, winner) {
    try {
      const res = await api("POST", "/api/event/" + eventId + "/bracket/result", { matchId, winner });
      ev.bracketView = res.bracketView;
      if (winner) ev.bracket.winners[matchId] = winner;
      else delete ev.bracket.winners[matchId];
      renderBracket();
    } catch (e) { toast(e.message, "err"); }
  }

  async function fetchBracketView() {
    try {
      const res = await api("GET", "/api/event/" + eventId);
      ev.bracketView = res.event.bracketView;
      renderBracket();
    } catch (e) {}
  }

  // ---- 色ユーティリティ ----
  function hexA(hex, a) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
})();
