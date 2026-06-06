# -*- coding: utf-8 -*-
"""
即興カスタム チームメイカー  (Instant Custom Team Maker)
=========================================================
LoL / VALORANT イベント用 自動チーム分け & トーナメント作成ツール

- 参加者はQRコードを読み取りスマホからエントリー
- ランク / 希望ポジションをもとに自動でバランス調整したチーム分け
- トーナメント表（シングルエリミネーション）を自動生成

Python 標準ライブラリのみ使用 (追加インストール不要)。
起動:  python server.py   または  start.bat をダブルクリック
"""

import json
import os
import re
import sys
import socket
import threading
import webbrowser
import random
import math
import subprocess
import atexit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from uuid import uuid4

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
DATA_FILE = os.path.join(BASE_DIR, "data.json")
PORT = int(os.environ.get("PORT", "8080"))
CLOUDFLARED = os.path.join(BASE_DIR, "cloudflared.exe")

# --------------------------------------------------------------------------
# ランク / ポジション設定
# --------------------------------------------------------------------------
RANKS = {
    "lol": {
        "label": "League of Legends",
        "tiers": [
            ("IRON", "アイアン", 0),
            ("BRONZE", "ブロンズ", 400),
            ("SILVER", "シルバー", 800),
            ("GOLD", "ゴールド", 1200),
            ("PLATINUM", "プラチナ", 1600),
            ("EMERALD", "エメラルド", 2000),
            ("DIAMOND", "ダイヤモンド", 2400),
            ("MASTER", "マスター", 2900),
            ("GRANDMASTER", "グランドマスター", 3300),
            ("CHALLENGER", "チャレンジャー", 3800),
        ],
        # ディビジョン IV(4) .. I(1)  低 -> 高
        "divisions": {"4": 0, "3": 100, "2": 200, "1": 300},
        "apex": {"MASTER", "GRANDMASTER", "CHALLENGER"},
        "unranked_score": 1000,  # アンランク/不明 のときの推定値
        "positions": [
            ("TOP", "トップ"),
            ("JG", "ジャングル"),
            ("MID", "ミッド"),
            ("ADC", "ボット(ADC)"),
            ("SUP", "サポート"),
        ],
        "role_required": True,
    },
    "valo": {
        "label": "VALORANT",
        "tiers": [
            ("IRON", "アイアン", 0),
            ("BRONZE", "ブロンズ", 300),
            ("SILVER", "シルバー", 600),
            ("GOLD", "ゴールド", 900),
            ("PLATINUM", "プラチナ", 1200),
            ("DIAMOND", "ダイヤモンド", 1500),
            ("ASCENDANT", "アセンダント", 1800),
            ("IMMORTAL", "イモータル", 2100),
            ("RADIANT", "レディアント", 2500),
        ],
        # ディビジョン 1 .. 3  低 -> 高
        "divisions": {"1": 0, "2": 100, "3": 200},
        "apex": {"RADIANT"},
        "unranked_score": 800,
        "positions": [
            ("DUEL", "デュエリスト"),
            ("INIT", "イニシエーター"),
            ("CTRL", "コントローラー"),
            ("SENT", "センチネル"),
            ("FLEX", "フレックス"),
        ],
        "role_required": False,
    },
}


def player_score(game, tier, division):
    cfg = RANKS[game]
    base = None
    for key, _label, val in cfg["tiers"]:
        if key == tier:
            base = val
            break
    if base is None:
        return cfg["unranked_score"]
    if tier in cfg["apex"]:
        return base
    return base + cfg["divisions"].get(str(division), 0)


# --------------------------------------------------------------------------
# データ永続化
# --------------------------------------------------------------------------
_lock = threading.RLock()


def load_data():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"events": {}}


def save_data(data):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)


DATA = load_data()


def sid(n=8):
    return uuid4().hex[:n]


# --------------------------------------------------------------------------
# チーム分けロジック
# --------------------------------------------------------------------------
def entry_score(game, e):
    return player_score(game, e.get("tier"), e.get("division"))


def decide_num_teams(n, tsize=5):
    """1チーム tsize 人固定。トーナメント用にチーム数を決める。
       40名以上 → 8チーム / 21名以上 → 4チーム / それ未満 → 作れるだけ。"""
    if n >= 8 * tsize:
        return 8           # 例: 5人×8 = 40名以上
    if n > 4 * tsize:
        return 4           # 例: 5人×4 を超える(21名以上)
    return n // tsize      # 20名以下は作れる分だけ


