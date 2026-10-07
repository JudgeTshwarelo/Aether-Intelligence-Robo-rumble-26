# backend/engine/intersections.py
# AETHER / SKYNET — world topology glue.
# Builds a unified node graph that spans all cities + their gateways +
# highway edges, so simulation can path between any two points.

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Node / edge registry
# ---------------------------------------------------------------------------
class WorldGraph:
    """
    Unified topology. Nodes = city intersections + gateways.
    Edges  = local road edges (between intersections) + highway edges
             (between gateways), tagged with kind.
    """

    def __init__(self, world: dict, highway_edges: Dict[str, dict]):
        self.world = world
        self.nodes: Dict[str, dict] = {}
        self.edges: Dict[str, dict] = {}
        self.adj: Dict[str, List[str]] = {}

        self._build_nodes()
        self._build_local_edges()
        self._register_highway_edges(highway_edges)
        self._build_adjacency()

    # ---------------------------------------------------------------------
    # Nodes
    # ---------------------------------------------------------------------
    def _build_nodes(self) -> None:
        for city in self.world['cities']:
            ox, oz = city['origin']
            for node in city['intersections']:
                nid = f"{city['id']}:{node['id']}"
                self.nodes[nid] = {
                    **node,
                    'worldId': nid,
                    'cityId': city['id'],
                    'kind': 'intersection',
                    'worldX': ox + node['x'],
                    'worldZ': oz + node['z'],
                }
            for gw in city.get('gateways', []):
                nid = f"{city['id']}:{gw['id']}"
                self.nodes[nid] = {
                    **gw,
                    'worldId': nid,
                    'cityId': city['id'],
                    'kind': 'gateway',
                    'worldX': ox + gw['x'],
                    'worldZ': oz + gw['z'],
                }

    # ---------------------------------------------------------------------
    # Local road edges (intersection → intersection within a city)
    # ---------------------------------------------------------------------
    def _build_local_edges(self) -> None:
        for city in self.world['cities']:
            cid = city['id']
            grid = city['meta']['GRID']
            intersections = city['intersections']

            def idx(i: int, j: int) -> int:
                return i * (grid + 1) + j

            for i in range(grid + 1):
                for j in range(grid + 1):
                    a_id = f"{cid}:{intersections[idx(i, j)]['id']}"
                    a = self.nodes[a_id]
                    for di, dj in ((1, 0), (0, 1)):
                        ni, nj = i + di, j + dj
                        if ni > grid or nj > grid:
                            continue
                        b_id = f"{cid}:{intersections[idx(ni, nj)]['id']}"
                        b = self.nodes[b_id]

                        # forward
                        fwd_id = f"{a_id}>{b_id}"
                        self.edges[fwd_id] = {
                            'id': fwd_id,
                            'kind': 'local',
                            'cityId': cid,
                            'fromId': a_id,
                            'toId': b_id,
                            'length': math.hypot(b['worldX'] - a['worldX'], b['worldZ'] - a['worldZ']),
                            'start': {'x': a['worldX'], 'z': a['worldZ']},
                            'end': {'x': b['worldX'], 'z': b['worldZ']},
                        }
                        # reverse
                        rev_id = f"{b_id}>{a_id}"
                        self.edges[rev_id] = {
                            'id': rev_id,
                            'kind': 'local',
                            'cityId': cid,
                            'fromId': b_id,
                            'toId': a_id,
                            'length': self.edges[fwd_id]['length'],
                            'start': {'x': b['worldX'], 'z': b['worldZ']},
                            'end': {'x': a['worldX'], 'z': a['worldZ']},
                        }

            # Gateway ↔ boundary intersection edges
            for gw in city.get('gateways', []):
                gw_id = f"{cid}:{gw['id']}"
                target_local = gw.get('connectTo')
                if not target_local:
                    continue
                int_id = f"{cid}:{target_local}"
                if int_id not in self.nodes:
                    continue
                gw_node = self.nodes[gw_id]
                int_node = self.nodes[int_id]
                length = math.hypot(
                    int_node['worldX'] - gw_node['worldX'],
                    int_node['worldZ'] - gw_node['worldZ'],
                ) or 1.0

                # gateway → boundary intersection (entering the city)
                a_id = f"{gw_id}>{int_id}"
                self.edges[a_id] = {
                    'id': a_id,
                    'kind': 'ramp',
                    'cityId': cid,
                    'fromId': gw_id,
                    'toId': int_id,
                    'length': length,
                    'start': {'x': gw_node['worldX'], 'z': gw_node['worldZ']},
                    'end': {'x': int_node['worldX'], 'z': int_node['worldZ']},
                }
                # boundary intersection → gateway (leaving the city)
                b_id = f"{int_id}>{gw_id}"
                self.edges[b_id] = {
                    'id': b_id,
                    'kind': 'ramp',
                    'cityId': cid,
                    'fromId': int_id,
                    'toId': gw_id,
                    'length': length,
                    'start': {'x': int_node['worldX'], 'z': int_node['worldZ']},
                    'end': {'x': gw_node['worldX'], 'z': gw_node['worldZ']},
                }

    # ---------------------------------------------------------------------
    # Highway edges — prefix gateway ids with their city id
    # ---------------------------------------------------------------------
    def _register_highway_edges(self, highway_edges: Dict[str, dict]) -> None:
        for eid, edge in highway_edges.items():
            # edge['fromId']/['toId'] are raw gateway ids (e.g. GW_ALPHA_E)
            # we need to map them to world ids city:gateway
            from_city = self._city_for_gateway(edge['fromId'])
            to_city = self._city_for_gateway(edge['toId'])
            if not from_city or not to_city:
                continue
            world_from = f"{from_city}:{edge['fromId']}"
            world_to = f"{to_city}:{edge['toId']}"

            self.edges[eid] = {
                **edge,
                'fromId': world_from,
                'toId': world_to,
                'start': {'x': edge['start']['x'], 'z': edge['start']['z']},
                'end': {'x': edge['end']['x'], 'z': edge['end']['z']},
            }

    def _city_for_gateway(self, gateway_id: str) -> Optional[str]:
        for city in self.world['cities']:
            for gw in city.get('gateways', []):
                if gw['id'] == gateway_id:
                    return city['id']
        return None

    # ---------------------------------------------------------------------
    # Adjacency
    # ---------------------------------------------------------------------
    def _build_adjacency(self) -> None:
        for eid, edge in self.edges.items():
            self.adj.setdefault(edge['fromId'], []).append(eid)

    # ---------------------------------------------------------------------
    # Lookup
    # ---------------------------------------------------------------------
    def outgoing_edges(self, node_id: str) -> List[dict]:
        return [self.edges[eid] for eid in self.adj.get(node_id, [])]

    def neighbors(self, node_id: str) -> List[str]:
        return [self.edges[eid]['toId'] for eid in self.adj.get(node_id, [])]

    def edge(self, edge_id: str) -> Optional[dict]:
        return self.edges.get(edge_id)

    def node(self, node_id: str) -> Optional[dict]:
        return self.nodes.get(node_id)


