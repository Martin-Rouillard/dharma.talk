#!/usr/bin/env python3
"""
Dharmaseed Talks Scraper

Fetches talk data from the public Dharmaseed API.
Endpoint: https://dharmaseed.org/api/1/talks/
Individual talk: https://dharmaseed.org/api/1/talks/ID/

Supports incremental updates - will skip talks already in the JSON file.
"""

import json
import time
import os
from dataclasses import dataclass, asdict
from typing import List, Optional, Dict, Any, Set
import requests

BASE = "https://dharmaseed.org"
API_BASE = f"{BASE}/api/1"
MEDIA_BASE = "https://media.dharmaseed.org"

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; dharmaseed-api-client/2.0)"
})

TALKS_ENDPOINT = f"{API_BASE}/talks/"


@dataclass
class Talk:
    id: int
    title: str
    teacher_id: int
    description: str = ""
    rec_date: str = ""
    duration_in_minutes: float = 0
    venue_id: Optional[int] = None
    retreat_id: Optional[int] = None
    language_id: int = 1
    recording_type: str = ""
    audio_url: str = ""


def load_existing_talks(filename: str) -> tuple[List[Dict], Set[int]]:
    """
    Load existing talks from JSON file.
    Returns (list of talk dicts, set of existing IDs)
    """
    if not os.path.exists(filename):
        return [], set()
    
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            talks = json.load(f)
            existing_ids = {t['id'] for t in talks}
            return talks, existing_ids
    except (json.JSONDecodeError, KeyError) as e:
        print(f"  Warning: Could not load existing file: {e}")
        return [], set()


def fetch_talk_ids() -> List[int]:
    """
    Fetch all talk IDs from the API endpoint.
    Returns the list of IDs from the 'items' field.
    """
    print(f"Fetching talk IDs from {TALKS_ENDPOINT}...")
    r = SESSION.get(TALKS_ENDPOINT, timeout=30)
    r.raise_for_status()
    data = r.json()
    ids = data.get("items", [])
    print(f"  Found {len(ids)} talk IDs")
    return ids


def fetch_talk_details(talk_id: int, max_retries: int = 5) -> Optional[Dict[str, Any]]:
    """
    Fetch details for a specific talk by ID.
    Example: /api/1/talks/12345/
    Includes retry logic with exponential backoff for rate limiting.
    """
    url = f"{TALKS_ENDPOINT}{talk_id}/"
    
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
                print(f"  Warning: Failed to fetch talk {talk_id}: {e}")
            else:
                time.sleep(2)
    return None


def parse_talk(data: Dict[str, Any]) -> Talk:
    """Parse API response into Talk object."""
    tid = data.get("id", 0)
    
    # Build full audio URL if available
    # The API returns a path like /talks/94913/filename.mp3
    # The correct URL format is https://dharmaseed.org/talks/ID/filename.mp3
    # which redirects to the cached audio file
    audio_url = ""
    if data.get("audio_url"):
        audio_url = f"{BASE}{data['audio_url']}"
    
    return Talk(
        id=tid,
        title=data.get("title", ""),
        teacher_id=data.get("teacher_id", 0),
        description=data.get("description", ""),
        rec_date=data.get("rec_date", ""),
        duration_in_minutes=data.get("duration_in_minutes", 0),
        venue_id=data.get("venue_id"),
        retreat_id=data.get("retreat_id"),
        language_id=data.get("language_id", 1),
        recording_type=data.get("recording_type", ""),
        audio_url=audio_url,
    )


