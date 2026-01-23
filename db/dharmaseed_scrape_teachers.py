#!/usr/bin/env python3
"""
Dharmaseed API Client

Fetches data from the public Dharmaseed API.
Available endpoints:
  - https://dharmaseed.org/api/1/teachers/
  - https://dharmaseed.org/api/1/talks/
  - https://dharmaseed.org/api/1/retreats/
  - https://dharmaseed.org/api/1/venues/

Each endpoint returns {"edition": "...", "items": [id1, id2, ...]}.
To get details for a specific item, append the ID: /api/1/teachers/96/
"""

import json
import time
import os
from dataclasses import dataclass, asdict
from typing import List, Optional, Dict, Any
import requests

# Get the directory where this script is located
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

BASE = "https://dharmaseed.org"
API_BASE = f"{BASE}/api/1"
MEDIA_BASE = "https://media.dharmaseed.org"

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; dharmaseed-api-client/2.0)"
})

# API Endpoints
ENDPOINTS = {
    "teachers": f"{API_BASE}/teachers/",
    "talks": f"{API_BASE}/talks/",
    "retreats": f"{API_BASE}/retreats/",
    "venues": f"{API_BASE}/venues/",
}


@dataclass
class Teacher:
    id: int
    name: str
    url: str
    photo_url: str = ""
    bio: str = ""
    donation_url: str = ""
    talk_count: int = 0
    last_talk_date: str = ""  # ISO format date of most recent talk


@dataclass
class Talk:
    id: int
    title: str
    url: str
    teacher_id: int
    teacher_name: str = ""
    date: str = ""
    duration: int = 0
    description: str = ""
    retreat_id: Optional[int] = None
    venue_id: Optional[int] = None


@dataclass
class Retreat:
    id: int
    title: str
    url: str
    description: str = ""
    start_date: str = ""
    end_date: str = ""
    venue_id: Optional[int] = None


@dataclass
class Venue:
    id: int
    name: str
    url: str
    city: str = ""
    state: str = ""
    country: str = ""
    website: str = ""


def build_photo_url(teacher_id: int, photo_field: str) -> str:
    """
    Build teacher photo URL from API photo field.
    If photo field is non-empty (e.g. "photo.png"), construct the full URL.
    The extension can be changed and maxH/maxW params can be used.
    """
    if photo_field:
        return f"{MEDIA_BASE}/uploads/photos/teacher_{teacher_id}_125_0.{photo_field.split('.')[-1]}"
    return ""


def fetch_item_ids(endpoint: str) -> List[int]:
    """
    Fetch all item IDs from an API endpoint.
    Returns the list of IDs from the 'items' field.
    """
    url = ENDPOINTS.get(endpoint, endpoint)
    r = SESSION.get(url, timeout=30)
    r.raise_for_status()
    data = r.json()
    return data.get("items", [])


def fetch_item_details(endpoint: str, item_id: int, max_retries: int = 5) -> Optional[Dict[str, Any]]:
    """
    Fetch details for a specific item by ID.
    Example: /api/1/teachers/96/
    Includes retry logic with exponential backoff for rate limiting.
    """
    base_url = ENDPOINTS.get(endpoint, endpoint).rstrip("/")
    url = f"{base_url}/{item_id}/"
    
    for attempt in range(max_retries):
        try:
            r = SESSION.get(url, timeout=30)
            if r.status_code == 429:
                # Rate limited - wait longer and retry
                wait_time = (attempt + 1) * 5  # 5, 10, 15, 20, 25 seconds
                print(f"  Rate limited, waiting {wait_time}s...")
                time.sleep(wait_time)
                continue
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            if attempt == max_retries - 1:
                print(f"  Warning: Failed to fetch {endpoint}/{item_id}: {e}")
            else:
                time.sleep(2)
    return None


def fetch_all_items(endpoint: str, limit: Optional[int] = None, 
                    delay_s: float = 0.3) -> List[Dict[str, Any]]:
    """
    Fetch all items from an endpoint with their full details.
    Uses sequential requests with rate limiting to avoid 429 errors.
    """
    ids = fetch_item_ids(endpoint)
    if limit:
        ids = ids[:limit]
    
    print(f"Fetching {len(ids)} {endpoint}...")
    items = []
    
    for i, item_id in enumerate(ids):
        result = fetch_item_details(endpoint, item_id)
        if result:
            items.append(result)
        
        if (i + 1) % 50 == 0:
            print(f"  Progress: {i + 1}/{len(ids)}")
        
        time.sleep(delay_s)
    
    print(f"  Completed: {len(items)}/{len(ids)} fetched successfully")
    return items


def parse_teacher(data: Dict[str, Any], talk_count: int = 0, last_talk_date: str = "") -> Teacher:
    """Parse API response into Teacher object."""
    tid = data.get("id", 0)
    photo_field = data.get("photo", "")
    return Teacher(
        id=tid,
        name=data.get("name", ""),
        url=f"{BASE}/teacher/{tid}/",
        photo_url=build_photo_url(tid, photo_field),
        bio=data.get("bio", ""),
        donation_url=data.get("donation_url", ""),
        talk_count=talk_count,
        last_talk_date=last_talk_date,
    )


