# backend/intelligence/allocation.py
# ---------------------------------------------------------------------------
# Assign the nearest available asset to a patient.
#
# "Available" means status is in the allowed set (idle / patrolling). Assets
# already responding to another patient are skipped, so we don't double-book.
# ---------------------------------------------------------------------------

from __future__ import annotations

from typing import Iterable, Optional, Sequence

from backend.simulation.patient import Patient


def assign_nearest(
    assets: Sequence,
    patient: Patient,
    require_status: Iterable[str] = ('idle', 'patrolling'),
) -> Optional[object]:
    """
    Return the nearest asset in an allowed state, or None.

    Assumes each asset exposes:
      • .lat, .lon
      • .status
      • .distance_to(lat, lon) → metres
    """
    allowed = set(require_status)

    best = None
    best_d = float('inf')

    for a in assets:
        if getattr(a, 'status', None) not in allowed:
            continue
        d = a.distance_to(patient.lat, patient.lon)
        if d < best_d:
            best_d = d
            best = a

    return best