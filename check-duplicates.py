#!/usr/bin/env python3
"""
Check for duplicate "manufacturer" fields in glass.js
"""

import re
import sys

with open('data/glass.js', 'r') as f:
    content = f.read()

# Pattern to match glass objects
glass_pattern = r'\{\s*\n\s*"name":\s*"([^"]+)"[^}]*?\}'

duplicates_found = 0
total_glasses = 0

for match in re.finditer(glass_pattern, content, re.DOTALL):
    total_glasses += 1
    glass_obj = match.group(0)
    glass_name = match.group(1)
    
    # Count manufacturer fields in this object
    manufacturer_count = len(re.findall(r'"manufacturer":', glass_obj))
    
    if manufacturer_count > 1:
        duplicates_found += 1
        # Get line number
        line_num = content[:match.start()].count('\n') + 1
        print(f"DUPLICATE: Glass \"{glass_name}\" has {manufacturer_count} manufacturer fields (line {line_num})")

print(f"\n{'='*60}")
print(f"Total glasses checked: {total_glasses}")
print(f"Glasses with duplicate manufacturer fields: {duplicates_found}")

if duplicates_found == 0:
    print("✅ No duplicate manufacturer fields found!")
    sys.exit(0)
else:
    print(f"⚠️ Found {duplicates_found} glasses with duplicate manufacturer fields")
    sys.exit(1)
