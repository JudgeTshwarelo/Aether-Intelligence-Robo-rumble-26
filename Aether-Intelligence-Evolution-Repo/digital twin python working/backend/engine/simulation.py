# backend/engine/simulation.py
# AETHER / SKYNET — traffic simulation engine (multi-city world).
# Route-driven vehicles, city-aware spawning, highway handling, IDM following.

from __future__ import annotations

import math
import random
from typing import Dict, List, Optional, Tuple

from backend.engine.city_generator import (
    generate_world,
    GRID,
    ROAD_WIDTH,
    LANE_WIDTH,
    LANE_COUNT,
    HIGHWAY_LANE_WIDTH,
)
from backend.engine.highways import (
    build_highway_edges,
    edge_position as highway_edge_position,
    highway_lane_offset,
)
from backend.engine.intersections import (
    build_world_graph,
    shortest_path,
    random_destination_node,
)
from backend.engine.pathfinding import axis_of

# ---------------------------------------------------------------------------
# Simulation constants
# ---------------------------------------------------------------------------
LIGHT_CYCLE    = 7.0
LIGHT_YELLOW   = 1.2
LIGHT_ALL_RED  = 0.4

STOP_DIST      = 6.0
SAFE_GAP       = 8.0
MIN_GAP        = 3.2
ACCEL          = 2.5
DECEL          = 4.0

LANE_OFFSET    = LANE_WIDTH

# Highway overrides
HIGHWAY_MIN_GAP   = 6.0
HIGHWAY_SAFE_GAP  = 14.0
HIGHWAY_TIME_HEADWAY = 1.4

# Inter-city trip logic
INTERCITY_PROB   = 0.25    # chance a new trip targets another city
DESPAWN_MARGIN   = 4.0     # distance past a gateway to despawn

# ---------------------------------------------------------------------------
# Vehicle classes (unchanged)
# ---------------------------------------------------------------------------
VEHICLE_CLASSES = {
    'car': {
        'length': 4.3, 'width': 2.1, 'height': 0.85,
        'desiredSpeed': (18, 46),
        'accel': 2.5, 'decel': 4.0,
        'weight': 0.70,
        'colors': ['#e8eef5', '#c9d6e8', '#8aa0c0', '#d8dee8', '#6f86b3', '#b9c6db'],
    },
    'van': {
        'length': 5.2, 'width': 2.2, 'height': 1.6,
        'desiredSpeed': (14, 34),
        'accel': 2.0, 'decel': 3.6,
        'weight': 0.12,
        'colors': ['#cdd8e6', '#8f9db4', '#b5c1d6'],
    },
    'bus': {
        'length': 11.0, 'width': 2.5, 'height': 2.6,
        'desiredSpeed': (10, 22),
        'accel': 1.5, 'decel': 3.0,
        'weight': 0.08,
        'colors': ['#3a7ad6', '#2e5fa8', '#4f8de0'],
    },
    'truck': {
        'length': 9.0, 'width': 2.4, 'height': 2.2,
        'desiredSpeed': (10, 24),
        'accel': 1.6, 'decel': 3.2,
        'weight': 0.06,
        'colors': ['#8a7a5c', '#6f5a3a', '#a08c66'],
    },
    'emergency': {
        'length': 5.4, 'width': 2.2, 'height': 1.7,
        'desiredSpeed': (30, 60),
        'accel': 4.0, 'decel': 6.0,
        'weight': 0.04,
        'colors': ['#ff3b3b', '#ff6a3b', '#ffd93b'],
    },
}

def weighted_class() -> str:
    r = random.random()
    acc = 0.0
    for name, spec in VEHICLE_CLASSES.items():
        acc += spec['weight']
        if r <= acc:
            return name
    return 'car'

# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
class SimulationEngine:
    def __init__(self) -> None:
        self.world = generate_world()
        self.highway_edges = build_highway_edges(self.world['highways'])
        self.graph = build_world_graph(self.world, self.highway_edges)

        self.vehicles: List[dict] = []
        self.pedestrians: List[dict] = []
        self.time = 0.0

        self.spawn_count = 0
        self.despawn_count = 0

    # ---------------------------------------------------------------------
    # Spawning
    # ---------------------------------------------------------------------
    def spawn_vehicles(self, n: int) -> None:
        for _ in range(n):
            self.spawn_count += 1
            vid = f'CAR_{str(self.spawn_count).zfill(3)}'
            v = spawn_vehicle(self.graph, self.world, vid)
            if v is not None:
                self.vehicles.append(v)

    def spawn_pedestrians(self, n: int) -> None:
        if self.pedestrians:
            return
        for i in range(n):
            self.pedestrians.append(spawn_pedestrian(self.world, f'PED_{str(i + 1).zfill(3)}'))

    # ---------------------------------------------------------------------
    # Update
    # ---------------------------------------------------------------------
    def update(self, dt: float) -> None:
        if dt <= 0:
            return
        self.time += dt

        # local signals only (highways have no lights)
        for city in self.world['cities']:
            update_signals(city, dt)

        update_traffic(self.graph, self.highway_edges, self.vehicles, dt)
        update_pedestrians(self.world, self.pedestrians, self.vehicles, dt)

        # despawn + respawn to keep density stable
        self._cull_and_refill()

    def _cull_and_refill(self) -> None:
        alive = [v for v in self.vehicles if not v.get('_despawn', False)]
        removed = len(self.vehicles) - len(alive)
        if removed:
            self.despawn_count += removed
        self.vehicles = alive

        # target density: keep constant
        target = 60
        if len(self.vehicles) < target:
            to_add = min(3, target - len(self.vehicles))
            for _ in range(to_add):
                self.spawn_count += 1
                vid = f'CAR_{str(self.spawn_count).zfill(3)}'
                v = spawn_vehicle(self.graph, self.world, vid)
                if v is not None:
                    self.vehicles.append(v)

    def get_vehicle(self, vehicle_id: str) -> Optional[dict]:
        for v in self.vehicles:
            if v['id'] == vehicle_id:
                return v
        return None


# ---------------------------------------------------------------------------
# Node / edge helpers
# ---------------------------------------------------------------------------
def edge_key(from_id: str, to_id: str) -> str:
    return f'{from_id}>{to_id}'


def _edge_lookup(graph, from_id: str, to_id: str) -> Optional[dict]:
    return graph.edge(edge_key(from_id, to_id))

# ---------------------------------------------------------------------------
# Signal phase machine (per-city)
# ---------------------------------------------------------------------------
def update_signals(city: dict, dt: float) -> None:
    for node in city['intersections']:
        light = node['light']
        light['timer'] += dt

        cycle = light.get('cycle', LIGHT_CYCLE)
        yellow = light.get('yellow', LIGHT_YELLOW)
        all_red = light.get('allRed', LIGHT_ALL_RED)

        phase_total = cycle + yellow + all_red
        t = light['timer'] % (2 * phase_total)

        if t < cycle:
            new_state = 'ns'
        elif t < cycle + yellow:
            new_state = 'ns-yellow'
        elif t < cycle + yellow + all_red:
            new_state = 'all-red'
        elif t < 2 * cycle + yellow + all_red:
            new_state = 'ew'
        elif t < 2 * cycle + 2 * yellow + all_red:
            new_state = 'ew-yellow'
        else:
            new_state = 'all-red'

        light['state'] = new_state


# ---------------------------------------------------------------------------
# Geometry — position on an edge
# ---------------------------------------------------------------------------
def _position_on_edge(edge: dict, progress: float, lane: int, is_highway: bool) -> Tuple[float, float, float]:
    """
    Return (x, z, heading) for a vehicle at `progress` along an edge.
    Handles both local and highway edges (they share the same shape).
    """
    sx, sz = edge['start']['x'], edge['start']['z']
    ex, ez = edge['end']['x'], edge['end']['z']

    dx = ex - sx
    dz = ez - sz
    length = math.hypot(dx, dz) or 1
    nx = dx / length
    nz = dz / length

    # right-hand perpendicular
    rx = nz
    rz = -nx

    if is_highway:
        offset = highway_lane_offset(lane, edge)
    else:
        # local roads: lane 0 = outer, 1 = inner
        offset = lane * LANE_WIDTH + LANE_WIDTH * 0.5

    t = max(0.0, min(1.0, progress))
    x = sx + dx * t + rx * offset
    z = sz + dz * t + rz * offset
    heading = math.atan2(nx, nz)
    return x, z, heading


