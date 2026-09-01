#!/usr/bin/env python3
"""Local stand-in for the backend, for testing the site before deploy.

Speaks BOTH dialects so either build can be tested:
  worker : GET /session?k=..     POST /state?k=..
  apps   : GET /?path=session&k=..  POST /?path=state&k=..  (200 + error body)
State is keyed per proposal, exactly as both real backends do."""
import json,os,http.server,socketserver,urllib.parse
HERE=os.path.dirname(os.path.abspath(__file__))
TASKS=json.load(open(os.path.join(HERE,"data/tasks.json")))
TOKENS=json.load(open(os.path.join(HERE,"data/people.json")))
STATE_DIR=os.path.join(HERE,".devstate"); os.makedirs(STATE_DIR,exist_ok=True)
COMMENTS=os.path.join(STATE_DIR,"_comments.json")
def load_comments():
    try: return json.load(open(COMMENTS))
    except Exception: return {}
def save_comments(d): json.dump(d,open(COMMENTS,"w"))
CODES={}; SESSIONS={}          # dev only: in the real backend these are Cache/Properties

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*a,**k): super().__init__(*a,directory=HERE,**k)
    def _json(self,obj,code=200):
        b=json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type","application/json")
        self.send_header("access-control-allow-origin","*")
        self.send_header("content-length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def _lookup(self,email):
        who=TOKENS.get(email)
        if not who and email.endswith("@sievedata.com"):
            who={"name":email.split("@")[0],"tasks":list(TASKS.keys()),"rev":True}
        return who
    def _who(self):
        """Mirror of authed_(): a live session, or a correct one-time code."""
        q=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        sess=q.get("s",[""])[0]
        if sess and sess in SESSIONS:
            em=SESSIONS[sess]; return em, self._lookup(em)
        em=(q.get("email",[""])[0]).strip().lower()
        if not em or not self._lookup(em): return em, None          # unknown_email
        code=q.get("code",[""])[0]
        if not code: return em, "need_code"
        if CODES.get(em)!=code: return em, "bad_code"               # distinct from unknown
        CODES.pop(em,None)                                          # one use only
        return em, self._lookup(em)
    def _route(self):
        u=urllib.parse.urlparse(self.path)
        q=urllib.parse.parse_qs(u.query)
        if "path" in q: return q["path"][0], "apps"      # Apps Script dialect
        return u.path.lstrip("/"), "worker"
    def do_GET(self):
        route,dialect=self._route()
        if route=="code":
            q=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            em=(q.get("email",[""])[0]).strip().lower()
            if not self._lookup(em): return self._json({"error":"unknown_email"},200)
            import random
            CODES[em]="%06d"%random.randint(0,999999)
            # DEV ONLY: the real backend emails this and never returns it.
            # This stand-in hands it back so the flow can be tested without mail.
            return self._json({"ok":True,"sent":True,"devCode":CODES[em]})
        if route=="session":
            tok,who=self._who()
            if isinstance(who,str): return self._json({"error":who}, 200 if dialect=="apps" else 403)
            if not who: return self._json({"error":"unknown_email"}, 200 if dialect=="apps" else 403)
            responses={};versions={};savedAt=None;savedBy=None
            for tid in who["tasks"]:
                p=os.path.join(STATE_DIR,tid+".json")
                if not os.path.exists(p): continue
                hist=json.load(open(p))
                if not hist: continue
                versions[tid]=hist
                newest=hist[-1]
                # Every iteration, oldest first, newest winning: a comment's response is
                # stored on the version that answered its round and is not re-filed by
                # later saves, so reading only the newest row would show a comment the
                # contributor had answered as still open.
                for row in hist: responses.update(row.get("responses") or {})
                if newest.get("at") and (savedAt is None or newest["at"]>savedAt):
                    savedAt=newest["at"]; savedBy=newest.get("by")
            import secrets as _s
            q=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            sess=q.get("s",[""])[0]
            if not sess:
                sess=_s.token_hex(20); SESSIONS[sess]=tok; CODES.pop(tok,None)
                issued=sess
            else: issued=None
            allc=load_comments()
            comments={t:allc[t] for t in who["tasks"] if t in allc}
            return self._json({"who":{"name":who["name"],"rev":who["rev"]},"session":issued,
                               "tasks":[TASKS[t] for t in who["tasks"] if t in TASKS],
                               "comments":comments,
                               "state":{"responses":responses,"versions":versions,
                                        "savedAt":savedAt,"savedBy":savedBy}})
        return super().do_GET()
    def do_POST(self):
        route,dialect=self._route()
        if route=="comments":
            tok,who=self._who()
            if isinstance(who,str) or not who:
                return self._json({"error":who if isinstance(who,str) else "unknown_email"},200)
            if not who["rev"]: return self._json({"error":"not_allowed"},200)
            body=json.loads(self.rfile.read(int(self.headers["content-length"]) or 0) or b"{}")
            import datetime
            store=load_comments(); at=datetime.datetime.now(datetime.timezone.utc).isoformat()
            wrote=[]
            for tid,ov in body.items():
                if len(json.dumps(ov or {}))>45000:
                    return self._json({"error":"too_large","task":tid},200)
                store[tid]=ov or {}; wrote.append(tid)          # written in place
            save_comments(store)
            return self._json({"ok":True,"savedAt":at,"savedBy":who["name"],"tasks":wrote})
        if route=="state":
            tok,who=self._who()
            if isinstance(who,str): return self._json({"error":who}, 200 if dialect=="apps" else 403)
            if not who: return self._json({"error":"unknown_email"}, 200 if dialect=="apps" else 403)
            body=json.loads(self.rfile.read(int(self.headers["content-length"]) or 0) or b"{}")
            for tid in (body.get("versions") or {}):
                if tid not in who["tasks"]:
                    return self._json({"error":"not_your_task","task":tid}, 200 if dialect=="apps" else 403)
            import datetime
            idx={}
            for tid,t in TASKS.items():
                for _,items in t.get("sections",[]):
                    for it in items: idx[it[0]]=tid
            def owner(key):
                if key.startswith("answer:"): return key.split(":")[1]
                if key.startswith("rubricrows:"): return key[len("rubricrows:"):]
                return idx.get(key)
            slices={}
            for k,v in (body.get("responses") or {}).items():
                tid=owner(k)
                if not tid or tid not in who["tasks"]: continue
                slices.setdefault(tid,{})[k]=v
            now=datetime.datetime.now(datetime.timezone.utc).isoformat()
            written=[]
            for tid in who["tasks"]:
                sl=slices.get(tid); ver=(body.get("versions") or {}).get(tid)
                if not sl and not ver: continue
                fp=os.path.join(STATE_DIR,tid+".json")
                hist=json.load(open(fp)) if os.path.exists(fp) else []
                if isinstance(ver,list): ver=ver[-1] if ver else None
                n=(hist[-1]["v"]+1) if hist else 2
                hist.append({"v":n,"at":now,"by":who["name"],
                             "answers":(ver or {}).get("answers",{}),
                             "rows":(ver or {}).get("rows",[]),
                             "responses":sl or {}})
                json.dump(hist,open(fp,"w"))
                written.append({"task":tid,"v":n})
            return self._json({"ok":True,"savedAt":now,"savedBy":who["name"],"tasks":written})
        return self._json({"error":"not_found"},404)
    def log_message(self,*a): pass

if __name__=="__main__":
    socketserver.TCPServer.allow_reuse_address=True
    with socketserver.TCPServer(("",8801),H) as s:
        print("dev server on http://localhost:8801"); s.serve_forever()