def parse_talk(data: Dict[str, Any]) -> Talk:
    """Parse API response into Talk object."""
    tid = data.get("id", 0)
    return Talk(
        id=tid,
        title=data.get("title", ""),
        url=f"{BASE}/talk/{tid}/",
        teacher_id=data.get("teacher_id", 0),
        teacher_name=data.get("teacher_name", ""),
        date=data.get("date", ""),
        duration=data.get("duration_in_seconds", 0),
        description=data.get("description", ""),
        retreat_id=data.get("retreat_id"),
        venue_id=data.get("venue_id"),
    )


def parse_retreat(data: Dict[str, Any]) -> Retreat:
    """Parse API response into Retreat object."""
    rid = data.get("id", 0)
    return Retreat(
        id=rid,
        title=data.get("title", ""),
        url=f"{BASE}/retreat/{rid}/",
        description=data.get("description", ""),
        start_date=data.get("start_date", ""),
        end_date=data.get("end_date", ""),
        venue_id=data.get("venue_id"),
    )


def parse_venue(data: Dict[str, Any]) -> Venue:
    """Parse API response into Venue object."""
    vid = data.get("id", 0)
    return Venue(
        id=vid,
        name=data.get("name", ""),
        url=f"{BASE}/venue/{vid}/",
        city=data.get("city", ""),
        state=data.get("state", ""),
        country=data.get("country", ""),
        website=data.get("website", ""),
    )


def parse_rss_date(date_str: str) -> str:
    """
    Parse RSS pubDate (RFC 2822) to ISO format (YYYY-MM-DD).
    Example: 'Sun, 27 Oct 2019 11:30:00 +0000' -> '2019-10-27'
    """
    import re
    from email.utils import parsedate_to_datetime
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.strftime('%Y-%m-%d')
    except Exception:
        # Fallback: extract date parts with regex
        match = re.search(r'(\d{1,2})\s+(\w{3})\s+(\d{4})', date_str)
        if match:
            day, month, year = match.groups()
            months = {'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
                      'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'}
            return f"{year}-{months.get(month, '01')}-{day.zfill(2)}"
        return ""


def count_talks_from_rss(teacher_id: int, max_retries: int = 3) -> tuple[int, str]:
    """
    Count talks for a teacher by fetching their RSS feed.
    The RSS feed includes all talks (including private ones with access keys).
    Returns (talk_count, last_talk_date) where last_talk_date is ISO format.
    """
    import re
    url = f"{BASE}/feeds/teacher/{teacher_id}/?max-entries=all"
    
    for attempt in range(max_retries):
        try:
            r = SESSION.get(url, timeout=30)
            if r.status_code == 429:
                wait_time = (attempt + 1) * 5
                print(f"  Rate limited, waiting {wait_time}s...")
                time.sleep(wait_time)
                continue
            if r.status_code == 404:
                return (0, "")
            r.raise_for_status()
            
            content = r.text
            
            # Count <item> elements in RSS feed
            count = content.count('<item>')
            
            # Extract first pubDate inside an <item> (most recent talk)
            # Use regex with DOTALL to match across newlines
            last_talk_date = ""
            pub_match = re.search(r'<item>.*?<pubDate>([^<]+)</pubDate>', content, re.DOTALL)
            if pub_match:
                last_talk_date = parse_rss_date(pub_match.group(1))
            
            return (count, last_talk_date)
            
        except requests.RequestException as e:
            if attempt == max_retries - 1:
                print(f"  Warning: Failed to fetch RSS for teacher {teacher_id}: {e}")
            else:
                time.sleep(2)
    return (0, "")


def count_talks_per_teacher(teacher_ids: List[int], save_to_file: bool = True) -> Dict[int, dict]:
    """
    Count talks per teacher by fetching their RSS feeds.
    This is more accurate than the API which doesn't include all talks.
    Returns dict with {teacher_id: {"count": N, "last_talk_date": "YYYY-MM-DD"}}.
    """
    print(f"Counting talks via RSS feeds for {len(teacher_ids)} teachers...")
    
    results: Dict[int, dict] = {}
    total_talks = 0
    
    for i, teacher_id in enumerate(teacher_ids):
        count, last_talk_date = count_talks_from_rss(teacher_id)
        if count > 0:
            results[teacher_id] = {"count": count, "last_talk_date": last_talk_date}
            total_talks += count
        
        if (i + 1) % 50 == 0:
            print(f"  Progress: {i + 1}/{len(teacher_ids)} teachers, {total_talks} talks found")
        
        time.sleep(0.1)
    
    print(f"  Done: {total_talks} talks for {len(results)} teachers")
    
    if save_to_file:
        talk_counts_data = {
            "source": BASE,
            "method": "RSS feeds",
            "total_talks": total_talks,
            "talk_counts": results
        }
        with open("dharmaseed_talk_counts.json", "w", encoding="utf-8") as f:
            json.dump(talk_counts_data, f, ensure_ascii=False, indent=2)
        print(f"OK: talk counts saved to dharmaseed_talk_counts.json")
    
    return results