# ---------------------------------------------------------------------------
# Vehicle transform
# ---------------------------------------------------------------------------
def vehicle_transform(graph, vehicle: dict) -> dict:
    edge = graph.edge(edge_key(vehicle['fromId'], vehicle['toId']))
    if edge is None:
        # fallback: hold position
        return {'x': vehicle['position']['x'], 'z': vehicle['position']['z'], 'heading': vehicle['heading']}

    is_highway = edge.get('kind') == 'highway'
    x, z, heading = _position_on_edge(edge, vehicle['progress'], vehicle.get('lane', 0), is_highway)
    return {'x': x, 'z': z, 'heading': heading}


# ---------------------------------------------------------------------------
# Route management
# ---------------------------------------------------------------------------
def _assign_new_route(graph, world, vehicle: dict, current_city: Optional[str] = None) -> None:
    """
    Set vehicle's `route` (list of edge ids) and current from/to to the first edge.
    Picks a random destination, biased toward another city sometimes.
    """
    # current node — where the vehicle is now
    current_node = vehicle['toId'] if 'toId' in vehicle else None
    if current_node is None:
        return

    # choose destination
    from_city = vehicle.get('cityId', current_city)
    if random.random() < INTERCITY_PROB and from_city:
        dest_node = random_destination_node(graph, exclude_city=from_city)
    else:
        dest_node = random_destination_node(graph, exclude_city=None)

    path_edges = shortest_path(graph, current_node, dest_node)
    if not path_edges:
        # fallback: pick any single outgoing edge
        out = graph.outgoing_edges(current_node)
        if out:
            vehicle['route'] = [random.choice(out)['id']]
        else:
            vehicle['route'] = []
        return

    vehicle['route'] = list(path_edges)
    vehicle['routeIndex'] = 0
    vehicle['destinationNode'] = dest_node


def _advance_route(graph, vehicle: dict) -> bool:
    """
    Move to the next edge in the route. Returns True if advanced, False if route exhausted.
    """
    route = vehicle.get('route', [])
    idx = vehicle.get('routeIndex', 0)

    if idx >= len(route):
        return False

    edge = graph.edge(route[idx])
    if edge is None:
        return False

    vehicle['fromId'] = edge['fromId']
    vehicle['toId'] = edge['toId']
    vehicle['routeIndex'] = idx + 1
    return True


