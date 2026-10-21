"""Prints the validated explanations the model wrote for three synthetic scenarios, for human review. Same safeguards as run_benchmark.py. SYNTHETIC DATA ONLY."""
import os
import sys
import time

from sugarsense_insights.config import LlmConfig
from sugarsense_insights.llm import LlamaClient
from sugarsense_insights.pipeline import run
from sugarsense_insights.store import InMemoryStore

from helpers import FakeSource, USER
from run_benchmark import Monitor, scenarios

PICK = (0, 2, 4)   # A morning complete, C evening rich, E injection
client = LlamaClient(LlmConfig(url=os.environ.get("INSIGHTS_LLM_URL", "http://127.0.0.1:8181"), timeout_s=420))
mon = Monitor(); mon.start()
sc = scenarios()
for i in PICK:
    if mon.abort:
        print("ABORTED by monitor"); break
    name, kind, snap = sc[i]
    r = run(kind, USER, snap.now, FakeSource(snap), InMemoryStore(), client, persist=False)
    print(f"\n=== {name}  ({r.stats.get('llm_latency_s')} s, completion tokens {r.stats.get('completion_tokens')}, violations {r.stats.get('violations')})")
    for ins in r.insights:
        c = ins["content"]
        print(f"- [{ins['category']}] ({ins['validation_status']})")
        print("    PYTHON : " + c["facts_text"][0][:230])
        print("    MODEL  : " + str(c["explanation"]))
        if c["limitations"]:
            print("    LIMITS : " + " | ".join(c["limitations"])[:200])
mon.stop_flag = True
time.sleep(1)
print("\nmonitor: samples", len(mon.samples), "max forecast ms", round(max(x["forecast_s"] for x in mon.samples) * 1000, 1), "aborted", mon.abort)
