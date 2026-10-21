"""The one-paragraph reasoning flow on the real local model, with scenarios that mirror real situations. SYNTHETIC DATA ONLY; sequential; 4-CPU capped container; health monitor.

  A  a high around 06:00 on most days with no food or insulin logged overnight, and the user's morning-resistance setting switched on
  B  a big post-breakfast spike where the dose was logged after the meal started, repeated across days
  C  a low about 3 hours after a lunch dose, repeated
  D  a low a few hours after an afternoon activity, repeated
  E  glucose only (nothing but readings)
"""
import json
import math
import os
import sys
import time
from datetime import timedelta

from sugarsense_insights.config import LlmConfig
from sugarsense_insights.llm import LlamaClient
from sugarsense_insights.models import Activity, Insulin, Meal
from sugarsense_insights.pipeline import run
from sugarsense_insights.store import InMemoryStore

from helpers import FakeSource, USER, cgm, local, snapshot
from run_benchmark import Monitor


def bump(lm, c, amp, sd):
    return amp * math.exp(-((lm - c) ** 2) / (2 * sd ** 2))


def days_of(now, n):
    return [now - timedelta(days=k) for k in range(n)]


def meals_at(now, n, hh, mm, carbs, prefix):
    return [Meal(f"{prefix}{k}", local(2026, 10, 21, hh, mm) - timedelta(days=k), "confirmed", carbs) for k in range(n)]


def doses_at(n, hh, mm, kind="bolus", prefix="d"):
    return [Insulin(f"{prefix}{k}", local(2026, 10, 21, hh, mm) - timedelta(days=k), kind, 4.0, True) for k in range(n)]


MORNING = local(2026, 10, 21, 9, 15)
EVENING = local(2026, 10, 21, 21, 15)
NIGHT = local(2026, 10, 21, 22, 30)

# A: dawn high ~06:30, dinner logged the evening before, nothing overnight
curveA = lambda lm: 108 + bump(lm, 6.5 * 60, 108, 70) + bump(lm, 20.5 * 60, 70, 50)
snapA = snapshot(MORNING, readings=cgm(8, MORNING, curve=curveA), meals=meals_at(MORNING, 8, 19, 30, 70, "dn") + meals_at(MORNING, 8, 8, 30, 40, "bk"),
                 insulin=doses_at(8, 19, 25, prefix="dn") + doses_at(8, 8, 28, prefix="bk"))
snapA.therapy = {"morning_resistance": True}

# B: breakfast at 08:30, dose logged 5 min after the start of the meal, big spike
curveB = lambda lm: 112 + bump(lm, 9.5 * 60, 112, 38) + bump(lm, 14 * 60, 25, 50)
snapB = snapshot(EVENING, readings=cgm(8, EVENING, curve=curveB), meals=meals_at(EVENING, 8, 8, 30, 55, "b"), insulin=doses_at(8, 8, 35, prefix="b"))

# C: lunch 13:00 with a dose, low 16:00-16:50 each day
curveC = lambda lm: (54 if 16 * 60 <= lm <= 16 * 60 + 50 else 120 + bump(lm, 14 * 60, 40, 60))
snapC = snapshot(EVENING, readings=cgm(8, EVENING, curve=curveC), meals=meals_at(EVENING, 8, 13, 0, 60, "l"), insulin=doses_at(8, 13, 0, prefix="l"))

# D: walk 17:00-17:30 daily, low 21:00-21:50 daily
curveD = lambda lm: (56 if 21 * 60 <= lm <= 21 * 60 + 50 else 125 + bump(lm, 12 * 60, 30, 60))
actsD = [Activity(local(2026, 10, 21, 17, 0) - timedelta(days=k), "walk", 30.0, "moderate") for k in range(8)]
snapD = snapshot(NIGHT, readings=cgm(8, NIGHT, curve=curveD), meals=meals_at(NIGHT, 8, 12, 30, 50, "m"), activities=actsD)

# E: glucose only
snapE = snapshot(EVENING, days=9)

SC = [("A morning: high ~06:30, nothing logged overnight, morning setting on", "morning", snapA), ("A again (same data, new sample)", "morning", snapA),
      ("B evening: big breakfast spike, dose after the meal started", "evening", snapB), ("C evening: low after the lunch dose", "evening", snapC),
      ("D night: low after the afternoon walk", "evening", snapD), ("E evening: glucose only", "evening", snapE)]

client = LlamaClient(LlmConfig(url=os.environ.get("INSIGHTS_LLM_URL", "http://127.0.0.1:8181"), timeout_s=420))
mon = Monitor(); mon.start()
client.explain([{"insight_id": "I1", "category": "x", "claims": ["Test [E1]."], "refs": ["E1"], "possible_explanations": [], "possible_next_steps": [], "boundaries": [], "limitations": []}])
rows = []
ONLY = os.environ.get("ONLY")
for name, kind, snap in SC:
    if ONLY and not name.startswith(ONLY):
        continue
    if mon.abort:
        print("ABORTED by monitor"); break
    r = run(kind, USER, snap.now, FakeSource(snap), InMemoryStore(), client, persist=False)
    s = r.stats
    row = {"scenario": name, "insights": s.get("insights"), "ai": sum(1 for i in r.insights if i["content"]["source"] == "ai"), "rules": sum(1 for i in r.insights if i["content"]["source"] == "rules"),
           "retries": s.get("retries", 0), "latency_s": s.get("llm_latency_s"), "ptok": s.get("prompt_tokens"), "ctok": s.get("completion_tokens"), "violations": s.get("violations"),
           "cards": [[i["category"], i["content"]["source"], i["content"]["paragraph"], i["content"]["explanations_used"], i["content"]["suggestions_used"]] for i in r.insights]}
    rows.append(row)
    print(f"\n=== {name}\n    insights={row['insights']} ai={row['ai']} rules={row['rules']} retries={row['retries']} latency={row['latency_s']}s ptok={row['ptok']} ctok={row['ctok']} violations={row['violations']}", flush=True)
    for rj in s.get("rejected", []):
        print("  REJECTED", rj["category"], rj["violations"], json.dumps(rj["text"]), flush=True)
    for cat, src, para, ex, su in row["cards"]:
        print(f"  [{cat} | {src}] ex={ex} steps={su}\n    {para}")
mon.stop_flag = True
time.sleep(1)
print("\nmonitor: samples", len(mon.samples), "max forecast ms", round(max(x["forecast_s"] for x in mon.samples) * 1000, 1), "non200", sum(1 for x in mon.samples if x["forecast_code"] != 200 or x["backend_code"] != 200), "aborted", mon.abort)
json.dump(rows, open("paragraphs.json", "w"), indent=1)