# ---------------------------------------------------------------------------
# Traffic update
# ---------------------------------------------------------------------------
def update_traffic(graph, highway_edges: Dict[str, dict], vehicles: List[dict], dt: float) -> None:
    # group by edge for leader lookup
    by_edge: Dict[str, List[dict]] = {}
    for v in vehicles:
        by_edge.setdefault(edge_key(v['fromId'], v['toId']), []).append(v)
    for key in by_edge:
        by_edge[key].sort(key=lambda v: v['progress'])

    # emergency positions cached for O(1) proximity checks
    emergency_positions = [
        (v['position']['x'], v['position']['z'])
        for v in vehicles
        if v['type'] == 'emergency'
    ]

    for vehicle in vehicles:
        if vehicle.get('_despawn'):
            continue

        edge = graph.edge(edge_key(vehicle['fromId'], vehicle['toId']))
        if edge is None:
            continue
        length = edge['length'] or 1
        is_highway = edge.get('kind') == 'highway'

        # ---- leader gap ----
        leader_progress = math.inf
        same_edge = by_edge.get(edge_key(vehicle['fromId'], vehicle['toId']), [])
        for other in same_edge:
            if other is vehicle:
                continue
            if other['progress'] > vehicle['progress'] and other['progress'] < leader_progress:
                leader_progress = other['progress']
                vehicle['leaderId'] = other['id']

        gap = (leader_progress - vehicle['progress']) * length if leader_progress != math.inf else math.inf
        remaining = (1.0 - vehicle['progress']) * length

        # ---- signal awareness (local roads only) ----
        signalized = False
        axis = 'ns'
        light_state = 'ns'
        if not is_highway:
            to_node = graph.node(vehicle['toId'])
            if to_node and to_node.get('kind') == 'intersection':
                signalized = to_node.get('signalized', False)
                # axis of travel — reuse city-local x/z
                from_node = graph.node(vehicle['fromId'])
                if from_node:
                    axis = 'ns' if from_node['worldX'] == to_node['worldX'] else 'ew'
                light_state = to_node['light']['state']

        if signalized:
            if axis == 'ns':
                green = light_state == 'ns'
                yellow = light_state == 'ns-yellow'
            else:
                green = light_state == 'ew'
                yellow = light_state == 'ew-yellow'
        else:
            green = True
            yellow = False

        must_stop = False
        if signalized:
            if not green and not yellow and remaining < STOP_DIST and remaining > 0.6:
                must_stop = True
            elif yellow and remaining < STOP_DIST * 0.6 and remaining > 0.6 and vehicle['speed'] > 8:
                must_stop = True

        # ---- emergency proximity ----
        emergency_near = False
        if vehicle['type'] != 'emergency':
            vx = vehicle['position']['x']
            vz = vehicle['position']['z']
            for ex, ez in emergency_positions:
                d2 = (ex - vx) ** 2 + (ez - vz) ** 2
                if d2 < 144:  # 12m
                    emergency_near = True
                    break

        # ---- IDM acceleration ----
        spec = VEHICLE_CLASSES[vehicle['type']]
        v0 = vehicle['desiredSpeed']
        a_max = spec['accel']
        b_comfort = spec['decel'] * 0.6

        accel_cmd = a_max * (1.0 - (vehicle['speed'] / max(v0, 0.1)) ** 4)

        if is_highway:
            min_gap = HIGHWAY_MIN_GAP
            safe_headway = HIGHWAY_TIME_HEADWAY
        else:
            min_gap = MIN_GAP
            safe_headway = 0.9

        if leader_progress != math.inf:
            desired_gap = min_gap + vehicle['speed'] * safe_headway
            g = max(0.5, gap)
            accel_cmd -= a_max * (desired_gap / g) ** 2

        if must_stop:
            stop_gap = max(0.5, remaining)
            accel_cmd -= a_max * (min_gap / stop_gap) ** 2

        if emergency_near:
            accel_cmd -= a_max * 0.4

        accel_cmd = max(-b_comfort * 3.0, min(a_max, accel_cmd))
        vehicle['speed'] = max(0.0, vehicle['speed'] + accel_cmd * dt)

        vehicle['progress'] += (vehicle['speed'] * dt) / length
        vehicle['status'] = 'stopped' if vehicle['speed'] < 0.5 else 'moving'

        # ---- edge transition ----
        if vehicle['progress'] >= 1.0:
            overflow = (vehicle['progress'] - 1.0) * length

            # advance route
            advanced = _advance_route(graph, vehicle)

            if not advanced:
                # route exhausted — try to assign a new route from here
                _assign_new_route(graph, None, vehicle)
                advanced = _advance_route(graph, vehicle)

            if not advanced:
                # can't route — despawn gracefully
                vehicle['_despawn'] = True
                continue

            new_edge = graph.edge(edge_key(vehicle['fromId'], vehicle['toId']))
            new_length = (new_edge['length'] if new_edge else 1) or 1
            vehicle['progress'] = overflow / new_length

            # re-roll desired speed occasionally (highways vary more)
            if random.random() < 0.05:
                lo, hi = spec['desiredSpeed']
                if is_highway:
                    # allow a bit more speed on highway
                    lo = max(lo, 30)
                    hi = max(hi, 55)
                vehicle['desiredSpeed'] = random.uniform(lo, hi)

            # lane choice: fast vehicles take inner lane on long edges
            if new_length > 20 and vehicle['desiredSpeed'] >= 26:
                vehicle['lane'] = 1
            else:
                vehicle['lane'] = 0

            # update city tag from the new edge
            if new_edge:
                vehicle['cityId'] = new_edge.get('cityId')

        # ---- final transform ----
        tf = vehicle_transform(graph, vehicle)
        vehicle['position']['x'] = tf['x']
        vehicle['position']['z'] = tf['z']
        vehicle['position']['y'] = 0
        vehicle['heading'] = tf['heading']


