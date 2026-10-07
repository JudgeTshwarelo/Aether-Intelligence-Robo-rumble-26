# backend/engine/highways.py
# AETHER / SKYNET — highway routing layer.
# Turns the static highway payload from city_generator.build_highways()
# into routable edges the simulation can drive vehicles along.

from __future__ import annotations

import math
from typing import Dict, List, Optional

from backend.engine.city_generator import (
    HIGHWAY_LANE_WIDTH,
    HIGHWAY_LANES,
    HIGHWAY_SPEED,
    HIGHWAY_WIDTH,
)

# ---------------------------------------------------------------------------
# Edge representation
# ---------------------------------------------------------------------------
# Each highway becomes TWO directed edges (a→b, b→a). Each edge has:
#   - id, fromId (gateway id), toId (gateway id)
#   - start {x,z}, end {x,z}, length, heading
#   - width, lanes, laneWidth, speedRange
#   - pylons, roadsideTrees (world-space, copied from highway payload)

def _directed_edge(hw: dict, forward: bool) -> dict:
    a = hw['a']
    b = hw['b']
    if forward:
        start, end = a, b
        from_id = hw['fromGateway']
        to_id = hw['toGateway']
        edge_id = f"{hw['id']}>F"
    else:
        start, end = b, a
        from_id = hw['toGateway']
        to_id = hw['fromGateway']
        edge_id = f"{hw['id']}>R"

    dx = end['x'] - start['x']
    dz = end['z'] - start['z']
    length = math.hypot(dx, dz) or 1.0
    heading = math.atan2(dz, dx)

    return {
        'id': edge_id,
        'highwayId': hw['id'],
        'kind': 'highway',
        'fromId': from_id,
        'toId': to_id,
        'start': {'x': start['x'], 'z': start['z']},
        'end': {'x': end['x'], 'z': end['z']},
        'length': length,
        'heading': heading,
        'width': hw.get('width', HIGHWAY_WIDTH),
        'lanes': hw.get('lanes', HIGHWAY_LANES * 2),
        'laneWidth': hw.get('laneWidth', HIGHWAY_LANE_WIDTH),
        'speedRange': list(hw.get('speedRange', HIGHWAY_SPEED)),
        'pylons': hw.get('pylons', []),
        'roadsideTrees': hw.get('roadsideTrees', []),
    }


def build_highway_edges(highways: List[dict]) -> Dict[str, dict]:
    """Return a dict of edge_id → edge for all highways (both directions)."""
    edges: Dict[str, dict] = {}
    for hw in highways:
        for forward in (True, False):
            e = _directed_edge(hw, forward)
            edges[e['id']] = e
    return edges


# ---------------------------------------------------------------------------
# Gateway → highway edge lookup
# ---------------------------------------------------------------------------
def edges_for_gateway(edges: Dict[str, dict], gateway_id: str) -> List[dict]:
    """All highway edges that start or end at a given gateway."""
    out: List[dict] = []
    for e in edges.values():
        if e['fromId'] == gateway_id or e['toId'] == gateway_id:
            out.append(e)
    return out


# ---------------------------------------------------------------------------
# Position along a highway edge
# ---------------------------------------------------------------------------
def edge_position(edge: dict, progress: float, lane_offset: float = 0.0) -> dict:
    """
    Return world position + heading at a given progress (0..1) along an edge.
    lane_offset: lateral offset from centerline (positive = right of travel dir).
    """
    t = max(0.0, min(1.0, progress))
    x = edge['start']['x'] + (edge['end']['x'] - edge['start']['x']) * t
    z = edge['start']['z'] + (edge['end']['z'] - edge['start']['z']) * t

    # right-hand perpendicular
    h = edge['heading']
    rx = math.sin(h + math.pi / 2)
    rz = math.cos(h + math.pi / 2)

    return {
        'x': x + rx * lane_offset,
        'z': z + rz * lane_offset,
        'heading': h,
    }


# ---------------------------------------------------------------------------
# Nearest gateway helper
# ---------------------------------------------------------------------------
def nearest_gateway(world: dict, x: float, z: float) -> Optional[dict]:
    """Find the closest gateway across all cities to a world position."""
    best = None
    best_d = float('inf')
    for city in world['cities']:
        ox, oz = city['origin']
        for gw in city.get('gateways', []):
            gx = ox + gw['x']
            gz = oz + gw['z']
            d = (gx - x) ** 2 + (gz - z) ** 2
            if d < best_d:
                best_d = d
                best = {**gw, 'worldX': gx, 'worldZ': gz, 'cityId': city['id']}
    return best


# ---------------------------------------------------------------------------
# Highway lane offsets (shared across sim)
# ---------------------------------------------------------------------------
def highway_lane_offset(lane: int, edge: dict) -> float:
    """
    Lane 0 = outer (slow / right), lane 1 = inner (fast / left).
    Mirrors the local-road convention used in simulation.py.
    """
    lane_width = edge.get('laneWidth', HIGHWAY_LANE_WIDTH)
    if lane < 0:
        lane = 0
    if lane > 1:
        lane = 1
    # shift outward by half a lane relative to center, then by lane * lane_width
    return lane_width * 0.5 + lane * lane_width


# ---------------------------------------------------------------------------
# Convenience: which highways touch a given city?
# ---------------------------------------------------------------------------
def highways_for_city(world: dict, city_id: str) -> List[dict]:
    out: List[dict] = []
    for hw in world['highways']:
        if city_id in hw['cities']:
            out.append(hw)
    return out