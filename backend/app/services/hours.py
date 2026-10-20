"""Conservative subset of OSM opening_hours. Unsupported rules stay unknown."""

import re
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

DAYS = {day: i for i, day in enumerate(("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"))}


def availability(value: str | None, now: datetime | None = None) -> Literal["open", "closed", "unknown"]:
    if not value:
        return "unknown"
    if value.strip() == "24/7":
        return "open"
    now = now.astimezone(ZoneInfo("Asia/Almaty")) if now else datetime.now(ZoneInfo("Asia/Almaty"))
    schedule = {}
    for rule in value.split(";"):
        match = re.fullmatch(
            r"\s*((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)\s+(off|\d{2}:\d{2}-\d{2}:\d{2})\s*", rule
        )
        if not match:
            return "unknown"
        days, hours = match.groups()
        ends = days.split("-")
        start, end = DAYS[ends[0]], DAYS[ends[-1]]
        if start > end:  # Overnight and wraparound schedules intentionally unsupported.
            return "unknown"
        interval = None
        if hours != "off":
            a, b = hours.split("-")
            ah, am = map(int, a.split(":"))
            bh, bm = map(int, b.split(":"))
            if ah > 23 or bh > 24 or am > 59 or bm > 59 or (bh == 24 and bm != 0):
                return "unknown"
            begin, finish = ah * 60 + am, bh * 60 + bm
            if finish <= begin:
                return "unknown"
            interval = (begin, finish)
        for day in range(start, end + 1):
            if day in schedule:  # Overlapping/overriding rules are outside this subset.
                return "unknown"
            schedule[day] = interval
    interval = schedule.get(now.weekday())
    if interval and interval[0] <= now.hour * 60 + now.minute < interval[1]:
        return "open"
    return "closed"