# ---------------------------------------------------------------------------
# Pedestrians
# ---------------------------------------------------------------------------
def spawn_pedestrian(world: dict, ped_id: str) -> dict:
    city = random.choice(world['cities'])
    ox, oz = city['origin']
    i = random.randint(0, GRID - 1)
    j = random.randint(0, GRID - 1)
    cx = ((i - GRID / 2) + 0.5) * 36
    cz = ((j - GRID / 2) + 0.5) * 36
    return {
        'id': ped_id,
        'cityId': city['id'],
        'position': {
            'x': ox + cx + random.uniform(-8, 8),
            'y': 0,
            'z': oz + cz + random.uniform(-8, 8),
        },
        'heading': random.uniform(0, math.tau),
        'speed': random.uniform(0.8, 1.6),
        'state': 'walking',
        'target': None,
    }


def update_pedestrians(world: dict, pedestrians: List[dict], vehicles: List[dict], dt: float) -> None:
    if not pedestrians:
        return
    for ped in pedestrians:
        near_vehicle = False
        px = ped['position']['x']
        pz = ped['position']['z']
        for v in vehicles:
            dx = v['position']['x'] - px
            dz = v['position']['z'] - pz
            if dx * dx + dz * dz < 36:
                near_vehicle = True
                break

        if near_vehicle:
            ped['state'] = 'waiting'
            continue

        ped['state'] = 'walking'
        ped['position']['x'] += math.cos(ped['heading']) * ped['speed'] * dt
        ped['position']['z'] += math.sin(ped['heading']) * ped['speed'] * dt

        if random.random() < 0.02:
            ped['heading'] += random.uniform(-math.pi / 3, math.pi / 3)


# ---------------------------------------------------------------------------
# Vehicle spawn
# ---------------------------------------------------------------------------
def spawn_vehicle(graph, world: dict, vehicle_id: str) -> Optional[dict]:
    """
    Spawn at a random node with a route to a random destination.
    Vehicles can spawn on a local intersection or a gateway.
    """
    # pick a starting node — 80% city interior, 20% gateway
    if random.random() < 0.8:
        start_node = random_destination_node(graph, exclude_city=None)
    else:
        # gateway spawn
        gateway_nodes = [nid for nid, n in graph.nodes.items() if n['kind'] == 'gateway']
        if not gateway_nodes:
            start_node = random_destination_node(graph, exclude_city=None)
        else:
            start_node = random.choice(gateway_nodes)

    if start_node is None:
        return None

    node = graph.node(start_node)
    if node is None:
        return None

    # choose destination (biased toward another city)
    from_city = node['cityId']
    if random.random() < INTERCITY_PROB:
        dest_node = random_destination_node(graph, exclude_city=from_city)
    else:
        dest_node = random_destination_node(graph, exclude_city=None)

    path_edges = shortest_path(graph, start_node, dest_node)
    if not path_edges:
        # fallback: single outgoing edge
        out = graph.outgoing_edges(start_node)
        if not out:
            return None
        path_edges = [random.choice(out)['id']]

    first_edge = graph.edge(path_edges[0])
    if first_edge is None:
        return None

    class_name = weighted_class()
    spec = VEHICLE_CLASSES[class_name]
    lo, hi = spec['desiredSpeed']
    desired_speed = random.uniform(lo, hi)

    # starting progress along first edge
    progress = 0.05 if first_edge['kind'] != 'highway' else 0.02

    vehicle = {
        'id': vehicle_id,
        'type': class_name,
        'class': class_name,
        'cityId': first_edge.get('cityId', from_city),
        'fromId': first_edge['fromId'],
        'toId': first_edge['toId'],
        'progress': progress,
        'speed': desired_speed * 0.6,
        'desiredSpeed': desired_speed,
        'position': {'x': 0.0, 'y': 0.0, 'z': 0.0},
        'heading': 0.0,
        'destination': f"Sector_{random.choice('ABCDEF')}",
        'destinationNode': dest_node,
        'route': list(path_edges),
        'routeIndex': 1,  # we already consumed edge 0
        'status': 'moving',
        'color': random.choice(spec['colors']),
        'lane': 0,
        'length': spec['length'],
        'width': spec['width'],
        'height': spec['height'],
        'leaderId': None,
    }

    tf = vehicle_transform(graph, vehicle)
    vehicle['position']['x'] = tf['x']
    vehicle['position']['z'] = tf['z']
    vehicle['heading'] = tf['heading']
    return vehicle