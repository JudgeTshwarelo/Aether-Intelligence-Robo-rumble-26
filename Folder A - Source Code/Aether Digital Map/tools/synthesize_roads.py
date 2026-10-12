# tools/synthesize_roads.py
# ---------------------------------------------------------------------------
# Fallback road generator for Mankweng (or any urban:EXPORT GLB that shipped
# without the ROADS layer).
#
# Approach:
#   1. Load the GLB.
#   2. Rasterize every building footprint onto a 2D occupancy grid.
#   3. Free cells inside the bounds = candidate road cells.
#   4. Morphological thinning to a 1-cell-wide skeleton.
#   5. Convert skeleton pixels to graph nodes / edges.
#   6. Write roads.json.
#
# Requires: trimesh, numpy, scipy, scikit-image.
#
# Run:
#   python tools/synthesize_roads.py frontend/models/mankweng
# ---------------------------------------------------------------------------

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import trimesh
from scipy import ndimage
from skimage.morphology import skeletonize


METRES_PER_DEG_LAT = 110540.0
def metres_per_deg_lon(lat_deg: float) -> float:
    return 111320.0 * math.cos(math.radians(lat_deg))


CELL_SIZE_M = 6.0    # occupancy grid resolution — 6 m per cell
                     # small enough to trace real streets, big enough to be fast


def main(location_dir: str) -> int:
    loc = Path(location_dir).resolve()
    meta_path = loc / 'meta.json'
    glb_path = loc / 'mankweng.glb'

    if not meta_path.exists() or not glb_path.exists():
        print('error: meta.json or mankweng.glb missing')
        return 1

    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    center_lat = float(meta['center']['lat'])
    center_lon = float(meta['center']['lon'])

    bounds = meta.get('bounds') or {}
    if not all(k in bounds for k in ('north', 'south', 'east', 'west')):
        print('error: meta.json needs explicit bounds')
        return 1

    north = float(bounds['north'])
    south = float(bounds['south'])
    east  = float(bounds['east'])
    west  = float(bounds['west'])

    # ---- Raster grid dimensions -----------------------------------------
    # X axis = east, Z axis = south. Same convention as city-loader.js.
    size_x_m = (east - west) * metres_per_deg_lon(center_lat)
    size_z_m = (north - south) * METRES_PER_DEG_LAT

    cols = int(size_x_m / CELL_SIZE_M) + 1
    rows = int(size_z_m / CELL_SIZE_M) + 1

    print(f'raster: {cols} x {rows} cells  ({size_x_m:.0f} x {size_z_m:.0f} m)')

    occupancy = np.zeros((rows, cols), dtype=np.uint8)

    # ---- Load GLB, rasterize buildings ----------------------------------
    print(f'loading {glb_path.name} ...')
    scene = trimesh.load(str(glb_path), force='scene')

    building_meshes = [
        (n, g) for n, g in scene.geometry.items()
        if n.upper().startswith('BUILDING')
    ]

    if not building_meshes:
        print('error: no BUILDING* meshes found')
        return 1

    for name, geom in building_meshes:
        # Use the vertices directly. Buildings are extruded prisms, so
        # every vertex has an (x, z) footprint. Rasterize each vertex as
        # a filled cell. This slightly over-estimates building size but
        # is fast and works without triangulation.
        verts = np.asarray(geom.vertices)[:, :3]

        for x, y, z in verts:
            # Scene metres -> grid cell. Scene origin is at meta centre.
            col = int(round((x + size_x_m / 2) / CELL_SIZE_M))
            row = int(round((z + size_z_m / 2) / CELL_SIZE_M))

            if 0 <= row < rows and 0 <= col < cols:
                occupancy[row, col] = 1

    # Dilate buildings slightly so we don't route cars through walls.
    occupancy = ndimage.binary_dilation(occupancy, iterations=1).astype(np.uint8)

    # ---- Roads = free cells inside the city ----------------------------
    free = (occupancy == 0).astype(np.uint8)

    # We only care about the area actually covered by the buildings and
    # a modest margin around them. Anything far from any building is
    # open field, not a road.
    built_extent = ndimage.binary_dilation(occupancy, iterations=8)
    free = free * built_extent

    print(f'free cells: {int(free.sum())}')

    # ---- Skeletonize to a 1-cell-wide centreline -----------------------
    skeleton = skeletonize(free.astype(bool))
    print(f'skeleton cells: {int(skeleton.sum())}')

    # ---- Convert skeleton pixels to nodes and edges --------------------
    nodes = {}
    node_index_to_id = {}

    ys, xs = np.where(skeleton)
    for r, c in zip(ys, xs):
        nid = f'n{r}_{c}'
        node_index_to_id[(r, c)] = nid

        x_m = (c * CELL_SIZE_M) - size_x_m / 2
        z_m = (r * CELL_SIZE_M) - size_z_m / 2

        lat = center_lat + (-z_m) / METRES_PER_DEG_LAT
        lon = center_lon + x_m / metres_per_deg_lon(center_lat)

        nodes[nid] = {'id': nid, 'lat': lat, 'lon': lon}

    edges = {}
    # 8-connected skeleton graph, but only horizontal/vertical/diagonal
    # neighbours that are also skeleton pixels.
    for r, c in zip(ys, xs):
        a_id = node_index_to_id[(r, c)]
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nr, nc = r + dr, c + dc
                if (nr, nc) not in node_index_to_id:
                    continue
                b_id = node_index_to_id[(nr, nc)]
                # Canonical edge id so we don't duplicate.
                key = tuple(sorted([a_id, b_id]))
                if key in edges:
                    continue
                eid = f'e_{key[0]}_{key[1]}'
                length_m = math.hypot(dr * CELL_SIZE_M, dc * CELL_SIZE_M)
                edges[eid] = {
                    'id': eid,
                    'from': a_id,
                    'to': b_id,
                    'length_m': round(length_m, 2),
                    'speed_ms': 13.9,
                }

    print(f'graph: {len(nodes)} nodes, {len(edges)} edges')

    out_path = loc / 'roads.json'
    out_path.write_text(json.dumps({
        'nodes': list(nodes.values()),
        'edges': list(edges.values()),
        'grid_size_m': CELL_SIZE_M,
        'source': 'synthesize_roads.py',
        'note':  'Inferred from building gaps. Not official road centrelines.',
    }, indent=2), encoding='utf-8')

    print(f'wrote {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else '.'))