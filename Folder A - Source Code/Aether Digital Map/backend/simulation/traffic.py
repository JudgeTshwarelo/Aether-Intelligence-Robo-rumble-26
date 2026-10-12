# backend/simulation/traffic.py
# ---------------------------------------------------------------------------
# Ambient traffic. Cars drive around the road network, ignoring emergencies
# (a real system would have them pull aside — that's a later feature).
#
# The traffic system is a thin wrapper around the road graph:
#   • spawn N cars at random edges
#   • advance each car along its edge
#   • when it reaches the end of an edge, pick a random outgoing edge
#
# Cars are serialised into the same 'assets' array as ambulances and drones,
# tagged kind='car', so the frontend uses one code path.
# ---------------------------------------------------------------------------

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from backend.geo.road_network import Edge, RoadNetwork


# ---------------------------------------------------------------------------
# Car
# ---------------------------------------------------------------------------
@dataclass
class Car:
    id: str
    edge_id: str
    t: float                # fraction along the edge, 0..1
    speed_ms: float
    heading: float = 0.0

    # Filled in by TrafficSystem each tick — cached for serialisation.
    lat: float = 0.0
    lon: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            'kind':    'car',
            'id':      self.id,
            'lat':     round(self.lat, 6),
            'lon':     round(self.lon, 6),
            'heading': round(self.heading, 4),
            'speed':   round(self.speed_ms, 2),
            'status':  'driving',
        }


# ---------------------------------------------------------------------------
# TrafficSystem
# ---------------------------------------------------------------------------
class TrafficSystem:
    """
    Owns a fleet of cars on a RoadNetwork. The system is a *consumer* of the
    road graph — it never mutates it, only reads edges and nodes.
    """

    def __init__(self, roads: RoadNetwork, count: int = 20) -> None:
        self.roads = roads
        self.cars: List[Car] = []

        if not roads.edges:
            print('[traffic] no edges to drive on — traffic disabled')
            return

        for i in range(count):
            self.cars.append(self._spawn_car(i))

    # -----------------------------------------------------------------------
    # Spawning
    # -----------------------------------------------------------------------

    def _spawn_car(self, index: int) -> Car:
        edge = self.roads.random_edge()
        return Car(
            id=f'CAR-{index:03d}',
            edge_id=edge.id,
            t=random.random(),
            speed_ms=edge.speed_ms * random.uniform(0.7, 1.1),
        )

    # -----------------------------------------------------------------------
    # Step
    # -----------------------------------------------------------------------

    def step(self, dt: float, ambulances: Optional[List] = None) -> None:
        """
        Advance every car along its current edge. When a car reaches the end
        of an edge (t >= 1), move it to a random outgoing edge from the
        terminal node.

        `ambulances` is accepted for future use — currently ignored. When
        pull-aside behaviour lands, it goes here.
        """
        if not self.cars:
            return

        for car in self.cars:
            edge = self.roads.edge(car.edge_id)
            if edge is None:
                # Edge vanished — reseat the car.
                new_edge = self.roads.random_edge()
                car.edge_id = new_edge.id
                car.t = 0.0
                continue

            # Advance along the edge.
            if edge.length_m > 0.001:
                car.t += (car.speed_ms * dt) / edge.length_m

            if car.t >= 1.0:
                self._transition(car, edge)

            # Update cached lat/lon/heading from edge + t.
            self._place_car(car)

    # -----------------------------------------------------------------------
    # Edge transitions
    # -----------------------------------------------------------------------

    def _transition(self, car: Car, edge: Edge) -> None:
        """Pick a random outgoing edge from the terminal node."""
        outgoing = self.roads.edges_from(edge.to_id)
        if not outgoing:
            # Dead-end. Reverse.
            reverse = self.roads.edge(f'e_{edge.to_id}_{edge.from_id}')
            if reverse is not None:
                car.edge_id = reverse.id
                car.t = 0.0
            else:
                new_edge = self.roads.random_edge()
                car.edge_id = new_edge.id
                car.t = 0.0
            return

        # Prefer straight-ahead (roughly matching heading), but allow turns.
        next_edge = random.choice(outgoing)
        car.edge_id = next_edge.id
        car.t = 0.0
        car.speed_ms = next_edge.speed_ms * random.uniform(0.7, 1.1)

    # -----------------------------------------------------------------------
    # Placement
    # -----------------------------------------------------------------------

    def _place_car(self, car: Car) -> None:
        edge = self.roads.edge(car.edge_id)
        if edge is None:
            return
        a = self.roads.node(edge.from_id)
        b = self.roads.node(edge.to_id)
        if a is None or b is None:
            return

        t = max(0.0, min(1.0, car.t))
        car.lat = a.lat + (b.lat - a.lat) * t
        car.lon = a.lon + (b.lon - a.lon) * t

        # Heading: bearing from a to b, in the same convention as the drones
        # and ambulances (atan2(east, north)).
        cos_lat = math.cos(math.radians(a.lat))
        east  = (b.lon - a.lon) * 111320.0 * cos_lat
        north = (b.lat - a.lat) * 110540.0
        car.heading = math.atan2(east, north)

    # -----------------------------------------------------------------------
    # Serialisation
    # -----------------------------------------------------------------------

    def to_frame(self) -> List[Dict[str, Any]]:
        return [c.to_dict() for c in self.cars]