# ---------------------------------------------------------------------------
# Pathfinding (A* over the world graph)
# ---------------------------------------------------------------------------
def _heuristic(a: dict, b: dict) -> float:
    return math.hypot(a['worldX'] - b['worldX'], a['worldZ'] - b['worldZ'])


def shortest_path(graph: WorldGraph, start: str, goal: str) -> List[str]:
    """
    Return a list of edge ids from start node to goal node using A*.
    Empty list if no path exists.
    """
    import heapq

    if start not in graph.nodes or goal not in graph.nodes:
        return []

    open_set: List[Tuple[float, str]] = []
    heapq.heappush(open_set, (0.0, start))
    came_from: Dict[str, Optional[str]] = {start: None}
    g_score: Dict[str, float] = {start: 0.0}

    while open_set:
        _, current = heapq.heappop(open_set)

        if current == goal:
            # reconstruct edge ids
            path: List[str] = []
            node = current
            while came_from[node] is not None:
                prev_node, edge_id = came_from[node]
                path.append(edge_id)
                node = prev_node
            path.reverse()
            return path

        for eid in graph.adj.get(current, []):
            edge = graph.edges[eid]
            neighbor = edge['toId']
            tentative = g_score[current] + edge['length']

            if tentative < g_score.get(neighbor, float('inf')):
                came_from[neighbor] = (current, eid)
                g_score[neighbor] = tentative
                f = tentative + _heuristic(graph.nodes[neighbor], graph.nodes[goal])
                heapq.heappush(open_set, (f, neighbor))

    return []


# ---------------------------------------------------------------------------
# Route selection helpers
# ---------------------------------------------------------------------------
def random_destination_node(graph: WorldGraph, exclude_city: Optional[str] = None) -> str:
    """Pick a random intersection node, optionally excluding one city."""
    import random
    candidates = [
        nid for nid, n in graph.nodes.items()
        if n['kind'] == 'intersection' and (exclude_city is None or n['cityId'] != exclude_city)
    ]
    return random.choice(candidates)


def route_between(
    graph: WorldGraph,
    start_node_id: str,
    goal_node_id: str,
) -> List[str]:
    """Wrapper: A* route between two nodes, returns list of edge ids."""
    return shortest_path(graph, start_node_id, goal_node_id)


# ---------------------------------------------------------------------------
# Convenience builders
# ---------------------------------------------------------------------------
def build_world_graph(world: dict, highway_edges: Dict[str, dict]) -> WorldGraph:
    return WorldGraph(world, highway_edges)