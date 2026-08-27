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

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*a,**k): super().__init__(*a,directory=HERE,**k)
    def _json(self,obj,code=200):
        b=json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type","application/json")
        self.send_header("access-control-allow-origin","*")
        self.send_header("content-length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def _who(self):
        q=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        tok=(q.get("email",[""])[0] or q.get("k",[""])[0]).strip().lower()
        who=TOKENS.get(tok)
        if not who and tok.endswith("@sievedata.com"):
            who={"name":tok.split("@")[0],"tasks":list(TASKS.keys()),"rev":True}
        return tok, who
    def _route(self):
        u=urllib.parse.urlparse(self.path)
        q=urllib.parse.parse_qs(u.query)
        if "path" in q: return q["path"][0], "apps"      # Apps Script dialect
        return u.path.lstrip("/"), "worker"
    def do_GET(self):
        route,dialect=self._route()
        if route=="session":
            tok,who=self._who()
            if not who: return self._json({"error":"unknown_email"}, 200 if dialect=="apps" else 403)
            responses={};versions={};savedAt=None;savedBy=None
            for tid in who["tasks"]:
                p=os.path.join(STATE_DIR,tid+".json")
                if not os.path.exists(p): continue
                hist=json.load(open(p))
                if not hist: continue
                versions[tid]=hist
                newest=hist[-1]
                responses.update(newest.get("responses") or {})
                if newest.get("at") and (savedAt is None or newest["at"]>savedAt):
                    savedAt=newest["at"]; savedBy=newest.get("by")
            return self._json({"who":{"name":who["name"],"rev":who["rev"]},
                               "tasks":[TASKS[t] for t in who["tasks"] if t in TASKS],
                               "state":{"responses":responses,"versions":versions,
                                        "savedAt":savedAt,"savedBy":savedBy}})
        return super().do_GET()
    def do_POST(self):
        route,dialect=self._route()
        if route=="state":
            tok,who=self._who()
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
