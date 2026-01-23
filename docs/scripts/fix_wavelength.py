#!/usr/bin/env python3
"""
gen-ray-cross-finite.jsのtraceRay呼び出しにwavelengthプロパティを追加
"""
import re

file_path = '../raytracing/generation/gen-ray-cross-finite.js'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# パターン1: dir: { x: ..., y: ..., z: ... } の後にwavelengthを追加
pattern1 = r'(dir: \{ x: [^}]+, y: [^}]+, z: [^}]+ \})\n(\s+)\};'
replacement1 = r'\1,\n\2wavelength: wavelength\n\2};'
content = re.sub(pattern1, replacement1, content)

# パターン2: pos/dir両方あるが wavelength がない
pattern2 = r'(\{\s*\n\s+pos: \{[^}]+\},\s*\n\s+dir: \{[^}]+\}\s*\n\s+)\},'
replacement2 = r'\1wavelength: wavelength\n            },'
content = re.sub(pattern2, replacement2, content)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("✅ Fixed wavelength properties in gen-ray-cross-finite.js")