def generate_teams(event, options=None):
    options = options or {}
    game = event["game"]
    cfg = RANKS[game]
    tsize = int(event.get("teamSize", 5))
    entries = [e for e in event["entries"] if e.get("active", True)]
    n = len(entries)
    num_teams = decide_num_teams(n, tsize)

    result = {"teams": [], "subs": [], "numTeams": num_teams, "teamSize": tsize}
    if num_teams < 1:
        result["error"] = "メンバーが足りません (最低 %d 名必要です)" % tsize
        return result

    for e in entries:
        e["_score"] = entry_score(game, e)

    # === 抽選: 出場者を無作為に選出 (あぶれた人は補欠。再シャッフルで入れ替わる) ===
    pool = list(entries)
    random.shuffle(pool)
    selected = pool[: num_teams * tsize]
    subs = pool[num_teams * tsize:]

    # 出場者は戦力が均等になるようスコア降順で配分
    selected.sort(key=lambda e: -e["_score"])

    positions = [p[0] for p in cfg["positions"]]

    def rnd():
        return random.random()

    teams = []
    for i in range(num_teams):
        teams.append({
            "id": i, "name": team_name(i), "members": [], "total": 0,
            "slots": {p[0]: None for p in cfg["positions"]} if cfg["role_required"] else None,
        })

    if cfg["role_required"]:
        role_keys = positions          # [TOP, JG, MID, ADC, SUP]
        cap = num_teams                # 各ロールはチーム数だけ枠がある
        SUP = "SUP"
        # --- Step1: ロール決定 (低レートから順に希望ロールを割り当て) ---
        role_count = {r: 0 for r in role_keys}
        role_of = {}                   # entryId -> role
        leftover = []
        for p in sorted(selected, key=lambda e: e["_score"]):   # 低レート順
            prim = p.get("primaryPos")
            sec = p.get("secondaryPos")
            if prim in role_count and role_count[prim] < cap:
                role_of[p["id"]] = prim
                role_count[prim] += 1
            elif sec in role_count and role_count[sec] < cap:
                role_of[p["id"]] = sec
                role_count[sec] += 1
            else:
                leftover.append(p)     # 希望が埋まっていた(主に上位レート)
        # --- 希望が通らなかった人は サポート優先で配置 (高レートから) ---
        for p in sorted(leftover, key=lambda e: -e["_score"]):  # 高レート順
            if role_count[SUP] < cap:
                target = SUP
            else:
                target = next(r for r in role_keys if role_count[r] < cap)
            role_of[p["id"]] = target
            role_count[target] += 1
        # --- Step2: チーム配分 (各ロール内で強い人を戦力の低いチームへ) ---
        #     → 同ロールは各チーム1人ずつ = 対面。
        #     戦力差の大きいロールから先に配分すると、チーム合計が均衡しやすい。
        def role_range(r):
            sc = [p["_score"] for p in selected if role_of[p["id"]] == r]
            return (max(sc) - min(sc)) if sc else 0

        for r in sorted(role_keys, key=role_range, reverse=True):
            role_players = sorted(
                [p for p in selected if role_of[p["id"]] == r],
                key=lambda e: -e["_score"])                       # 強い順
            for p in role_players:
                cands = [t for t in teams if t["slots"][r] is None]
                chosen = min(cands, key=lambda t: (t["total"], rnd()))
                prim = p.get("primaryPos")
                sec = p.get("secondaryPos")
                fit = "primary" if r == prim else ("secondary" if r == sec else "fill")
                chosen["slots"][r] = p["id"]
                chosen["members"].append({
                    "entryId": p["id"], "pos": r, "fit": fit, "score": p["_score"],
                })
                chosen["total"] += p["_score"]
    else:
        for p in selected:
            prim = p.get("primaryPos")
            cands = [t for t in teams if len(t["members"]) < tsize]

            def keyf(t, prim=prim):
                has_role = any(m["pos"] == prim for m in t["members"])
                return (t["total"], 0 if not has_role else 1, rnd())

            chosen = min(cands, key=keyf)
            chosen["members"].append({
                "entryId": p["id"], "pos": prim or "FLEX", "fit": "primary", "score": p["_score"],
            })
            chosen["total"] += p["_score"]

    # 平均算出 & ロール順並び替え
    order = {p: i for i, p in enumerate(positions)}
    for t in teams:
        cnt = max(1, len(t["members"]))
        t["avg"] = round(t["total"] / cnt, 1)
        t["members"].sort(key=lambda m: order.get(m["pos"], 99))

    result["teams"] = teams
    result["subs"] = [{"entryId": s["id"], "score": s["_score"]} for s in subs]
    totals = [t["total"] for t in teams]
    result["balance"] = {
        "min": min(totals), "max": max(totals),
        "spread": max(totals) - min(totals),
    }
    for e in entries:
        e.pop("_score", None)
    return result


