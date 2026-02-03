#!/usr/bin/env python3
import re
import sys

files_to_clean = [
    'ui/event-handlers.js',
    'docs/ui/event-handlers.js'
]

# Emoji patterns to remove
emojis = ['🎨', '🔍', '🔸', '✨', '🔵', '🔷', '⭕', '🟢', '🔗', '🎯', 
          '📷', '📏', '💾', '📨', '🖌️', '🧹', '🌟', '📋', '📊', '📐', 
          '🔄', '📦', '✅', '🔺', '🌈', '🎬', '🪞', '📍', '⏭️', '⚠️', '❌', '🔧']

total_removed = 0

for file_path in files_to_clean:
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        new_lines = []
        i = 0
        removed = 0
        
        while i < len(lines):
            line = lines[i]
            
            # Check if line contains console.log/debugLog with emoji
            has_emoji = any(emoji in line for emoji in emojis)
            is_log = 'console.log(' in line or 'console.warn(' in line or 'console.error(' in line or 'debugLog(' in line
            
            if is_log and has_emoji:
                # Skip this log line
                removed += 1
                
                # Check if multiline (unbalanced parentheses)
                open_count = line.count('(')
                close_count = line.count(')')
                
                if open_count > close_count:
                    # Multiline log - continue skipping until balanced
                    i += 1
                    while i < len(lines):
                        close_count += lines[i].count(')')
                        if close_count >= open_count:
                            break
                        i += 1
                
                i += 1
                continue
            
            new_lines.append(line)
            i += 1
        
        # Write back
        with open(file_path, 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
        
        print(f"✓ {file_path}: Removed {removed} log statements")
        total_removed += removed
        
    except FileNotFoundError:
        print(f"⚠ {file_path}: File not found, skipping")
    except Exception as e:
        print(f"✗ {file_path}: Error - {e}")

print(f"\n✅ Total: Removed {total_removed} log statements")
sys.exit(0)
