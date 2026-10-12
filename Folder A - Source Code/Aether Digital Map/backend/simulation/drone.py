# backend/simulation/drone.py
# ---------------------------------------------------------------------------
# A drone flies. It behaves like an ambulance at the simulation level, but
# it moves faster, it doesn't need roads, and it hovers at altitude rather
# than arriving at ground level.
# ---------------------------------------------------------------------------

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from backend.simulation.patient import Patient

# ---------------------------------------------------------------------------
# Tuning
# ---------------------------------------------------------------------------
CRUISE_SPEED_MS = 22.0       # faster than an ambulance
PATROL_SPEED_MS = 4.0
CRUISE_ALTITUDE = 45.0       # metres above ground en route
HOVER_ALTITUDE  = 18.0       # metres above ground when on scene
ARRIVE_RADIUS_M = 12.0
HOVER_RADIUS_M  = 20.0       # within this, start descending


# ---------------------------------------------------------------------------
# Drone
# ---------------------------------------------------------------------------
@dataclass
class Drone:
    id: str
    lat: float
    lon: float
    altitude: float = CRUISE_ALTITUDE
    status: str = 'patrolling'      # 'patrolling' | 'responding' | 'on_scene'
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

        if dist > HOVER_RADIUS_M:
            # En route, at cruise altitude.
            self._fly_toward(target.lat, target.lon, dt, CRUISE_SPEED_MS)
            self._descend_toward(CRUISE_ALTITUDE, dt, 8.0)
            self.status = 'responding'
        else:
            # On scene, hovering.
            self._descend_toward(HOVER_ALTITUDE, dt, 4.0)
            self.speed = 0.0
            self.status = 'on_scene'

            # Slow orbit above the patient, so the mesh doesn't look frozen.
            self._orbit(target.lat, target.lon, dt, radius_m=3.0, period_s=8.0)

    # -----------------------------------------------------------------------
    # Motion primitives
    # -----------------------------------------------------------------------

    def _fly_toward(self, lat: float, lon: float, dt: float, speed_ms: float) -> None:
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

    def _descend_toward(self, target_alt: float, dt: float, rate_ms: float) -> None:
        delta = target_alt - self.altitude
        step = min(abs(delta), rate_ms * dt) * (1 if delta >= 0 else -1)
        self.altitude += step

    def _orbit(self, lat: float, lon: float, dt: float, radius_m: float, period_s: float) -> None:
        """Move in a slow circle centred on (lat, lon)."""
        # Represent current position as (east, north) offset from the centre.
        east  = (self.lon - lon) * 111320.0 * math.cos(math.radians(self.lat))
        north = (self.lat - lat) * 110540.0
        angle = math.atan2(north, east)

        # Advance around the circle.
        angle += (2 * math.pi / period_s) * dt

        new_east  = math.cos(angle) * radius_m
        new_north = math.sin(angle) * radius_m

        self.lat = lat + new_north / 110540.0
        self.lon = lon + new_east / (111320.0 * math.cos(math.radians(self.lat)))
        self.heading = angle + math.pi / 2      # tangent to the circle

    # -----------------------------------------------------------------------
    # Distance / ETA
    # -----------------------------------------------------------------------

    def distance_to(self, lat: float, lon: float) -> float:
        return _haversine(self.lat, self.lon, lat, lon)

    def eta_to(self, patient: Patient) -> float:
        d = self.distance_to(patient.lat, patient.lon)
        return d / max(CRUISE_SPEED_MS, 0.1)

    def _delta_meters_to(self, lat: float, lon: float) -> tuple:
        north = (lat - self.lat) * 110540.0
        east  = (lon - self.lon) * 111320.0 * math.cos(math.radians(self.lat))
        return east, north

    # -----------------------------------------------------------------------
    # Serialisation
    # -----------------------------------------------------------------------

    def to_dict(self, kind: str = 'drone') -> Dict[str, Any]:
        return {
            'kind':     kind,
            'id':       self.id,
            'lat':      round(self.lat, 6),
            'lon':      round(self.lon, 6),
            'altitude': round(self.altitude, 2),
            'heading':  round(self.heading, 4),
            'speed':    round(self.speed, 2),
            'status':   self.status,
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