def load_talk_counts() -> Dict[int, int]:
    """Load talk counts from cached JSON file."""
    try:
        with open("dharmaseed_talk_counts.json", "r", encoding="utf-8") as f:
            data = json.load(f)
            # Convert string keys back to int (JSON keys are always strings)
            return {int(k): v for k, v in data.get("talk_counts", {}).items()}
    except FileNotFoundError:
        print("  No cached talk counts found, will fetch fresh data")
        return {}


def fetch_teachers(limit: Optional[int] = None, talk_counts: Optional[Dict[int, int]] = None) -> List[Teacher]:
    """Fetch all teachers from the API."""
    items = fetch_all_items("teachers", limit=limit)
    if talk_counts is None:
        talk_counts = {}
    teachers = [parse_teacher(item, talk_counts.get(item.get("id", 0), 0)) for item in items]
    teachers.sort(key=lambda t: (t.name.lower(), t.id))
    return teachers


def fetch_teachers_with_counts(limit: Optional[int] = None) -> List[Teacher]:
    """
    Fetch all teachers with talk counts and last talk date in a single pass.
    For each teacher: fetch API details + count talks from RSS feed.
    This is faster than separate passes since RSS counting is quick.
    """
    teacher_ids = fetch_item_ids("teachers")
    if limit:
        teacher_ids = teacher_ids[:limit]
    
    print(f"Fetching {len(teacher_ids)} teachers with talk counts (single pass)...")
    teachers = []
    total_talks = 0
    
    for i, teacher_id in enumerate(teacher_ids):
        # Fetch teacher details from API
        data = fetch_item_details("teachers", teacher_id)
        if not data:
            continue
        
        # Count talks and get last talk date from RSS feed
        talk_count, last_talk_date = count_talks_from_rss(teacher_id)
        total_talks += talk_count
        
        # Parse and add teacher
        teacher = parse_teacher(data, talk_count, last_talk_date)
        teachers.append(teacher)
        
        if (i + 1) % 50 == 0:
            print(f"  Progress: {i + 1}/{len(teacher_ids)} teachers, {total_talks} talks")
        
        time.sleep(0.1)  # Rate limiting
    
    print(f"  Done: {len(teachers)} teachers, {total_talks} total talks")
    teachers.sort(key=lambda t: (t.name.lower(), t.id))
    return teachers


def fetch_talks(limit: Optional[int] = None) -> List[Talk]:
    """Fetch talks from the API (can be slow - many talks!)."""
    items = fetch_all_items("talks", limit=limit)
    talks = [parse_talk(item) for item in items]
    talks.sort(key=lambda t: (t.date, t.id), reverse=True)
    return talks


def fetch_retreats(limit: Optional[int] = None) -> List[Retreat]:
    """Fetch all retreats from the API."""
    items = fetch_all_items("retreats", limit=limit)
    retreats = [parse_retreat(item) for item in items]
    retreats.sort(key=lambda r: (r.start_date, r.id), reverse=True)
    return retreats


def fetch_venues(limit: Optional[int] = None) -> List[Venue]:
    """Fetch all venues from the API."""
    items = fetch_all_items("venues", limit=limit)
    venues = [parse_venue(item) for item in items]
    venues.sort(key=lambda v: (v.name.lower(), v.id))
    return venues


def save_to_json(data: List, filename: str, source_type: str):
    """Save data to JSON file."""
    db = {
        "source": BASE,
        "api": ENDPOINTS.get(source_type, ""),
        source_type: [asdict(item) for item in data]
    }
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
    print(f"OK: {len(data)} {source_type} -> {filename}")


def main():
    """
    Main entry point - fetches teachers with talk counts in a single pass.
    """
    import sys
    
    # Check command line args
    if len(sys.argv) > 1:
        if sys.argv[1] == "--counts-only":
            # Only update talk counts - need teacher IDs first
            print("Updating talk counts only...")
            print("Fetching teacher IDs...")
            teacher_ids = fetch_item_ids("teachers")
            print(f"  Found {len(teacher_ids)} teachers")
            count_talks_per_teacher(teacher_ids, save_to_file=True)
            return
        elif sys.argv[1] == "--teachers-only":
            # Only update teachers using cached counts
            print("Updating teachers only (using cached talk counts)...")
            talk_counts = load_talk_counts()
            teachers = fetch_teachers(talk_counts=talk_counts)
            output_file = os.path.join(SCRIPT_DIR, "dharmaseed_teachers.json")
            save_to_json(teachers, output_file, "teachers")
            return
    
    # Default: single pass - fetch teachers + count talks together
    teachers = fetch_teachers_with_counts()
    output_file = os.path.join(SCRIPT_DIR, "dharmaseed_teachers.json")
    save_to_json(teachers, output_file, "teachers")
    
    # Example: find Joseph Goldstein
    jg = [t for t in teachers if "joseph goldstein" in t.name.lower()]
    if jg:
        print(f"Example: {jg[0]}")


if __name__ == "__main__":
    main()
