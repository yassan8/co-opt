import json

# ---------------------------------------------------------
# 1. 実施例1 (Example 1) レンズデータ定義
# ---------------------------------------------------------
# r: 曲率半径, d: 面間隔, nd: 屈折率, vd: アッベ数
# semi_dia: 有効半径 (PDFの有効径/2)
# type: Lens, Gap, Doublet_1/2/3, Stop

surfaces = [
    # G1 (L1)
    {"id": 1,  "r": 51.484,   "d": 3.50, "nd": 1.76385, "vd": 48.5, "type": "Lens", "semi_dia": 33.385},
    {"id": 2,  "r": 24.505,   "d": 4.08, "type": "Gap", "semi_dia": 22.805},
    
    # G1 (L2) - Aspheric
    {"id": 3,  "r": 37.431,   "d": 3.50, "nd": 1.58313, "vd": 59.4, "type": "Lens", "semi_dia": 22.225,
     "asph": {"K": 0.0, "coef1": 4.52435e-05, "coef2": -1.26025e-07, "coef3": 1.47656e-10, "coef4": -5.90236e-14}},
    {"id": 4,  "r": 16.924,   "d": 9.62, "type": "Gap", "semi_dia": 18.195,
     "asph": {"K": -3.95231, "coef1": 1.44227e-04, "coef2": -3.81341e-07, "coef3": 3.24673e-10, "coef4": -9.02355e-14}},
     
    # G1 (L3)
    {"id": 5,  "r": 54.274,   "d": 2.00, "nd": 1.53775, "vd": 74.7, "type": "Lens", "semi_dia": 17.31},
    {"id": 6,  "r": 16.271,   "d": 8.02, "type": "Gap", "semi_dia": 12.72},
    
    # G1 (L4)
    {"id": 7,  "r": -71.242,  "d": 1.20, "nd": 1.49700, "vd": 81.5, "type": "Lens", "semi_dia": 12.115},
    {"id": 8,  "r": 15.842,   "d": 0.50, "type": "Gap", "semi_dia": 10.145},
    
    # G1 (L5)
    {"id": 9,  "r": 15.838,   "d": 6.98, "nd": 1.64769, "vd": 33.8, "type": "Lens", "semi_dia": 10.095},
    {"id": 10, "r": -53.329,  "d": 0.81, "type": "Gap", "semi_dia": 9.145},
    
    # G1 (L6)
    {"id": 11, "r": -32.804,  "d": 1.20, "nd": 2.05090, "vd": 26.9, "type": "Lens", "semi_dia": 8.705},
    {"id": 12, "r": -258.347, "d": "d12", "type": "Gap", "semi_dia": 8.31}, # Variable Gap
    
    # G2 (Doublet L7-L8)
    {"id": 13, "r": 29.936,   "d": 1.00, "nd": 2.00069, "vd": 25.5, "type": "Doublet_1", "semi_dia": 7.595},
    {"id": 14, "r": 13.309,   "d": 5.00, "nd": 1.69895, "vd": 30.1, "type": "Doublet_2", "semi_dia": 6.925},
    {"id": 15, "r": -74.614,  "d": "d15", "type": "Gap", "semi_dia": 6.09}, # Variable Gap
    
    # G3 (L9)
    {"id": 16, "r": 43.590,   "d": 3.00, "nd": 1.69895, "vd": 30.1, "type": "Lens", "semi_dia": 6.06},
    {"id": 17, "r": -106.025, "d": 2.00, "type": "Gap", "semi_dia": 6.06},
    
    # Aperture Stop
    {"id": 18, "r": "INF",    "d": 3.00, "type": "Stop", "semi_dia": 5.965},
    
    # G4 (Doublet L10-L11)
    {"id": 19, "r": 693.528,  "d": 1.20, "nd": 1.91082, "vd": 35.2, "type": "Doublet_1", "semi_dia": 5.835},
    {"id": 20, "r": 21.101,   "d": 3.19, "nd": 1.49700, "vd": 81.5, "type": "Doublet_2", "semi_dia": 5.785},
    {"id": 21, "r": -48.232,  "d": "d21", "type": "Gap", "semi_dia": 5.875}, # Variable Gap
    
    # G5 (Doublet L12-L13)
    {"id": 22, "r": 497.332,  "d": 10.00, "nd": 1.49700, "vd": 81.5, "type": "Doublet_1", "semi_dia": 13.01},
    {"id": 23, "r": -16.893,  "d": 1.20,  "nd": 1.81600, "vd": 46.6, "type": "Doublet_2", "semi_dia": 14.295},
    {"id": 24, "r": -30.396,  "d": 1.26, "type": "Gap", "semi_dia": 17.225},
    
    # G5 (L14)
    {"id": 25, "r": -55.676,  "d": 10.00, "nd": 1.59522, "vd": 67.7, "type": "Lens", "semi_dia": 19.80},
    {"id": 26, "r": -28.074,  "d": "d26", "type": "Gap", "semi_dia": 21.875}, # Variable Gap
    
    # G6 (Doublet L15-L16)
    {"id": 27, "r": 92.247,   "d": 10.00, "nd": 1.49700, "vd": 81.5, "type": "Doublet_1", "semi_dia": 25.03},
    {"id": 28, "r": -71.282,  "d": 1.20,  "nd": 1.91082, "vd": 35.2, "type": "Doublet_2", "semi_dia": 24.885},
    {"id": 29, "r": 239.071,  "d": 0.50, "type": "Gap", "semi_dia": 25.075},
    
    # G6 (L17)
    {"id": 30, "r": 69.754,   "d": 10.00, "nd": 1.49700, "vd": 81.5, "type": "Lens", "semi_dia": 25.68},
    {"id": 31, "r": -73.446,  "d": "d31", "type": "Gap", "semi_dia": 25.595, # Variable Gap
     "asph": {"K": 0.0, "coef1": 7.86949e-06, "coef2": -8.40872e-09, "coef3": 5.43729e-12, "coef4": -2.87438e-17}},
     
    # G7 (Doublet L18-L19)
    {"id": 32, "r": -127.608, "d": 7.23, "nd": 1.86966, "vd": 20.0, "type": "Doublet_1", "semi_dia": 16.275},
    {"id": 33, "r": -24.277,  "d": 1.50, "nd": 2.05090, "vd": 26.9, "type": "Doublet_2", "semi_dia": 16.29},
    {"id": 34, "r": -71.891,  "d": 3.65, "type": "Gap", "semi_dia": 16.78},
    
    # G7 (L20)
    {"id": 35, "r": -30.006,  "d": 1.50, "nd": 2.00069, "vd": 25.5, "type": "Lens", "semi_dia": 16.74},
    {"id": 36, "r": -54.371,  "d": 15.00, "type": "Gap", "semi_dia": 17.77} # BF
]

