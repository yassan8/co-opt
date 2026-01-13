#!/usr/bin/env python3
"""
Parse ZEMAX AGF glass catalog file and convert to JavaScript format
AGF format: NM line contains glass name and basic properties
CD line contains Sellmeier coefficients
"""

import re
import sys

def parse_agf_file(filename):
    """Parse AGF file and extract glass data"""
    glasses = []
    current_glass = None
    
    with open(filename, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            
            # NM line: glass name and basic properties
            # Format: NM <name> <formula> <MIL> <nd> <vd> <TCE> <density> <CR>
            if line.startswith('NM '):
                parts = line.split()
                if len(parts) >= 5:
                    if current_glass and 'sellmeier' in current_glass:
                        glasses.append(current_glass)
                    
                    name = parts[1]
                    nd = float(parts[4])
                    vd = float(parts[5])
                    
                    current_glass = {
                        'name': name,
                        'nd': nd,
                        'vd': vd,
                        'sellmeier': {}
                    }
            
            # CD line: Sellmeier coefficients
            # Format: CD <K1> <L1> <K2> <L2> <K3> <L3> ...
            # AGF format uses pairs: K1, L1, K2, L2, K3, L3
            # We want: A1, B1, A2, B2, A3, B3 where A=K and B=L
            elif line.startswith('CD ') and current_glass:
                parts = line.split()[1:]  # Skip 'CD'
                try:
                    # Parse coefficients - they come in pairs K, L
                    coeffs = [float(p) for p in parts if p]
                    
                    if len(coeffs) >= 6:
                        # AGF: K1 L1 K2 L2 K3 L3
                        # Map to: A1 B1 A2 B2 A3 B3
                        current_glass['sellmeier'] = {
                            'A1': coeffs[0],  # K1
                            'B1': coeffs[1],  # L1
                            'A2': coeffs[2],  # K2
                            'B2': coeffs[3],  # L2
                            'A3': coeffs[4],  # K3
                            'B3': coeffs[5]   # L3
                        }
                except (ValueError, IndexError) as e:
                    print(f"Warning: Could not parse CD line for {current_glass.get('name', 'unknown')}: {e}", file=sys.stderr)
    
    # Don't forget the last glass
    if current_glass and 'sellmeier' in current_glass:
        glasses.append(current_glass)
    
    return glasses

def format_as_javascript(glasses, var_name):
    """Format glass data as JavaScript array"""
    js_code = f"export const {var_name} = [\n"
    
    for glass in glasses:
        js_code += "  {\n"
        js_code += f'    "name": "{glass["name"]}",\n'
        js_code += f'    "nd": {glass["nd"]},\n'
        js_code += f'    "vd": {glass["vd"]},\n'
        js_code += '    "sellmeier": {\n'
        js_code += f'      "A1": {glass["sellmeier"]["A1"]},\n'
        js_code += f'      "A2": {glass["sellmeier"]["A2"]},\n'
        js_code += f'      "A3": {glass["sellmeier"]["A3"]},\n'
        js_code += f'      "B1": {glass["sellmeier"]["B1"]},\n'
        js_code += f'      "B2": {glass["sellmeier"]["B2"]},\n'
        js_code += f'      "B3": {glass["sellmeier"]["B3"]}\n'
        js_code += "    }\n"
        js_code += "  },\n"
    
    js_code += "];\n"
    return js_code

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: parse_agf_to_js.py <agf_file> <var_name>")
        sys.exit(1)
    
    agf_file = sys.argv[1]
    var_name = sys.argv[2]
    
    glasses = parse_agf_file(agf_file)
    print(f"// Parsed {len(glasses)} glasses from {agf_file}")
    print(format_as_javascript(glasses, var_name))
