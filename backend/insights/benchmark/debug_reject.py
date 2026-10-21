"""Shows exactly what the model wrote for the candidates the validator rejects, and why. SYNTHETIC DATA ONLY; one request at a time."""
import json
import os

from sugarsense_insights.config import LlmConfig
from sugarsense_insights.llm import LlamaClient, candidate_payload
from sugarsense_insights.models import Meal
from sugarsense_insights.pipeline import build_candidates
from sugarsense_insights.quality import assess, clean_readings
from sugarsense_insights.validate import parse_reply, validate_item

from helpers import local, snapshot
from run_benchmark import EVENING

snap = snapshot(EVENING, days=9, meals=[Meal(f"m{k}", local(2026, 10, 21 - k, 8, 30), "confirmed", 50.0) for k in range(5)])
clean, flags = clean_readings(snap.readings, snap.now, snap.settings.th)
av = assess(snap, clean, flags)
cands, _ = build_candidates("evening", snap, clean, flags, av)
ctx = [c for c in cands if c.category == "episode_context"]
client = LlamaClient(LlmConfig(url=os.environ.get("INSIGHTS_LLM_URL", "http://127.0.0.1:8181"), timeout_s=420))
for n, c in enumerate(ctx, 1):
    reply = client.explain([candidate_payload(c, "I1")])
    items, pv = parse_reply(reply.text)
    it = items[0] if items else None
    v = validate_item(it, c, "I1", av, []) if it else pv
    print(f"\n--- episode_context #{n} ({reply.latency_s:.0f}s)")
    print("CLAIM :", c.claims[0])
    print("LIMITS:", c.limitations)
    print("MODEL :", it and it["explanation"], "| limitation:", it and it["limitation"], "| refs:", it and it["evidence_refs"])
    print("VIOLATIONS:", [(x.code, x.detail) for x in v])