zoom_data = {
    "Wide":   {"d12": 0.69, "d15": 0.57, "d21": 2.99, "d26": 3.00, "d31": 3.50},
    "Middle": {"d12": 2.99, "d15": 3.11, "d21": 3.11, "d26": 3.00, "d31": 3.50},
    "Tele":   {"d12": 3.50, "d15": 3.50, "d21": 3.50, "d26": 3.50, "d31": 3.50}
}

# ---------------------------------------------------------
# 2. JSON生成ロジック
# ---------------------------------------------------------

def create_lens_block(idx, s_front, s_back):
    block = {
        "blockId": f"Lens-{idx}",
        "blockType": "Lens",
        "parameters": {
            "frontRadius": s_front["r"],
            "backRadius": s_back["r"],
            "centerThickness": s_front["d"],
            "material": str(s_front["nd"]),
            "abbe": s_front["vd"],
            "frontSurfType": "Spherical",
            "backSurfType": "Spherical"
        },
        "aperture": {
            "front": s_front["semi_dia"],
            "back": s_back["semi_dia"]
        }
    }
    
    if "asph" in s_front:
        block["parameters"]["frontSurfType"] = "Aspheric even"
        block["parameters"]["frontConic"] = s_front["asph"]["K"]
        for k, v in s_front["asph"].items():
            if k != "K": block["parameters"][f"front{k.capitalize()}"] = v
            
    if "asph" in s_back:
        block["parameters"]["backSurfType"] = "Aspheric even"
        block["parameters"]["backConic"] = s_back["asph"]["K"]
        for k, v in s_back["asph"].items():
             if k != "K": block["parameters"][f"back{k.capitalize()}"] = v

    return block

