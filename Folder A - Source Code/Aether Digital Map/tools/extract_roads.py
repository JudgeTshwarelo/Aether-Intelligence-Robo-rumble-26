# tools/extract_roads.py
# ---------------------------------------------------------------------------
# Extract a road graph from a Mankweng GLB (or any urban:EXPORT GLB) and
# write it as roads.json next to the location's meta.json.
#
# Approach:
#   1. Load the GLB with pygltflib or trimesh.
#   2. Find every mesh whose name starts with "ROAD".
#   3. Treat each road mesh as a planar graph: its triangles form a ribbon.
#   4. Collapse the ribbon to a centreline by:
#        - projecting every vertex to a grid (default 8 m)
#        - connecting any two grid cells that share a triangle edge
#   5. Emit { nodes: [...], edges: [...] } in lat/lon using the meta centre.
#
# Requires: trimesh, numpy, pyproj (optional, for exact projection).
#
# Run:
#   python tools/extract_roads.py frontend/models/mankweng
# ---------------------------------------------------------------------------

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import trimesh


# ---------------------------------------------------------------------------
# Constants — must match city-loader.js
# ---------------------------------------------------------------------------
METRES_PER_DEG_LAT = 110540.0
def metres_per_deg_lon(lat_deg: float) -> float:
    return 111320.0 * math.cos(math.radians(lat_deg))

GRID_SIZE_M = 8.0       # collapse vertices to this grid — road centrelines
                        # will end up ~8 m apart, which is fine for cars


def main(location_dir: str) -> int:
    loc = Path(location_dir).resolve()
    meta_path = loc / 'meta.json'
    glb_path = loc / 'mankweng.glb'

    if not meta_path.exists():
        print(f'error: {meta_path} not found')
        return 1
    if not glb_path.exists():
        print(f'error: {glb_path} not found')
        return 1

    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    center_lat = float(meta['center']['lat'])
    center_lon = float(meta['center']['lon'])

    print(f'loading {glb_path.name} ...')
    scene = trimesh.load(str(glb_path), force='scene')

    road_meshes = []
    for name, geom in scene.geometry.items():
        if name.upper().startswith('ROAD'):
            road_meshes.append((name, geom))
            print(f'  found road mesh: {name} ({len(geom.vertices)} verts)')

    if not road_meshes:
        print('error: no ROAD* meshes found in the GLB')
        return 1

    # ---- Collect all road vertices in scene coordinates -------------------
    all_verts = []
    for _, geom in road_meshes:
        verts = np.asarray(geom.vertices, dtype=np.float64)
        all_verts.append(verts[:, :3])   # drop any 4th column

    verts = np.concatenate(all_verts, axis=0)

    # ---- Collapse vertices to a grid -------------------------------------
    # Grid cell index -> list of original vertices in that cell.
    # Cell centres become our graph nodes.
    cell_to_vert_indices: dict[tuple[int, int], list[int]] = {}
    for i, (x, y, z) in enumerate(verts):
        gx = int(round(x / GRID_SIZE_M))
        gz = int(round(z / GRID_SIZE_M))
        cell_to_vert_indices.setdefault((gx, gz), []).append(i)

    # Node id from grid cell.
    cell_to_node_id: dict[tuple[int, int], str] = {}
    nodes = []
    for (gx, gz), _ in cell_to_vert_indices.items():
        nid = f'n{gx}_{gz}'
        cell_to_node_id[(gx, gz)] = nid
        # Scene coords -> lat/lon
        x_m = gx * GRID_SIZE_M
        z_m = gz * GRID_SIZE_M
        lat = center_lat + (-z_m) / METRES_PER_DEG_LAT
        lon = center_lon + x_m / metres_per_deg_lon(center_lat)
        nodes.append({'id': nid, 'lat': lat, 'lon': lon})

    # ---- Build edges: for every triangle in every road mesh, connect the
    #      three grid cells its vertices belong to.
    edges = {}
    edge_set = set()

    for _, geom in road_meshes:
        faces = np.asarray(geom.faces)
        verts_arr = np.asarray(geom.vertices)[:, :3]

        for tri in faces:
            cells = []
            for vi in tri:
                x, y, z = verts_arr[vi]
                gx = int(round(x / GRID_SIZE_M))
                gz = int(round(z / GRID_SIZE_M))
                cells.append((gx, gz))

            # Deduplicate cells within the triangle (degenerate triangles).
            unique = list(dict.fromkeys(cells))
            if len(unique) < 2:
                continue

            # Connect every pair.
            for i in range(len(unique)):
                for j in range(i + 1, len(unique)):
                    a = unique[i]
                    b = unique[j]
                    key = tuple(sorted([a, b]))
                    if key in edge_set:
                        continue
                    edge_set.add(key)

                    a_id = cell_to_node_id[a]
                    b_id = cell_to_node_id[b]

                    ax = a[0] * GRID_SIZE_M
                    az = a[1] * GRID_SIZE_M
                    bx = b[0] * GRID_SIZE_M
                    bz = b[1] * GRID_SIZE_M
                    length_m = math.hypot(bx - ax, bz - az)
                    if length_m < 1.0:
                        continue

                    eid = f'e_{a_id}_{b_id}'
                    edges[eid] = {
                        'id': eid,
                        'from': a_id,
                        'to': b_id,
                        'length_m': round(length_m, 2),
                        'speed_ms': 13.9,      # ~50 km/h
                    }

    print(f'  built graph: {len(nodes)} nodes, {len(edges)} edges')

    out_path = loc / 'roads.json'
    out_path.write_text(json.dumps({
        'nodes': nodes,
        'edges': list(edges.values()),
        'grid_size_m': GRID_SIZE_M,
        'source': 'extract_roads.py',
    }, indent=2), encoding='utf-8')

    print(f'wrote {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else '.'))