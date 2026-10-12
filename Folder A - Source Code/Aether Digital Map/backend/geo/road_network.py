# backend/geo/road_network.py
# ---------------------------------------------------------------------------
# The road network cars drive on.
#
# Two sources, in order of preference:
#   1. `roads.json` next to a location's meta.json — produced by the offline
#      extractor in tools/extract_roads.py. Real road network from the GLB.
#   2. A synthetic grid derived from meta.json bounds — used as a fallback
#      so the demo runs before the extractor has been executed.
#
# Bounds are resolved in this order:
#   a. meta.bounds.{north,south,east,west}    — explicit, preferred
#   b. meta.center + meta.size_km             — derived, robust fallback
#
# Exposes a lightweight graph:
#   • nodes : { id -> (lat, lon) }
#   • edges : { id -> { from, to, length_m, speed_ms } }
#   • adjacency : { node_id -> [edge_id, ...] }
#
# Plus helpers for spawning cars and querying the graph.
# ---------------------------------------------------------------------------

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple


DEFAULT_SPEED_MS = 13.9   # ~50 km/h
MIN_EDGE_LENGTH  = 5.0    # anything shorter than this is treated as noise

METRES_PER_DEG_LAT = 110540.0
METRES_PER_DEG_LON = 111320.0


# ---------------------------------------------------------------------------
# Node / edge records
# ---------------------------------------------------------------------------
@dataclass
class Node:
    id: str
    lat: float
    lon: float


@dataclass
class Edge:
    id: str
    from_id: str
    to_id: str
    length_m: float
    speed_ms: float