def create_doublet_block(idx, s1, s2, s3):
    return {
        "blockId": f"Doublet-{idx}",
        "blockType": "Doublet",
        "parameters": {
            "radius1": s1["r"],
            "radius2": s2["r"],
            "radius3": s3["r"],
            "thickness1": s1["d"],
            "thickness2": s2["d"],
            "material1": str(s1["nd"]),
            "material2": str(s2["nd"]),
            "abbe1": s1["vd"],
            "abbe2": s2["vd"],
            "surf1SurfType": "Spherical",
            "surf2SurfType": "Spherical",
            "surf3SurfType": "Spherical"
        },
        "aperture": {
            "s1": s1["semi_dia"],
            "s2": s2["semi_dia"],
            "s3": s3["semi_dia"]
        }
    }

def create_gap_block(idx, s, zoom_vals):
    d_val = s["d"]
    if isinstance(d_val, str) and d_val in zoom_vals:
        d_val = zoom_vals[d_val]
    
    return {
        "blockId": f"Gap-{idx}",
        "blockType": "Gap",
        "parameters": {
            "thickness": d_val,
            "material": "AIR"
        },
        # Gapには有効径パラメータがない場合が多いですが、
        # 前面の有効径を参照情報として含めることも可能です。
        # ここではシンプルにThicknessのみとします。
    }

def create_config(config_id, name, zoom_vals):
    blocks = []
    
    blocks.append({
        "blockId": "ObjectPlane-1",
        "blockType": "ObjectPlane",
        "parameters": {"objectDistanceMode": "INF", "objectDistance": 0}
    })

    lens_idx = 1
    doublet_idx = 1
    gap_idx = 1
    
    i = 0
    while i < len(surfaces):
        s = surfaces[i]
        
        if s["type"] == "Lens":
            s_next = surfaces[i+1]
            blocks.append(create_lens_block(lens_idx, s, s_next))
            lens_idx += 1
            i += 1
        
        elif s["type"] == "Doublet_1":
            s1 = surfaces[i]
            s2 = surfaces[i+1]
            s3 = surfaces[i+2]
            blocks.append(create_doublet_block(doublet_idx, s1, s2, s3))
            doublet_idx += 1
            i += 2
            
        elif s["type"] == "Stop":
            # Stopブロック自体の有効径
            blocks.append({
                "blockId": "Stop-1",
                "blockType": "Stop",
                "parameters": {"semiDiameter": s["semi_dia"]}
            })
            # Stop後のGapを追加
            blocks.append(create_gap_block(gap_idx, s, zoom_vals))
            gap_idx += 1
            i += 1
             
        elif s["type"] == "Gap":
            blocks.append(create_gap_block(gap_idx, s, zoom_vals))
            gap_idx += 1
            i += 1
            
    blocks.append({
        "blockId": "ImageSurface-1",
        "blockType": "ImageSurface",
        "parameters": {"semidia": 21.64} # Image Height
    })

    return {
        "id": config_id,
        "name": name,
        "blocks": blocks
    }

configs = []
configs.append(create_config(1, "Wide (17.20mm)", zoom_data["Wide"]))
configs.append(create_config(2, "Middle (51.52mm)", zoom_data["Middle"]))
configs.append(create_config(3, "Tele (146.51mm)", zoom_data["Tele"]))

final_json = {
    "configurations": {
        "configurations": configs,
        "activeConfigId": 1
    }
}

print(json.dumps(final_json, indent=2))