def team_name(i):
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    if i < 26:
        return "Team " + letters[i]
    return "Team " + letters[i // 26 - 1] + letters[i % 26]


# --------------------------------------------------------------------------
# トーナメント (シングルエリミネーション)
# --------------------------------------------------------------------------
def seed_order(size):
    res = [1, 2]
    while len(res) < size:
        m = len(res) * 2 + 1
        new = []
        for x in res:
            new.append(x)
            new.append(m - x)
        res = new
    return res


def generate_bracket(event, options=None):
    options = options or {}
    seeding = options.get("seeding", "strength")
    teams = event.get("teams", {}).get("teams", [])
    if len(teams) < 2:
        return {"error": "トーナメントには2チーム以上必要です"}

    order = list(teams)
    if seeding == "strength":
        order.sort(key=lambda t: -t.get("total", 0))
    else:
        random.shuffle(order)
    seeds = [{"id": t["id"], "name": t["name"]} for t in order]

    n = len(seeds)
    size = 1
    while size < n:
        size *= 2

    pos = seed_order(size)
    seed_teams = []
    for s in pos:
        seed_teams.append(seeds[s - 1] if s - 1 < n else None)

    num_rounds = int(math.log2(size))
    return {
        "seeding": seeding,
        "size": size,
        "numRounds": num_rounds,
        "seedTeams": seed_teams,   # 長さ size, None はBYE
        "winners": {},             # "r-i" -> teamId
    }


def bracket_view(bracket):
    size = bracket["size"]
    seed_teams = bracket["seedTeams"]
    winners = bracket.get("winners", {})
    num_rounds = bracket["numRounds"]

    def winner_of(r, i):
        # round r, match i の勝者を返す
        view = rounds[r][i]
        a, b = view["a"], view["b"]
        if a is not None and b is not None:
            # 両者そろっている通常の試合 → 記録された勝者のみ
            w = winners.get("%d-%d" % (r, i))
            if w is not None and w in (a.get("id"), b.get("id")):
                return a if w == a.get("id") else b
            return None
        # 片側が None
        if r == 0:
            # 1回戦の片側 None は不戦勝(BYE) → 存在する側が自動勝ち上がり
            if a is None and b is None:
                return None
            return a if b is None else b
        # 2回戦以降の None は「上の試合がまだ未確定」 → 勝者なし(TBD)
        return None

    rounds = []
    # round 0
    r0 = []
    for i in range(size // 2):
        r0.append({"id": "0-%d" % i, "round": 0, "index": i,
                   "a": seed_teams[2 * i], "b": seed_teams[2 * i + 1], "winner": None})
    rounds.append(r0)
    for i in range(size // 2):
        rounds[0][i]["winner"] = winner_of(0, i)

    for r in range(1, num_rounds):
        cur = []
        cnt = size // (2 ** (r + 1))
        for i in range(cnt):
            a = winner_of(r - 1, 2 * i)
            b = winner_of(r - 1, 2 * i + 1)
            cur.append({"id": "%d-%d" % (r, i), "round": r, "index": i, "a": a, "b": b, "winner": None})
        rounds.append(cur)
        for i in range(cnt):
            rounds[r][i]["winner"] = winner_of(r, i)

    champion = rounds[-1][0]["winner"] if rounds else None
    return {"rounds": rounds, "champion": champion, "numRounds": num_rounds, "size": size}


# --------------------------------------------------------------------------
# ネットワーク
# --------------------------------------------------------------------------
def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


SERVER_IP = lan_ip()

# --------------------------------------------------------------------------
# Cloudflare Tunnel (インターネット公開 — 同一Wi-Fi不要)
# --------------------------------------------------------------------------
TUNNEL_FILE = os.path.join(BASE_DIR, "tunnel.json")

TUNNEL = {
    "url": None,        # https://xxx.trycloudflare.com もしくは固定ホスト名
    "status": "off",    # off | starting | ready | error | disabled
    "proc": None,
    "mode": "quick",    # quick | named
    "fixed": False,     # 固定URL(独自ドメイン)かどうか
}
_url_re = re.compile(r"https://[-0-9a-z]+\.trycloudflare\.com")


def _load_tunnel_config():
    """tunnel.json があり hostname/tunnel を持てば固定トンネル設定を返す"""
    if os.path.exists(TUNNEL_FILE):
        try:
            with open(TUNNEL_FILE, "r", encoding="utf-8") as f:
                c = json.load(f)
            if c.get("hostname") and c.get("tunnel"):
                return c
        except Exception:
            pass
    return None


def _tunnel_reader(proc, mode):
    try:
        for line in iter(proc.stdout.readline, ""):
            if not line:
                break
            if mode == "quick":
                m = _url_re.search(line)
                if m and not TUNNEL["url"]:
                    TUNNEL["url"] = m.group(0)
                    TUNNEL["status"] = "ready"
                    print("  オンライン公開URL : %s" % TUNNEL["url"])
                    print("  → どの回線(4G/5G/別Wi-Fi)からでもエントリー可能になりました")
            else:  # named (固定URL)
                if ("Registered tunnel connection" in line or
                        "Connection registered" in line) and TUNNEL["status"] != "ready":
                    TUNNEL["status"] = "ready"
                    print("  固定URLで公開中 : %s" % TUNNEL["url"])
    except Exception:
        pass
    finally:
        if TUNNEL["status"] != "ready":
            TUNNEL["status"] = "error"


def start_tunnel():
    if os.environ.get("NO_TUNNEL") == "1":
        TUNNEL["status"] = "disabled"
        return
    if not os.path.exists(CLOUDFLARED):
        TUNNEL["status"] = "disabled"
        return
    cfg = _load_tunnel_config()
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    TUNNEL["status"] = "starting"
    try:
        if cfg:
            # 固定URLモード (独自ドメイン / Named Tunnel)
            TUNNEL["mode"] = "named"
            TUNNEL["fixed"] = True
            TUNNEL["url"] = "https://" + cfg["hostname"]
            args = [CLOUDFLARED, "--no-autoupdate", "tunnel", "run",
                    "--url", "http://localhost:%d" % PORT, cfg["tunnel"]]
        else:
            # 使い捨てURLモード (quick tunnel)
            TUNNEL["mode"] = "quick"
            TUNNEL["fixed"] = False
            args = [CLOUDFLARED, "tunnel", "--url",
                    "http://localhost:%d" % PORT, "--no-autoupdate"]
        proc = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", creationflags=flags,
        )
        TUNNEL["proc"] = proc
        threading.Thread(target=_tunnel_reader, args=(proc, TUNNEL["mode"]), daemon=True).start()
    except Exception as e:
        TUNNEL["status"] = "error"
        print("  [警告] トンネル起動失敗: %s" % e)


def stop_tunnel():
    p = TUNNEL.get("proc")
    if p and p.poll() is None:
        try:
            p.terminate()
        except Exception:
            pass


atexit.register(stop_tunnel)


# --------------------------------------------------------------------------
# HTTP ハンドラ
# --------------------------------------------------------------------------
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "CustomMaker/1.0"

    def log_message(self, fmt, *args):
        pass  # ログ抑制

    # ---- helpers ----
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _serve_file(self, path):
        full = os.path.normpath(os.path.join(PUBLIC_DIR, path.lstrip("/")))
        if not full.startswith(PUBLIC_DIR) or not os.path.isfile(full):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if ext in (".js", ".css", ".html"):
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---- GET ----
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/" or path == "/admin":
            return self._serve_file("admin.html")
        if path == "/join" or path == "/entry":
            return self._serve_file("entry.html")
        if path == "/api/netinfo":
            return self._json({
                "ip": SERVER_IP, "port": PORT,
                "lanUrl": "http://%s:%d" % (SERVER_IP, PORT),
                "publicUrl": TUNNEL["url"],
                "tunnelStatus": TUNNEL["status"],
                "tunnelFixed": TUNNEL["fixed"],
            })
        if path == "/api/config":
            return self._json(public_config())
        if path == "/api/events":
            return self.api_events_list()

        m = re.match(r"^/api/event/([\w-]+)/public$", path)
        if m:
            return self.api_event_public(m.group(1))
        m = re.match(r"^/api/event/([\w-]+)$", path)
        if m:
            return self.api_event_get(m.group(1))

        if path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)

        return self._serve_file(path)

    # ---- POST ----
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        if path == "/api/event":
            return self.api_event_create(body)

        m = re.match(r"^/api/event/([\w-]+)/entry$", path)
        if m:
            return self.api_entry(m.group(1), body)
        m = re.match(r"^/api/event/([\w-]+)/teams/generate$", path)
        if m:
            return self.api_teams_generate(m.group(1), body)
        m = re.match(r"^/api/event/([\w-]+)/teams$", path)
        if m:
            return self.api_teams_save(m.group(1), body)
        m = re.match(r"^/api/event/([\w-]+)/bracket/generate$", path)
        if m:
            return self.api_bracket_generate(m.group(1), body)
        m = re.match(r"^/api/event/([\w-]+)/bracket/result$", path)
        if m:
            return self.api_bracket_result(m.group(1), body)
        m = re.match(r"^/api/event/([\w-]+)/settings$", path)
        if m:
            return self.api_settings(m.group(1), body)
        m = re.match(r"^/api/event/([\w-]+)/reset$", path)
        if m:
            return self.api_reset(m.group(1), body)

        return self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        m = re.match(r"^/api/event/([\w-]+)/entry/([\w-]+)$", path)
        if m:
            return self.api_entry_delete(m.group(1), m.group(2))
        m = re.match(r"^/api/event/([\w-]+)$", path)
        if m:
            return self.api_event_delete(m.group(1))
        return self._json({"error": "not found"}, 404)

    # ====== API 実装 ======
    def api_event_create(self, body):
        game = body.get("game", "lol")
        if game not in RANKS:
            return self._json({"error": "invalid game"}, 400)
        eid = sid()
        ev = {
            "id": eid,
            "game": game,
            "title": body.get("title") or RANKS[game]["label"] + " 即興カスタム",
            "teamSize": int(body.get("teamSize", 5)),
            "open": True,
            "entries": [],
            "teams": None,
            "bracket": None,
        }
        with _lock:
            DATA["events"][eid] = ev
            save_data(DATA)
        return self._json({"event": ev})

    def api_events_list(self):
        out = []
        for ev in DATA["events"].values():
            out.append({
                "id": ev["id"], "game": ev["game"], "title": ev["title"],
                "count": len([e for e in ev["entries"] if e.get("active", True)]),
                "hasTeams": bool(ev.get("teams")),
                "hasBracket": bool(ev.get("bracket")),
                "open": ev.get("open", True),
            })
        return self._json({"events": out})

    def api_event_get(self, eid):
        ev = DATA["events"].get(eid)
        if not ev:
            return self._json({"error": "event not found"}, 404)
        out = dict(ev)
        if ev.get("bracket"):
            out["bracketView"] = bracket_view(ev["bracket"])
        return self._json({"event": out})

    def api_event_public(self, eid):
        ev = DATA["events"].get(eid)
        if not ev:
            return self._json({"error": "event not found"}, 404)
        return self._json({
            "id": ev["id"], "game": ev["game"], "title": ev["title"],
            "open": ev.get("open", True),
            "count": len([e for e in ev["entries"] if e.get("active", True)]),
        })

    def api_event_delete(self, eid):
        with _lock:
            DATA["events"].pop(eid, None)
            save_data(DATA)
        return self._json({"ok": True})

    def api_entry(self, eid, body):
        with _lock:
            ev = DATA["events"].get(eid)
            if not ev:
                return self._json({"error": "event not found"}, 404)
            if not ev.get("open", True):
                return self._json({"error": "エントリーは締め切られています"}, 403)
            nickname = (body.get("nickname") or "").strip()
            if not nickname:
                return self._json({"error": "名前を入力してください"}, 400)
            entry_id = body.get("entryId")
            existing = None
            if entry_id:
                for e in ev["entries"]:
                    if e["id"] == entry_id:
                        existing = e
                        break
            data = {
                "nickname": nickname[:32],
                "riotId": (body.get("riotId") or "").strip()[:48],
                "tier": body.get("tier"),
                "division": str(body.get("division", "")),
                "primaryPos": body.get("primaryPos"),
                "secondaryPos": body.get("secondaryPos"),
                "note": (body.get("note") or "").strip()[:140],
                "active": True,
            }
            if existing:
                existing.update(data)
                entry = existing
            else:
                entry = {"id": sid(), **data}
                ev["entries"].append(entry)
            save_data(DATA)
        return self._json({"entry": entry})

    def api_entry_delete(self, eid, entry_id):
        with _lock:
            ev = DATA["events"].get(eid)
            if not ev:
                return self._json({"error": "event not found"}, 404)
            ev["entries"] = [e for e in ev["entries"] if e["id"] != entry_id]
            save_data(DATA)
        return self._json({"ok": True})

    def api_settings(self, eid, body):
        with _lock:
            ev = DATA["events"].get(eid)
            if not ev:
                return self._json({"error": "event not found"}, 404)
            if "open" in body:
                ev["open"] = bool(body["open"])
            if "title" in body and body["title"]:
                ev["title"] = str(body["title"])[:60]
            if "teamSize" in body:
                ev["teamSize"] = max(1, int(body["teamSize"]))
            save_data(DATA)
        return self._json({"event": ev})

    def api_teams_generate(self, eid, body):
        with _lock:
            ev = DATA["events"].get(eid)
            if not ev:
                return self._json({"error": "event not found"}, 404)
            res = generate_teams(ev, body)
            if res.get("error"):
                return self._json(res, 400)
            ev["teams"] = res
            ev["bracket"] = None  # チーム再生成でトーナメントはリセット
            save_data(DATA)
        return self._json({"teams": res})

    def api_teams_save(self, eid, body):
        with _lock:
            ev = DATA["events"].get(eid)
            if not ev:
                return self._json({"error": "event not found"}, 404)
            ev["teams"] = body.get("teams") or ev.get("teams")
            save_data(DATA)
        return self._json({"ok": True, "teams": ev["teams"]})

    def api_bracket_generate(self, eid, body):
        with _lock:
            ev = DATA["events"].get(eid)
            if not ev:
                return self._json({"error": "event not found"}, 404)
            if not ev.get("teams") or not ev["teams"].get("teams"):
                return self._json({"error": "先にチーム分けをしてください"}, 400)
            br = generate_bracket(ev, body)
            if br.get("error"):
                return self._json(br, 400)
            ev["bracket"] = br
            save_data(DATA)
        return self._json({"bracket": br, "bracketView": bracket_view(br)})

    def api_bracket_result(self, eid, body):
        with _lock:
            ev = DATA["events"].get(eid)
            if not ev or not ev.get("bracket"):
                return self._json({"error": "bracket not found"}, 404)
            mid = body.get("matchId")
            winner = body.get("winner")  # teamId or None(取消)
            if mid is None:
                return self._json({"error": "matchId required"}, 400)
            if winner is None:
                ev["bracket"]["winners"].pop(mid, None)
            else:
                ev["bracket"]["winners"][mid] = winner
            save_data(DATA)
            view = bracket_view(ev["bracket"])
        return self._json({"bracketView": view})

    def api_reset(self, eid, body):
        with _lock:
            ev = DATA["events"].get(eid)
            if not ev:
                return self._json({"error": "event not found"}, 404)
            what = body.get("what", "all")
            if what in ("all", "bracket"):
                ev["bracket"] = None
            if what in ("all", "teams"):
                ev["teams"] = None
                ev["bracket"] = None
            save_data(DATA)
        return self._json({"ok": True})


def public_config():
    cfg = {}
    for g, c in RANKS.items():
        cfg[g] = {
            "label": c["label"],
            "tiers": [{"key": k, "label": l, "apex": k in c["apex"]} for k, l, _ in c["tiers"]],
            "divisions": list(c["divisions"].keys()),
            "positions": [{"key": k, "label": l} for k, l in c["positions"]],
            "roleRequired": c["role_required"],
        }
    return cfg


# --------------------------------------------------------------------------
def main():
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    url_local = "http://localhost:%d/admin" % PORT
    url_lan = "http://%s:%d" % (SERVER_IP, PORT)
    print("=" * 64)
    print("  即興カスタム チームメイカー  起動しました")
    print("=" * 64)
    print("  主催者用ダッシュボード : %s" % url_local)
    print("  LAN内エントリーURL     : %s/join?ev=<イベントID>" % url_lan)
    if os.path.exists(CLOUDFLARED) and os.environ.get("NO_TUNNEL") != "1":
        print()
        print("  オンライン公開を準備中... (数秒お待ちください)")
        print("  ※準備が完了すると どの回線からでもエントリー可能になります")
    else:
        print()
        print("  ※オンライン公開はオフ (cloudflared.exe が無い / NO_TUNNEL=1)")
        print("  ※参加者のスマホは主催PCと同じWi-Fiに接続してください")
    print()
    print("  終了するには このウィンドウで Ctrl+C")
    print("=" * 64)
    start_tunnel()
    try:
        webbrowser.open(url_local)
    except Exception:
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します...")
        stop_tunnel()
        httpd.shutdown()


if __name__ == "__main__":
    main()
