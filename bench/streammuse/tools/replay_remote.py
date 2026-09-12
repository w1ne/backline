"""Replay StreamMUSE requests from an inferences.json against the server through an SSH tunnel
(laptop -> pod), to measure the *remote* per-request round trip the way a browser client would see it."""
import json, sys, time, statistics, requests
url = sys.argv[1]; log = json.load(open(sys.argv[2]))
requests.post(url.replace("generate_accompaniment", "clear_history"))
rtts, srv = [], []
for e in log:
    req = dict(e["request"]); req["client_request_send_time"] = time.perf_counter()
    t0 = time.perf_counter(); r = requests.post(url, json=req); t1 = time.perf_counter()
    r.raise_for_status(); tm = r.json()["timings"]
    rtts.append((t1 - t0) * 1000); srv.append((tm["response_output_time"] - tm["request_arrival_time"]) * 1000)
    time.sleep(0.05)
q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
print(json.dumps({"n": len(rtts), "rtt_mean": statistics.mean(rtts), "rtt_p50": q(rtts, .5), "rtt_p95": q(rtts, .95), "rtt_max": max(rtts),
                  "server_mean": statistics.mean(srv), "server_p95": q(srv, .95)}, indent=1))
