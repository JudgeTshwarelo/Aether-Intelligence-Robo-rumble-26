# backend/engine/pathfinding.py
# AETHER / SKYNET — pathfinding helpers.
# Turn-aware routing lives in simulation.choose_next_segment;
# the WorldGraph in intersections.py handles inter-city routing.

from __future__ import annotations

from typing import List

from backend.engine.city_generator import GRID


def node_index(i: int, j: int) -> int:
    return i * (GRID + 1) + j


def neighbors_of_node(city: dict, node: dict) -> List[dict]:
    """Return the (up to) four grid-adjacent intersections of a node."""
    i = node['gridI']
    j = node['gridJ']
    out: List[dict] = []
    if i > 0:
        out.append(city['intersections'][node_index(i - 1, j)])
    if i < GRID:
        out.append(city['intersections'][node_index(i + 1, j)])
    if j > 0:
        out.append(city['intersections'][node_index(i, j - 1)])
    if j < GRID:
        out.append(city['intersections'][node_index(i, j + 1)])
    return out


def axis_of(from_node: dict, to_node: dict) -> str:
    """'ns' if the segment runs north-south, 'ew' if east-west."""
    return 'ns' if from_node['x'] == to_node['x'] else 'ew'


def turn_direction(from_node: dict, to_node: dict, next_node: dict) -> str:
    """
    Classify a turn at `to_node` going from -> to -> next.
    Returns 'straight' | 'left' | 'right' | 'uturn'.
    """
    in_dx = to_node['x'] - from_node['x']
    in_dz = to_node['z'] - from_node['z']
    out_dx = next_node['x'] - to_node['x']
    out_dz = next_node['z'] - to_node['z']

    cross = in_dx * out_dz - in_dz * out_dx
    dot = in_dx * out_dx + in_dz * out_dz

    if cross == 0 and dot < 0:
        return 'uturn'
    if abs(cross) < 1e-6:
        return 'straight'
    return 'left' if cross > 0 else 'right'


def segment_length(a: dict, b: dict) -> float:
    import math
    return math.hypot(a['x'] - b['x'], a['z'] - b['z'])


# ---------------------------------------------------------------------------
# Inter-city helpers
# ---------------------------------------------------------------------------
def pick_destination_city(world: dict, exclude_city: str | None = None) -> str:
    """Pick a random city id, optionally excluding one."""
    import random
    ids = [c['id'] for c in world['cities'] if c['id'] != exclude_city]
    if not ids:
        ids = [c['id'] for c in world['cities']]
    return random.choice(ids)


def pick_destination_node_in_city(city: dict) -> dict:
    """Pick a random intersection node within a city."""
    import random
    return random.choice(city['intersections'])


def gateway_toward(world: dict, from_city_id: str, to_city_id: str) -> dict | None:
    """
    Given two city ids, return the gateway on `from_city` that best points
    toward `to_city` (closest in world space).
    """
    from_city = next((c for c in world['cities'] if c['id'] == from_city_id), None)
    to_city = next((c for c in world['cities'] if c['id'] == to_city_id), None)
    if not from_city or not to_city:
        return None

    tx = to_city['origin'][0]
    tz = to_city['origin'][1]
    best = None
    best_d = float('inf')
    for gw in from_city.get('gateways', []):
        gx = from_city['origin'][0] + gw['x']
        gz = from_city['origin'][1] + gw['z']
        d = (gx - tx) ** 2 + (gz - tz) ** 2
        if d < best_d:
            best_d = d
            best = gw
    return best