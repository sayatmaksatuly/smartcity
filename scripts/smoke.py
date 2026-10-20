"""Read-only local integration smoke scenarios against real imported OSM data."""

import argparse
import json

import httpx

BASE = "http://127.0.0.1:8000"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=BASE)
    args = parser.parse_args()
    with httpx.Client(base_url=args.base_url, timeout=35) as client:
        client.get("/api/health").raise_for_status()
        status = client.get("/api/data-status").raise_for_status().json()
        assert status["count"] > 0, "Import POIs first"
        mega = client.get("/api/pois", params={"q": "mega", "limit": 10}).raise_for_status().json()["items"]
        mega = next((poi for poi in mega if "silk" in poi["name"].lower()), None)
        assert mega, "Mega Silk Way missing from the current OSM import; choose a mapped starting place"
        scenarios = [
            ("A: Mega walk", {"lat": mega["lat"], "lon": mega["lon"]}, "Хочу погулять 30–60 минут", 60),
            ("B: coffee and relax", {"lat": 51.1282, "lon": 71.4305}, "Ищу тихое кафе с розетками, посидеть и отдохнуть", 60),
            ("C: sightseeing", {"lat": 51.1282, "lon": 71.4305}, "Хочу посмотреть необычные места", 120),
        ]
        report = {"dataset_count": status["count"], "ai_configured": status["ai_configured"], "scenarios": []}
        for title, position, query, duration in scenarios:
            data = (
                client.post(
                    "/api/recommendations", json={"position": position, "query": query, "duration_minutes": duration}
                )
                .raise_for_status()
                .json()
            )
            assert 1 <= len(data["recommendations"]) <= 3, "Current demo data has no matches; inspect the snapshot"
            assert len({r["poi"]["id"] for r in data["recommendations"]}) == len(data["recommendations"])
            for result in data["recommendations"]:
                assert result["total_minutes_estimate"] <= duration
                assert result["poi"]["source_url"].endswith(result["poi"]["id"])
                assert (
                    result["total_minutes_estimate"]
                    == result["visit_minutes_estimate"] + 2 * result["travel_minutes_estimate"]
                )
                assert "по прямой" in result["explanation"]
                if not result["poi"]["opening_hours"]:
                    assert result["availability"] == "unknown"
            if title.startswith("B"):
                assert all(r["poi"]["category"] == "cafe" for r in data["recommendations"])
                assert any("не подтверждены" in n for n in data["notices"])
            report["scenarios"].append(
                {
                    "scenario": title,
                    "mode": data["mode"],
                    "names": [r["poi"]["name"] for r in data["recommendations"]],
                    "unknown_hours": sum(r["availability"] == "unknown" for r in data["recommendations"]),
                    "total_minutes": [r["total_minutes_estimate"] for r in data["recommendations"]],
                }
            )
        confirmation = (
            client.post(
                "/api/recommendations",
                json={
                    "position": {"lat": 51.1282, "lon": 71.4305},
                    "query": "Я возле Mega Silk Way, у меня 40 минут",
                    "duration_minutes": 60,
                },
            )
            .raise_for_status()
            .json()
        )
        assert confirmation["origin_suggestions"] and confirmation["suggested_duration_minutes"] == 40
        assert confirmation["applied_duration_minutes"] == 60
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
