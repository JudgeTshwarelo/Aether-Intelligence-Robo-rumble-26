# backend/simulation/patient.py
# ---------------------------------------------------------------------------
# A patient is the thing emergencies happen to. It carries a GPS location and
# a snapshot of wearable vitals. It knows nothing about the city, the fleet,
# or how to get anywhere — it's a data record with a bit of behaviour.
# ---------------------------------------------------------------------------

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


# Priority levels, ordered. Used by detection.py and by the frontend panel.
PRIORITY_CRITICAL = 'CRITICAL'
PRIORITY_URGENT   = 'URGENT'
PRIORITY_STABLE   = 'STABLE'
PRIORITY_UNKNOWN  = 'UNKNOWN'


def _new_id() -> str:
    """Short, sortable, human-readable id: PAT-XXXXX."""
    return 'PAT-' + uuid.uuid4().hex[:5].upper()


@dataclass
class Patient:
    """
    A single emergency.

    Fields:
      id          unique identifier, e.g. 'PAT-A1B2C'
      lat, lon    real-world GPS
      vitals      dict of wearable readings — may be empty
      priority    set by detection.analyse_patient(); starts UNKNOWN
      created_at  unix timestamp, for "how long has this been active"
      hospital    name of the destination hospital, if assigned
    """

    lat: float
    lon: float
    vitals: Dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=_new_id)
    priority: str = PRIORITY_UNKNOWN
    created_at: float = field(default_factory=time.time)
    hospital: Optional[str] = None

    # -----------------------------------------------------------------------
    # Derived properties
    # -----------------------------------------------------------------------

    @property
    def age_seconds(self) -> float:
        return time.time() - self.created_at

    @property
    def heart_rate(self) -> Optional[float]:
        return _first_number(self.vitals, ('heartRate', 'heart_rate', 'hr'))

    @property
    def spo2(self) -> Optional[float]:
        return _first_number(self.vitals, ('spo2', 'oxygen', 'SpO2', 'o2'))

    @property
    def conscious(self) -> Optional[bool]:
        for key in ('conscious', 'is_conscious', 'responsive'):
            if key in self.vitals:
                return bool(self.vitals[key])
        return None

    # -----------------------------------------------------------------------
    # Serialisation — the exact shape the frontend emergency panel reads
    # -----------------------------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        return {
            'id':       self.id,
            'lat':      self.lat,
            'lon':      self.lon,
            'vitals':   dict(self.vitals),
            'priority': self.priority,
            'age':      round(self.age_seconds, 1),
            'hospital': self.hospital,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _first_number(d: Dict[str, Any], keys: tuple) -> Optional[float]:
    """Return the first key in `keys` whose value coerces to a float."""
    for k in keys:
        if k in d:
            try:
                return float(d[k])
            except (TypeError, ValueError):
                continue
    return None