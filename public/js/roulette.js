// ============================================================
//  抽選ルーレット 主催者ダッシュボード
// ============================================================
(function () {
  let net = null;
  let rid = localStorage.getItem("currentRouletteId") || null;
  let roulette = null;
  let pollTimer = null;
  let lastHash = "";
  let spinning = false;
  let resultShown = false;   // 抽選結果(リール+当選バナー)を表示中か

  init();
  async function init() {
    try { net = await api("GET", "/api/netinfo"); } catch (e) { net = { ip: location.hostname, port: location.port }; }
    bindSetup();
    bindDash();
    if (rid) {
      try { await loadRoulette(); return; }
      catch (e) { rid = null; localStorage.removeItem("currentRouletteId"); }
    }
    showSetup();
  }

  // ---- URL ----
  function isHosted() {
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return false;
    if (/^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  }
  function baseUrl() {
    if (isHosted()) return location.origin;
    if (net.publicUrl) return net.publicUrl;
    return net.lanUrl || ("http://" + net.ip + ":" + net.port);
  }
  function joinUrl() { return baseUrl() + "/roulette/join?rid=" + rid; }

  // ============================================================
  //  セットアップ
  // ============================================================
  function bindSetup() {
    $("#createBtn").addEventListener("click", async () => {
      const btn = $("#createBtn"); btn.disabled = true;
      try {
        const res = await api("POST", "/api/roulette", { title: $("#rTitle").value.trim() });
        rid = res.roulette.id;
        localStorage.setItem("currentRouletteId", rid);
        await loadRoulette();
        toast("QRを生成しました！", "ok");
      } catch (e) { toast(e.message, "err"); }
      finally { btn.disabled = false; }
    });
    $("#newBtn").addEventListener("click", () => { stopPoll(); $("#rTitle").value = ""; showSetup(); });
  }

  async function showSetup() {
    stopPoll();
    $("#dash").classList.add("hidden");
    $("#setup").classList.remove("hidden");
    $("#newBtn").classList.add("hidden");
    const box = $("#rouletteList");
    box.innerHTML = "";
    let list = [];
    try { list = (await api("GET", "/api/roulettes")).roulettes; } catch (e) {}
    if (!list.length) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    box.append(el("div", { class: "sub", style: "margin:6px 4px 10px" }, "既存の抽選を開く"));
    list.reverse().forEach(r => {
      const item = el("div", { class: "r-item" },
        el("span", { class: "spark", style: "width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--gold),var(--accent2));display:grid;place-items:center" }, "🎰"),
        el("div", {},
          el("div", { style: "font-weight:700" }, r.title),
          el("div", { class: "meta" }, r.count + "人エントリー" + (r.winners ? " ・ 当選" + r.winners + "人" : "")),
        ),
        el("div", { class: "spacer", style: "flex:1" }),
        el("button", { class: "btn sm danger", onclick: (e) => { e.stopPropagation(); delRoulette(r.id); } }, "削除"),
        el("span", { class: "muted", style: "margin-left:4px" }, "開く →"),
      );
      item.addEventListener("click", async () => { rid = r.id; localStorage.setItem("currentRouletteId", rid); await loadRoulette(); });
      box.append(item);
    });
  }

  async function delRoulette(id) {
    if (!confirm("この抽選を削除しますか？")) return;
    try { await api("DELETE", "/api/roulette/" + id); if (rid === id) { rid = null; localStorage.removeItem("currentRouletteId"); } showSetup(); }
    catch (e) { toast(e.message, "err"); }
  }

  // ============================================================
  //  読み込み & ポーリング
  // ============================================================
  async function loadRoulette() {
    resultShown = false;
    roulette = (await api("GET", "/api/roulette/" + rid)).roulette;
    $("#setup").classList.add("hidden");
    $("#dash").classList.remove("hidden");
    $("#newBtn").classList.remove("hidden");
    renderQR();
    renderAll();
    startPoll();
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(async () => {
      if (spinning) return;
      try {
        const r = (await api("GET", "/api/roulette/" + rid)).roulette;
        const hash = JSON.stringify(r.entries.map(e => [e.id, e.name, e.food])) + "|" + (r.winners || []).join(",");
        if (hash !== lastHash) { roulette = r; lastHash = hash; renderAll(); }
        else { roulette.open = r.open; }
      } catch (e) {}
    }, 2500);
  }
  function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  // ============================================================
  //  操作
  // ============================================================
  function bindDash() {
    $("#copyUrl").addEventListener("click", () => navigator.clipboard.writeText(joinUrl()).then(() => toast("URLをコピーしました", "ok")));
    $("#openQrFull").addEventListener("click", openQrModal);
    $("#openToggle").addEventListener("change", async (e) => {
      try { await api("POST", "/api/roulette/" + rid + "/settings", { open: e.target.checked }); roulette.open = e.target.checked; $("#openLabel").textContent = e.target.checked ? "受付中" : "受付終了"; }
      catch (err) { toast(err.message, "err"); }
    });
    $("#drawBtn").addEventListener("click", draw);
    $("#resetWinners").addEventListener("click", async () => {
      if (!confirm("当選履歴をリセットしますか？")) return;
      try {
        await api("POST", "/api/roulette/" + rid + "/reset", {});
        roulette.winners = [];
        resultShown = false;
        $("#winnerBanner").classList.add("hidden");
        $("#drawBtn").textContent = "🎲 抽選する";
        renderAll();
      } catch (e) { toast(e.message, "err"); }
    });
  }

  // ============================================================
  //  描画
  // ============================================================
  function renderAll() {
    $("#openToggle").checked = roulette.open !== false;
    $("#openLabel").textContent = roulette.open !== false ? "受付中" : "受付終了";
    lastHash = JSON.stringify(roulette.entries.map(e => [e.id, e.name, e.food])) + "|" + (roulette.winners || []).join(",");
    renderEntries();
    renderWinners();
    if (!resultShown) renderReelStatic();  // 抽選結果表示中はリールを保持
  }

  function renderQR() {
    const url = joinUrl();
    $("#joinUrl").textContent = url; $("#joinUrl").href = url;
    const box = $("#qrcode"); box.innerHTML = "";
    new QRCode(box, { text: url, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M });
    const st = $("#tunnelStatus");
    st.innerHTML = isHosted()
      ? "<span class='dot ready'></span>公開URL — このQR/URLをそのまま参加者に共有できます"
      : "<span class='dot off'></span>同じWi-Fiの端末からエントリーできます";
  }
  function openQrModal() {
    const url = joinUrl();
    $("#qrModalTitle").textContent = roulette.title; $("#qrModalUrl").textContent = url;
    const box = $("#qrBig"); box.innerHTML = "";
    new QRCode(box, { text: url, width: 320, height: 320, correctLevel: QRCode.CorrectLevel.M });
    $("#qrModal").classList.remove("hidden");
  }

  function wonSet() { return new Set(roulette.winners || []); }

  function renderEntries() {
    const list = $("#entryList");
    $("#entryCount").textContent = roulette.entries.length;
    const won = wonSet();
    list.innerHTML = "";
    roulette.entries.forEach((e, i) => {
      list.append(el("div", { class: "r-entry" + (won.has(e.id) ? " is-won" : "") },
        el("span", { class: "num" }, String(i + 1)),
        el("div", {},
          el("div", { class: "nm" }, e.name),
          e.food ? el("div", { class: "food" }, "🍴 " + e.food) : null,
        ),
        won.has(e.id) ? el("span", { class: "won" }, "★当選") : el("button", { class: "btn sm danger del", onclick: () => delEntry(e.id) }, "✕"),
      ));
    });
    $("#drawBtn").disabled = drawablePool().length === 0;
  }

  function drawablePool() {
    const exclude = $("#excludeToggle").checked;
    const won = wonSet();
    return roulette.entries.filter(e => !(exclude && won.has(e.id)));
  }

  async function delEntry(id) {
    if (!confirm("このエントリーを削除しますか？")) return;
    try { await api("DELETE", "/api/roulette/" + rid + "/entry/" + id); roulette.entries = roulette.entries.filter(e => e.id !== id); roulette.winners = (roulette.winners || []).filter(w => w !== id); renderAll(); }
    catch (e) { toast(e.message, "err"); }
  }

  function renderWinners() {
    const wl = $("#winnersList");
    wl.innerHTML = "";
    const winners = roulette.winners || [];
    $("#winCount").textContent = winners.length ? ("当選 " + winners.length + "人") : "";
    $("#resetWinners").classList.toggle("hidden", winners.length === 0);
    winners.forEach((wid, i) => {
      const e = roulette.entries.find(x => x.id === wid);
      if (!e) return;
      wl.append(el("div", { class: "win-chip" },
        el("span", { class: "idx" }, "#" + (i + 1)), e.name,
        e.food ? el("span", { class: "wf" }, e.food) : null));
    });
  }

  // ---- リール ----
  const CARD_W = 200;
  function makeCard(e, isWin) {
    return el("div", { class: "card" + (isWin ? " win" : "") },
      el("div", { class: "cn" }, e ? e.name : "—"),
      e && e.food ? el("div", { class: "cf" }, e.food) : null);
  }
  function renderReelStatic() {
    const reel = $("#reel");
    const has = roulette.entries.length > 0;
    $("#reelEmpty").style.display = has ? "none" : "grid";
    reel.style.transition = "none";
    reel.style.transform = "translateX(0)";
    reel.innerHTML = "";
    if (!has) return;
    // 静止時は参加者をぐるっと並べる
    const list = roulette.entries.concat(roulette.entries, roulette.entries);
    list.slice(0, 30).forEach(e => reel.append(makeCard(e, false)));
  }

  async function draw() {
    if (spinning) return;
    const pool = drawablePool();
    if (!pool.length) return toast("抽選できる参加者がいません", "err");
    spinning = true;
    $("#drawBtn").disabled = true;
    $("#winnerBanner").classList.add("hidden");
    let winner;
    try {
      const res = await api("POST", "/api/roulette/" + rid + "/draw", { excludeWinners: $("#excludeToggle").checked });
      winner = res.winner;
    } catch (e) { toast(e.message, "err"); spinning = false; $("#drawBtn").disabled = false; return; }

    await spin(winner);

    if (!roulette.winners) roulette.winners = [];
    roulette.winners.push(winner.id);
    resultShown = true;
    showWinner(winner);
    confetti();
    renderEntries();
    renderWinners();
    spinning = false;
    $("#drawBtn").disabled = drawablePool().length === 0;
    $("#drawBtn").textContent = "🎲 もう一度抽選する";
  }

  function spin(winner) {
    return new Promise((resolve) => {
      const reel = $("#reel");
      const pool = roulette.entries;
      const TOTAL = 55, TARGET = 48;
      const cards = [];
      for (let i = 0; i < TOTAL; i++) {
        cards.push(i === TARGET ? winner : pool[Math.floor(Math.random() * pool.length)]);
      }
      reel.innerHTML = "";
      cards.forEach((e, i) => reel.append(makeCard(e, i === TARGET)));
      $("#reelEmpty").style.display = "none";

      reel.style.transition = "none";
      reel.style.transform = "translateX(0)";
      reel.offsetHeight; // reflow

      const center = $("#reelWindow").clientWidth / 2;
      const jitter = (Math.random() * 0.5 - 0.25) * CARD_W;
      const targetX = center - (TARGET * CARD_W + CARD_W / 2) + jitter;
      requestAnimationFrame(() => {
        reel.style.transition = "transform 5.6s cubic-bezier(0.10, 0, 0.18, 1)";
        reel.style.transform = "translateX(" + targetX + "px)";
      });
      setTimeout(resolve, 5800);
    });
  }

  function showWinner(w) {
    const b = $("#winnerBanner");
    b.classList.remove("hidden");
    b.innerHTML = "";
    b.append(
      el("div", { class: "crown" }, "🎉"),
      el("div", { class: "label" }, "当選者 WINNER"),
      el("div", { class: "wname" }, w.name),
      w.food ? el("div", { class: "wfood" }, "🍴 好物: " + w.food) : null,
    );
    b.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function confetti() {
    const layer = $("#confetti");
    const colors = ["#ffd34d", "#00d4ff", "#7c5cff", "#34e6a0", "#ff6b6b", "#ff9a9a"];
    for (let i = 0; i < 90; i++) {
      const p = el("div", { class: "confetti-piece" });
      p.style.left = Math.random() * 100 + "vw";
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = (2 + Math.random() * 2) + "s";
      p.style.animationDelay = (Math.random() * 0.6) + "s";
      p.style.transform = "rotate(" + (Math.random() * 360) + "deg)";
      layer.append(p);
      setTimeout(() => p.remove(), 4200);
    }
  }
})();