# ---------------------------------------------------------------------------
# RoadNetwork
# ---------------------------------------------------------------------------
class RoadNetwork:
    """
    A directed graph of road segments. Cars traverse edges in the direction
    they were defined. For two-way roads, the extractor emits two edges.

    Load priority:
      1. `roads.json` path passed to the constructor (if it exists)
      2. Synthetic grid from `meta.bounds` or `meta.center + meta.size_km`
    """

    def __init__(
        self,
        roads_json_path: Optional[Path] = None,
        meta: Optional[dict] = None,
    ) -> None:
        self.nodes: Dict[str, Node] = {}
        self.edges: Dict[str, Edge] = {}
        self.adjacency: Dict[str, List[str]] = {}

        self.source: str = 'unknown'

        loaded = False
        if roads_json_path and Path(roads_json_path).exists():
            try:
                self._load_from_json(Path(roads_json_path))
                loaded = True
                self.source = 'roads.json'
            except Exception as exc:
                print(f'[road_network] failed to load {roads_json_path}: {exc!r}')

        if not loaded:
            if meta is None:
                raise RuntimeError(
                    'RoadNetwork: no roads.json and no meta fallback provided'
                )
            self._synthesize_grid(meta)
            self.source = 'synthetic-grid'

        # Build reverse adjacency for nearest-node lookups.
        self._rebuild_adjacency()

        print(
            f'[road_network] {self.source} — '
            f'{len(self.nodes)} nodes, {len(self.edges)} edges'
        )

    # -----------------------------------------------------------------------
    # Construction
    # -----------------------------------------------------------------------

    def _load_from_json(self, path: Path) -> None:
        data = json.loads(path.read_text(encoding='utf-8'))

        for n in data.get('nodes', []):
            self.nodes[n['id']] = Node(
                id=n['id'],
                lat=float(n['lat']),
                lon=float(n['lon']),
            )

        for e in data.get('edges', []):
            if e['from'] not in self.nodes or e['to'] not in self.nodes:
                continue
            length = float(e.get('length_m') or self._edge_length(
                e['from'], e['to']
            ))
            if length < MIN_EDGE_LENGTH:
                continue
            self.edges[e['id']] = Edge(
                id=e['id'],
                from_id=e['from'],
                to_id=e['to'],
                length_m=length,
                speed_ms=float(e.get('speed_ms') or DEFAULT_SPEED_MS),
            )

    def _resolve_bounds(self, meta: dict) -> Tuple[float, float, float, float]:
        """
        Return (north, south, east, west) in decimal degrees.

        Order of preference:
          1. meta.bounds.{north,south,east,west}
          2. meta.center + meta.size_km  (assumes a square footprint)
        """
        bounds = meta.get('bounds') or {}
        north = bounds.get('north')
        south = bounds.get('south')
        east  = bounds.get('east')
        west  = bounds.get('west')

        if None not in (north, south, east, west):
            return float(north), float(south), float(east), float(west)

        # ---- Derive from center + size_km --------------------------------
        center = meta.get('center') or {}
        size_km = meta.get('size_km')

        if 'lat' not in center or 'lon' not in center or not size_km:
            raise RuntimeError(
                'RoadNetwork: meta has neither bounds nor (center + size_km). '
                'Add one of these to meta.json.'
            )

        # size_km is area in km². Assume a square footprint.
        side_m = math.sqrt(float(size_km) * 1_000_000.0)
        half_side_m = side_m / 2.0

        half_lat = half_side_m / METRES_PER_DEG_LAT
        half_lon = half_side_m / (
            METRES_PER_DEG_LON * math.cos(math.radians(float(center['lat'])))
        )

        return (
            float(center['lat']) + half_lat,   # north
            float(center['lat']) - half_lat,   # south
            float(center['lon']) + half_lon,   # east
            float(center['lon']) - half_lon,   # west
        )

    def _synthesize_grid(self, meta: dict) -> None:
        """
        Build a plausible road grid inside the meta's bounds. Number of
        streets scales with the area so a 1 km² and a 5 km² area both get a
        sensible density.

        Grid spacing: ~180 m. That gives roughly 6×6 = 36 intersections in a
        1 km² area, which reads as a small town.
        """
        north, south, east, west = self._resolve_bounds(meta)

        # Convert bounds to metric size for spacing decisions.
        height_m = (north - south) * METRES_PER_DEG_LAT
        width_m  = (east - west) * METRES_PER_DEG_LON * math.cos(
            math.radians((north + south) / 2)
        )

        spacing = 180.0
        cols = max(2, int(width_m  / spacing) + 1)
        rows = max(2, int(height_m / spacing) + 1)

        # Space the grid evenly across the bounds.
        lons = [west + (east - west) * (i / (cols - 1)) for i in range(cols)]
        lats = [south + (north - south) * (j / (rows - 1)) for j in range(rows)]

        # Create nodes.
        def node_id(i: int, j: int) -> str:
            return f'n{i}_{j}'

        for i, lon in enumerate(lons):
            for j, lat in enumerate(lats):
                nid = node_id(i, j)
                self.nodes[nid] = Node(id=nid, lat=lat, lon=lon)

        # Create horizontal edges (east-west) and their reverse.
        for i in range(cols - 1):
            for j in range(rows):
                a = node_id(i,     j)
                b = node_id(i + 1, j)
                length = self._edge_length(a, b)
                for src, dst in ((a, b), (b, a)):
                    eid = f'e_{src}_{dst}'
                    self.edges[eid] = Edge(
                        id=eid, from_id=src, to_id=dst,
                        length_m=length, speed_ms=DEFAULT_SPEED_MS,
                    )

        # Create vertical edges (north-south) and their reverse.
        for i in range(cols):
            for j in range(rows - 1):
                a = node_id(i, j)
                b = node_id(i, j + 1)
                length = self._edge_length(a, b)
                for src, dst in ((a, b), (b, a)):
                    eid = f'e_{src}_{dst}'
                    self.edges[eid] = Edge(
                        id=eid, from_id=src, to_id=dst,
                        length_m=length, speed_ms=DEFAULT_SPEED_MS,
                    )

    def _rebuild_adjacency(self) -> None:
        self.adjacency = {nid: [] for nid in self.nodes}
        for edge in self.edges.values():
            self.adjacency.setdefault(edge.from_id, []).append(edge.id)

    # -----------------------------------------------------------------------
    # Query
    # -----------------------------------------------------------------------

    def edge(self, edge_id: str) -> Optional[Edge]:
        return self.edges.get(edge_id)

    def node(self, node_id: str) -> Optional[Node]:
        return self.nodes.get(node_id)

    def edges_from(self, node_id: str) -> List[Edge]:
        return [
            self.edges[eid] for eid in self.adjacency.get(node_id, [])
        ]

    def random_edge(self) -> Edge:
        return random.choice(list(self.edges.values()))

    def nearest_edge(
        self, lat: float, lon: float
    ) -> Optional[Tuple[Edge, float, float]]:
        """
        Find the edge whose closest point to (lat, lon) is nearest.
        Returns (edge, fraction_along [0,1], distance_m) or None.

        Used at spawn time to place cars near where they're needed, and
        when the frontend asks "which road am I on".
        """
        best: Optional[Tuple[Edge, float, float]] = None
        best_d = float('inf')

        for edge in self.edges.values():
            a = self.nodes[edge.from_id]
            b = self.nodes[edge.to_id]
            frac, dist = _project_point_on_segment(
                lat, lon, a.lat, a.lon, b.lat, b.lon
            )
            if dist < best_d:
                best_d = dist
                best = (edge, frac, dist)

        return best

    # -----------------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------------

    def _edge_length(self, a_id: str, b_id: str) -> float:
        a = self.nodes[a_id]
        b = self.nodes[b_id]
        return _haversine(a.lat, a.lon, b.lat, b.lon)


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(d_lon / 2) ** 2)
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def _project_point_on_segment(
    p_lat: float, p_lon: float,
    a_lat: float, a_lon: float,
    b_lat: float, b_lon: float,
) -> Tuple[float, float]:
    """
    Project (p_lat, p_lon) onto segment A→B, in a local metric frame.
    Returns (fraction_along [0,1], perpendicular_distance_m).
    """
    cos_lat = math.cos(math.radians((a_lat + p_lat) / 2))

    bx = (b_lon - a_lon) * METRES_PER_DEG_LON * cos_lat
    by = (b_lat - a_lat) * METRES_PER_DEG_LAT
    px = (p_lon - a_lon) * METRES_PER_DEG_LON * cos_lat
    py = (p_lat - a_lat) * METRES_PER_DEG_LAT

    denom = bx * bx + by * by
    if denom < 1e-9:
        return (0.0, math.hypot(px, py))

    t = (px * bx + py * by) / denom
    t = max(0.0, min(1.0, t))

    proj_x = bx * t
    proj_y = by * t
    dist = math.hypot(px - proj_x, py - proj_y)
    return (t, dist)


def interpolate(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
    t: float,
) -> Tuple[float, float]:
    """Linearly interpolate between two lat/lon points."""
    return (
        lat1 + (lat2 - lat1) * t,
        lon1 + (lon2 - lon1) * t,
    )