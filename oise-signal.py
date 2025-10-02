# save as: get_oise_signals.py
import osmnx as ox
import geopandas as gpd
import random

AREA = "Oise, France"

# 1) Oise 边界
gdf_area = ox.geocode_to_gdf(AREA)
poly = gdf_area.geometry.iloc[0]

# 2) 获取交通信号灯点
signals_raw = ox.features_from_polygon(poly, tags={"highway": "traffic_signals"})
signals = signals_raw[signals_raw.geometry.type == "Point"].copy()
signals = signals.to_crs(4326).reset_index(drop=True)

# 3) 给每个信号灯生成模拟参数
def assign_cycle(props):
    # 默认
    base_cycle = 60
    green = 30

    # 根据道路等级调整（如果有 highway 字段）
    hw = str(props.get("highway", "")).lower()
    if hw in ["motorway", "trunk", "primary", "secondary"]:
        base_cycle = random.randint(80, 100)  # 主干道周期长
        green = base_cycle // 2
    elif hw in ["tertiary", "unclassified", "residential"]:
        base_cycle = random.randint(50, 70)   # 小路短周期
        green = base_cycle // 2
    else:
        base_cycle = random.randint(55, 75)
        green = base_cycle // 2

    # 随机相位偏移，避免所有路口同相位
    offset = random.randint(0, base_cycle-1)

    return base_cycle, green, offset

cycles, greens, offsets = [], [], []
for _, row in signals.iterrows():
    cycle, green, offset = assign_cycle(row)
    cycles.append(cycle)
    greens.append(green + random.randint(-5, 5))  # 红绿灯时长 ±5 秒浮动
    offsets.append(offset)

signals["cycle_s"] = cycles
signals["green_s"] = greens
signals["offset_s"] = offsets

# 4) 保存文件
signals.to_file("oise-signals.geojson", driver="GeoJSON")
print(f"✓ 导出 {len(signals)} 个红绿灯点 (含周期/绿灯/相位) 到 oise-signals.geojson")
