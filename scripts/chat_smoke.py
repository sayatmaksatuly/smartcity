"""Read-only chat smoke against imported OSM data; exactly two recommendation turns."""

import argparse
import json

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--require-gemini", action="store_true")
    args = parser.parse_args()
    with httpx.Client(base_url=args.base_url, timeout=35) as client:
        status = client.get("/api/data-status").raise_for_status().json()
        assert status["count"] > 0, "Import real POIs first"
        if args.require_gemini:
            assert status["ai_configured"], "Server key is not configured"

        def chat(**body):
            response = client.post("/api/chat", json=body)
            assert response.status_code == 200, "Chat HTTP check failed"
            return response.json()

        first = chat(message="Хочу погулять в Астане, у меня два часа")
        assert first["action"] == "clarify_origin" and first["recommendation_response"] is None
        assert first["context"]["preferences"]["duration_minutes"] == 120
        proposal = chat(message="Возле Байтерека", context=first["context"])
        assert proposal["action"] == "confirm_origin" and proposal["position"] is None
        assert proposal["origin_suggestions"], "Current OSM snapshot has no matching named origin"
        poi = proposal["origin_suggestions"][0]
        confirmed = chat(action="confirm_origin", confirm_origin_id=poi["id"], context=proposal["context"])
        assert confirmed["position"] == {"lat": poi["lat"], "lon": poi["lon"]}
        refined = chat(
            message="Хочу красивые места, но без кафе. Теперь только 30 минут, можно поближе?",
            position=confirmed["position"],
            context=confirmed["context"],
        )
        assert refined["position"] == confirmed["position"]
        preferences = refined["context"]["preferences"]
        assert preferences["duration_minutes"] == 30
        assert "cafe" in preferences["excluded_categories"] and preferences["prefer_nearby"]
        summaries = []
        for turn, budget in ((confirmed, 120), (refined, 30)):
            result = turn["recommendation_response"]
            assert result is not None and 1 <= len(result["recommendations"]) <= 3
            items = result["recommendations"]
            assert len({r["poi"]["id"] for r in items}) == len(items)
            assert all(r["total_minutes_estimate"] <= budget for r in items)
            assert all(r["poi"]["source_url"].endswith(r["poi"]["id"]) for r in items)
            if args.require_gemini:
                assert result["mode"] == "gemini" and result["fallback_reason"] is None
            summaries.append(
                {"mode": result["mode"], "fallback_reason": result["fallback_reason"], "count": len(items)}
            )
        assert all(r["poi"]["category"] != "cafe" for r in refined["recommendation_response"]["recommendations"])
        # Only aggregate checks: never print request text, coordinates, keys or model output.
        print(json.dumps({"turns": summaries, "origin_confirmed": True, "constraints_preserved": True}))


if __name__ == "__main__":
    main()
