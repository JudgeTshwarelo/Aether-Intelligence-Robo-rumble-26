# backend/simulation/ambulance.py
# ---------------------------------------------------------------------------
# An ambulance is a ground vehicle. It behaves like a drone at the simulation
# level — same step(dt, patients) contract, same to_dict() shape — but it
# moves slower, respects roads conceptually (the traffic system handles the
# visual road-following on the frontend), and its altitude is always zero.
#
# The simulation doesn't path-find here. It just steers toward the target
# patient's GPS. Real road routing lives in pathfinding/ (A* on the road
# graph) — when that lands, swap _drive_toward() for a waypoint follower.
# ---------------------------------------------------------------------------

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from backend.simulation.patient import Patient

# ---------------------------------------------------------------------------
# Tuning
# ---------------------------------------------------------------------------
CRUISE_SPEED_MS  = 13.9        # ~50 km/h
EMERGENCY_SPEED_MS = 22.0      # ~80 km/h with lights
PATROL_SPEED_MS  = 6.0         # crawling around
ARRIVE_RADIUS_M  = 15.0        # close enough to be "on scene"


# ---------------------------------------------------------------------------
# Ambulance
# ---------------------------------------------------------------------------
@dataclass
class Ambulance:
    id: str
    lat: float
    lon: float
    status: str = 'patrolling'      # 'patrolling' | 'responding' | 'on_scene' | 'idle'
    task_patient: Optional[str] = None
    heading: float = 0.0
    speed: float = 0.0
    home_lat: Optional[float] = None
    home_lon: Optional[float] = None

    def __post_init__(self) -> None:
        if self.home_lat is None: self.home_lat = self.lat
        if self.home_lon is None: self.home_lon = self.lon

    # -----------------------------------------------------------------------
    # Per-step motion
    # -----------------------------------------------------------------------

    def step(self, dt: float, patients: Optional[Dict[str, Patient]] = None) -> None:
        target = None
        if self.task_patient and patients and self.task_patient in patients:
            target = patients[self.task_patient]

        if target is None:
            self._patrol(dt)
            return

        dist = self.distance_to(target.lat, target.lon)

        if dist > ARRIVE_RADIUS_M:
            self._drive_toward(target.lat, target.lon, dt, EMERGENCY_SPEED_MS)
            self.status = 'responding'
        else:
            self.speed = 0.0
            self.status = 'on_scene'

    # -----------------------------------------------------------------------
    # Motion primitives
    # -----------------------------------------------------------------------

    def _drive_toward(self, lat: float, lon: float, dt: float, speed_ms: float) -> None:
        dx, dz = self._delta_meters_to(lat, lon)
        dist = math.hypot(dx, dz)
        if dist < 0.001:
            self.speed = 0.0
            return

        self.heading = math.atan2(dx, dz)

        move = min(speed_ms * dt, dist)
        north = (dz / dist) * move
        east  = (dx / dist) * move

        self.lat += north / 110540.0
        self.lon += east  / (111320.0 * math.cos(math.radians(self.lat)))
        self.speed = speed_ms

    def _patrol(self, dt: float) -> None:
        drift = PATROL_SPEED_MS * dt
        north = math.cos(self.heading) * drift
        east  = math.sin(self.heading) * drift
        self.lat += north / 110540.0
        self.lon += east  / (111320.0 * math.cos(math.radians(self.lat)))
        self.speed = PATROL_SPEED_MS
        self.status = 'patrolling'

    # -----------------------------------------------------------------------
    # Distance / ETA
    # -----------------------------------------------------------------------

    def distance_to(self, lat: float, lon: float) -> float:
        return _haversine(self.lat, self.lon, lat, lon)

    def eta_to(self, patient: Patient) -> float:
        d = self.distance_to(patient.lat, patient.lon)
        return d / max(EMERGENCY_SPEED_MS, 0.1)

    def _delta_meters_to(self, lat: float, lon: float) -> tuple:
        north = (lat - self.lat) * 110540.0
        east  = (lon - self.lon) * 111320.0 * math.cos(math.radians(self.lat))
        return east, north

    # -----------------------------------------------------------------------
    # Serialisation
    # -----------------------------------------------------------------------

    def to_dict(self, kind: str = 'ambulance') -> Dict[str, Any]:
        return {
            'kind':    kind,
            'id':      self.id,
            'lat':     round(self.lat, 6),
            'lon':     round(self.lon, 6),
            'heading': round(self.heading, 4),
            'speed':   round(self.speed, 2),
            'status':  self.status,
        }


# ---------------------------------------------------------------------------
# Helpers
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