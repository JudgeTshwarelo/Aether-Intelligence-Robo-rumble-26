from __future__ import annotations

from typing import List

from backend.engine.city_generator import GRID


def node_index(i: int, j: int) -> int:
    return i * (GRID + 1) + j


def neighbors_of_node(city: dict, node: dict) -> List[dict]:
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


def pick_next(city: dict, from_id: str, to_id: str) -> str:
    to_node = next(node for node in city['intersections'] if node['id'] == to_id)
    neighbors = neighbors_of_node(city, to_node)
    candidates = [node for node in neighbors if node['id'] != from_id]
    pool = candidates if candidates else neighbors
    if not pool:
        return to_id
    return pool[0 if len(pool) == 1 else __import__('random').randint(0, len(pool) - 1)]['id']


def axis_of(from_node: dict, to_node: dict) -> str:
    return 'ns' if from_node['x'] == to_node['x'] else 'ew'
