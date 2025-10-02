import osmnx as ox
import json

# 1) 拿 Oise 边界（名字解析）
gdf = ox.geocode_to_gdf("Oise, France")

# 2) 生成行车路网（只要可行驶车的道路）
G = ox.graph_from_polygon(
    gdf.geometry.iloc[0],
    network_type="drive",
    simplify=True
)

# 3) 转 GeoJSON（线）
gdf_edges = ox.graph_to_gdfs(G, nodes=False, edges=True, fill_edge_geometry=True)
gdf_edges.to_file("oise-roads.geojson", driver="GeoJSON")
