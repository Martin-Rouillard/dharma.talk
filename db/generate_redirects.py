#!/usr/bin/env python3
"""
Generate Netlify _redirects file from teachers JSON.
Creates vanity URLs like /jamesbaraz -> /#teacher/86
"""

import json
import re
import os

def slugify(name: str) -> str:
    """Convert teacher name to URL slug."""
    # Remove special characters, lowercase, replace spaces with nothing
    slug = name.lower()
    slug = re.sub(r'[^a-z0-9\s]', '', slug)  # Keep only alphanumeric and spaces
    slug = re.sub(r'\s+', '', slug)  # Remove all spaces
    return slug

def generate_redirects():
    # Get the directory where this script is located
    script_dir = os.path.dirname(os.path.abspath(__file__))
    json_path = os.path.join(script_dir, 'dharmaseed_teachers.json')
    
    # Output to parent directory (project root)
    redirects_path = os.path.join(script_dir, '..', '_redirects')
    
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    teachers = data.get('teachers', [])
    
    # Track used slugs to handle duplicates
    used_slugs = {}
    redirects = []
    
    for t in teachers:
        if t.get('talk_count', 0) == 0:
            continue  # Skip teachers with no talks
            
        name = t.get('name', '')
        tid = t.get('id')
        
        if not name or not tid:
            continue
        
        slug = slugify(name)
        
        if not slug:
            continue
        
        # Handle duplicates by appending ID
        if slug in used_slugs:
            slug = f"{slug}{tid}"
        
        used_slugs[slug] = tid
        
        # Redirect to hash-based URL (SPA style)
        redirects.append(f"/{slug}  /#teacher/{tid}  302")
    
    # Sort alphabetically
    redirects.sort()
    
    # Write _redirects file
    with open(redirects_path, 'w', encoding='utf-8') as f:
        f.write("# Teacher vanity URLs - auto-generated\n")
        f.write("# Format: /slug -> /#teacher/id\n\n")
        for redirect in redirects:
            f.write(redirect + '\n')
    
    print(f"Generated {len(redirects)} redirects -> {redirects_path}")
    
    # Show some examples
    print("\nExamples:")
    for r in redirects[:5]:
        print(f"  {r}")

if __name__ == "__main__":
    generate_redirects()
