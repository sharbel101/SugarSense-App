"""Episode mode with minimal metrics on the real local model. SYNTHETIC DATA ONLY; same safeguards as run_benchmark.py (sequential, 4-CPU capped container, health monitor)."""
import json
import os
import sys
import time

from sugarsense_insights.config import LlmConfig
from sugarsense_insights.llm import LlamaClient
from sugarsense_insights.models import Meal
from sugarsense_insights.pipeline import run
from sugarsense_insights.store import InMemoryStore

from helpers import FakeSource, USER, local, snapshot, cgm, _g
from run_benchmark import Monitor, MORNING, EVENING

low_night = lambda lm: 55.0 if 3 * 60 <= lm <= 4 * 60 else _g(lm)
SC = [
    ("1 glucose only, evening", "evening", snapshot(EVENING, days=9)),
    ("2 glucose only, morning", "morning", snapshot(MORNING, days=9)),
    ("3 glucose + meals only, evening", "evening", snapshot(EVENING, days=9, meals=[Meal(f"m{k}", local(2026, 10, 21 - k, 8, 30), "confirmed", 50.0) for k in range(5)])),
    ("4 glucose only with a night low, morning", "morning", snapshot(MORNING, readings=cgm(9, MORNING, curve=low_night))),
]
client = LlamaClient(LlmConfig(url=os.environ.get("INSIGHTS_LLM_URL", "http://127.0.0.1:8181"), timeout_s=420))
mon = Monitor(); mon.start()
client.explain([{"insight_id": "I1", "category": "x", "claims": ["Test [E1]."], "refs": ["E1"], "boundaries": [], "limitations": []}])   # warm-up
rows = []
for name, kind, snap in SC:
    if mon.abort:
        print("ABORTED by monitor"); break
    r = run(kind, USER, snap.now, FakeSource(snap), InMemoryStore(), client, persist=False)
    s = r.stats
    row = {"scenario": name, "insights": s.get("insights"), "valid": sum(1 for i in r.insights if i["validation_status"] == "valid"), "fallback": sum(1 for i in r.insights if i["validation_status"] == "fallback"),
           "retries": s.get("retries", 0), "latency_s": s.get("llm_latency_s"), "prompt_tokens": s.get("prompt_tokens"), "completion_tokens": s.get("completion_tokens"), "violations": s.get("violations"),
           "explanations": [[i["category"], i["validation_status"], i["content"]["explanation"], i["content"]["facts_text"][0]] for i in r.insights]}
    rows.append(row)
    print(f"\n=== {name}: insights={row['insights']} valid={row['valid']} fallback={row['fallback']} retries={row['retries']} latency={row['latency_s']}s ptok={row['prompt_tokens']} ctok={row['completion_tokens']} viol={row['violations']}", flush=True)
    for cat, st, expl, fact in row["explanations"]:
        print(f"  [{cat}|{st}] {expl}")
mon.stop_flag = True
time.sleep(1)
print("\nmonitor: samples", len(mon.samples), "max forecast ms", round(max(x["forecast_s"] for x in mon.samples) * 1000, 1), "max backend ms", round(max(x["backend_s"] for x in mon.samples) * 1000, 1), "non200", sum(1 for x in mon.samples if x["forecast_code"] != 200 or x["backend_code"] != 200), "aborted", mon.abort)
json.dump(rows, open("minimal_metrics.json", "w"), indent=1)
