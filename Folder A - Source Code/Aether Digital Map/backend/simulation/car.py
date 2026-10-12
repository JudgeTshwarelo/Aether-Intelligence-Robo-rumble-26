# backend/simulation/car.py
# ---------------------------------------------------------------------------
# A single car driving on the road network.
#
# Motion model: the Intelligent Driver Model (IDM). It's the standard
# microscopic traffic model used in both academic work and production
# simulators (SUMO, Vissim). It produces realistic acceleration, braking,
# and jam formation from four parameters:
#
#   v0   desired speed (m/s)          — the car's own target
#   T    safe time gap (s)            — how far behind a leader it wants to be
#   a    maximum acceleration (m/s²)  — how fast it can speed up
#   b    comfortable deceleration     — how hard it brakes normally
#
# For each car, every step:
#   • find the gap and closing speed to the nearest car ahead on the same
#     edge OR the same successor edge (lookahead across intersections)
#   • compute desired acceleration
#   • integrate velocity and position
#   • when the car passes the end of an edge, transition to the next edge
#     via the road graph, picking a legal turn
#
# Intersection handling: cars slow as they approach, and the traffic system
# enforces a reservation window — only one car occupies an intersection at
# a time. This produces queuing behaviour without any explicit light logic.
# ---------------------------------------------------------------------------

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple


# ---------------------------------------------------------------------------
# IDM parameters — standard values from the literature
# ---------------------------------------------------------------------------
IDM_TIME_GAP       = 1.4       # seconds
IDM_MAX_ACCEL      = 1.6       # m/s²
IDM_COMFORT_BRAKE  = 2.0       # m/s²
IDM_MIN_GAP        = 2.0       # metres of bumper-to-bumper standstill gap
IDM_LOOKAHEAD      = 60.0      # metres ahead we scan for leaders

# Intersection behaviour
INTERSECTION_SLOW_RADIUS = 25.0   # slow down when this close
INTERSECTION_MIN_SPEED   = 3.0    # crawl speed inside an intersection

# Visual / behavioural variety
SPEED_VARIANCE_LO = 0.85
SPEED_VARIANCE_HI = 1.15
HESITATION_CHANCE_PER_SEC = 0.06
HESITATION_DURATION_RANGE = (0.8, 2.0)
HESITATION_SPEED_FACTOR   = 0.55

# Car geometry
CAR_LENGTH = 4.3
CAR_WIDTH  = 1.9


# ---------------------------------------------------------------------------
# Car
# ---------------------------------------------------------------------------
@dataclass
class Car:
    id: str
    edge_id: str
    position_m: float       # metres along the current edge
    speed_ms: float = 0.0
    desired_speed_ms: float = 12.0
    heading: float = 0.0

    # IDM state
    accel_ms2: float = 0.0

    # Which physical car this is
    length_m: float = CAR_LENGTH
    width_m:  float = CAR_WIDTH
    color:    str   = '#8899aa'

    # Attention / behaviour state
    hesitation_until: float = 0.0    # unix seconds at which hesitation ends
    next_hesitation_check: float = 0.0

    # Emergency response flag — set by the traffic system when an ambulance
    # is near. The frontend reads this to render the lateral pull-aside.
    emergency_nearby: bool = False

    # Cached position derived from (edge_id, position_m)
    lat: float = 0.0
    lon: float = 0.0

    # -----------------------------------------------------------------------
    # Per-step update
    # -----------------------------------------------------------------------

    def step(
        self,
        dt: float,
        network,                       # RoadNetwork
        leader_gap_m: Optional[float],
        leader_speed_ms: Optional[float],
        near_intersection: bool,
        can_enter_intersection: bool,
        now_s: float,
    ) -> None:
        """Advance one tick. Caller pre-computes leader and intersection info."""
        # ---- Hesitation logic -------------------------------------------
        # Every few seconds, a car slows down briefly. Feels human.
        if now_s >= self.next_hesitation_check:
            self.next_hesitation_check = now_s + random.uniform(5.0, 15.0)
            if random.random() < HESITATION_CHANCE_PER_SEC * 15.0:
                duration = random.uniform(*HESITATION_DURATION_RANGE)
                self.hesitation_until = now_s + duration

        effective_desired = self.desired_speed_ms
        if now_s < self.hesitation_until:
            effective_desired *= HESITATION_SPEED_FACTOR

        # Slow near intersections unless we've been granted the right to enter.
        if near_intersection and not can_enter_intersection:
            effective_desired = min(effective_desired, INTERSECTION_MIN_SPEED)

        # ---- IDM acceleration ------------------------------------------
        accel = self._idm_accel(
            v=self.speed_ms,
            v0=effective_desired,
            gap=leader_gap_m,
            leader_v=leader_speed_ms,
        )
        self.accel_ms2 = accel

        # ---- Integrate --------------------------------------------------
        self.speed_ms = max(0.0, self.speed_ms + accel * dt)
        self.position_m += self.speed_ms * dt

    def _idm_accel(
        self,
        v: float,
        v0: float,
        gap: Optional[float],
        leader_v: Optional[float],
    ) -> float:
        """
        The Intelligent Driver Model acceleration.

        Free-flow term:    a * (1 - (v/v0)^4)
        Interaction term:  -a * (s* / gap)^2     where s* is desired gap
        """
        a = IDM_MAX_ACCEL
        b = IDM_COMFORT_BRAKE

        free = a * (1.0 - (v / max(v0, 0.1)) ** 4)

        if gap is None:
            return free

        # Desired dynamic gap.
        dv = v - (leader_v if leader_v is not None else 0.0)
        s_star = IDM_MIN_GAP + max(
            0.0,
            v * IDM_TIME_GAP + (v * dv) / (2.0 * math.sqrt(a * b))
        )

        if gap <= 0.1:
            return -b * 4.0   # hard brake, prevents overlap

        interaction = -a * (s_star / gap) ** 2
        return free + interaction

    # -----------------------------------------------------------------------
    # Position derivation
    # -----------------------------------------------------------------------

    def update_lat_lon(self, network) -> None:
        """Recompute lat/lon from edge + position along edge."""
        edge = network.edge(self.edge_id)
        if edge is None:
            return
        a = network.node(edge.from_id)
        b = network.node(edge.to_id)
        if a is None or b is None:
            return

        if edge.length_m <= 0:
            t = 0.0
        else:
            t = min(1.0, max(0.0, self.position_m / edge.length_m))

        self.lat = a.lat + (b.lat - a.lat) * t
        self.lon = a.lon + (b.lon - a.lon) * t

        # Heading: bearing from a to b, in radians, clockwise from north.
        dx = (b.lon - a.lon) * math.cos(math.radians(a.lat))
        dz = (b.lat - a.lat)
        if abs(dx) + abs(dz) > 1e-12:
            self.heading = math.atan2(dx, dz)

    # -----------------------------------------------------------------------
    # Serialisation
    # -----------------------------------------------------------------------

    def to_dict(self, kind: str = 'car') -> Dict[str, Any]:
        return {
            'kind':             kind,
            'id':               self.id,
            'lat':              round(self.lat, 6),
            'lon':              round(self.lon, 6),
            'heading':          round(self.heading, 4),
            'speed':            round(self.speed_ms, 2),
            'status':           'moving' if self.speed_ms > 0.5 else 'stopped',
            'color':            self.color,
            'emergency_nearby': self.emergency_nearby,
        }