def fetch_talks_incremental(
    filename: str,
    limit: int = 100,
    delay_s: float = 0.3,
    save_interval: int = 100
) -> List[Dict]:
    """
    Fetch talks incrementally, skipping already fetched ones.
    Saves progress periodically to avoid losing work.
    
    Args:
        filename: JSON file to read from and save to
        limit: Maximum number of NEW talks to fetch (default 100)
        delay_s: Delay between requests in seconds (default 0.3)
        save_interval: Save progress every N new talks (default 100)
    
    Returns:
        List of all talk dicts (existing + new)
    """
    # Load existing talks
    existing_talks, existing_ids = load_existing_talks(filename)
    print(f"Loaded {len(existing_talks)} existing talks")
    
    # Fetch all talk IDs
    all_ids = fetch_talk_ids()
    
    # Filter to only new IDs
    new_ids = [tid for tid in all_ids if tid not in existing_ids]
    print(f"  {len(new_ids)} new talks to fetch")
    
    # Limit new talks to fetch
    if limit and limit < len(new_ids):
        new_ids = new_ids[:limit]
        print(f"  Limiting to {limit} new talks")
    
    if not new_ids:
        print("No new talks to fetch!")
        return existing_talks
    
    print(f"Fetching details for {len(new_ids)} new talks...")
    new_talks = []
    failed_count = 0
    
    for i, talk_id in enumerate(new_ids):
        result = fetch_talk_details(talk_id)
        if result:
            talk = parse_talk(result)
            new_talks.append(asdict(talk))
        else:
            failed_count += 1
        
        # Progress update every 10 talks
        if (i + 1) % 10 == 0:
            print(f"  Progress: {i + 1}/{len(new_ids)} (total: {len(existing_talks) + len(new_talks)})")
        
        # Save periodically
        if (i + 1) % save_interval == 0:
            all_talks = existing_talks + new_talks
            # Sort by ID descending (newest first)
            all_talks.sort(key=lambda t: t['id'], reverse=True)
            save_talks_to_json(all_talks, filename)
            print(f"  [Checkpoint] Saved {len(all_talks)} talks")
        
        time.sleep(delay_s)
    
    print(f"  Completed: {len(new_talks)}/{len(new_ids)} fetched successfully")
    if failed_count:
        print(f"  Failed: {failed_count} talks")
    
    # Combine existing and new talks
    all_talks = existing_talks + new_talks
    
    # Sort by ID descending (newest first)
    all_talks.sort(key=lambda t: t['id'], reverse=True)
    
    return all_talks


def save_talks_to_json(talks: List[Dict], filename: str = "dharmaseed_talks.json"):
    """Save talks list to JSON file."""
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(talks, f, indent=2, ensure_ascii=False)
    
    print(f"Saved {len(talks)} talks to {filename}")


def main():
    """Main entry point."""
    import argparse
    
    # Get the directory where this script is located
    script_dir = os.path.dirname(os.path.abspath(__file__))
    default_output = os.path.join(script_dir, "dharmaseed_talks.json")
    
    parser = argparse.ArgumentParser(description="Scrape Dharmaseed talks (incremental)")
    parser.add_argument(
        "--limit", "-l",
        type=int,
        default=100,
        help="Maximum number of NEW talks to fetch (default: 100, use 0 for all)"
    )
    parser.add_argument(
        "--delay", "-d",
        type=float,
        default=0.3,
        help="Delay between requests in seconds (default: 0.3)"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        default=default_output,
        help=f"Output JSON file (default: {default_output})"
    )
    parser.add_argument(
        "--save-interval", "-s",
        type=int,
        default=100,
        help="Save progress every N talks (default: 100)"
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Start fresh, ignoring existing file"
    )
    
    args = parser.parse_args()
    
    # Handle fresh start
    if args.fresh and os.path.exists(args.output):
        os.remove(args.output)
        print(f"Removed existing {args.output} for fresh start")
    
    # Use 0 to mean "no limit"
    limit = args.limit if args.limit > 0 else None
    
    print(f"Dharmaseed Talks Scraper (Incremental)")
    print(f"======================================")
    print(f"Limit: {args.limit if args.limit > 0 else 'unlimited'} new talks")
    print(f"Delay: {args.delay}s between requests")
    print(f"Output: {args.output}")
    print(f"Save interval: every {args.save_interval} talks")
    print()
    
    # Fetch talks incrementally
    talks = fetch_talks_incremental(
        filename=args.output,
        limit=limit,
        delay_s=args.delay,
        save_interval=args.save_interval
    )
    
    # Final save
    save_talks_to_json(talks, args.output)
    
    # Print summary
    print()
    print(f"Summary:")
    print(f"  Total talks in file: {len(talks)}")
    if talks:
        dates = [t['rec_date'] for t in talks if t.get('rec_date')]
        if dates:
            print(f"  Date range: {min(dates)} to {max(dates)}")
        unique_teachers = len(set(t['teacher_id'] for t in talks))
        print(f"  Unique teachers: {unique_teachers}")


if __name__ == "__main__":
    main()
