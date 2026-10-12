# backend/intelligence/detection.py
# ---------------------------------------------------------------------------
# Turn a patient's vitals into a priority level. This is intentionally simple
# and readable — a rule-based triage that a judge can verify by eye. Machine
# learning belongs here only if it earns its keep.
#
# Rules are based on START triage, adapted for wearable sensor data:
#   • HR   > 130 or < 40           → critical indicator
#   • SpO2 < 85                    → critical indicator
#   • SpO2 85–90                   → urgent indicator
#   • unconscious                  → critical, always
#   • HR 110–130 or SpO2 90–94     → urgent indicator
#
# Two critical indicators → CRITICAL
# One critical indicator  → CRITICAL
# Only urgent indicators  → URGENT
# No indicators           → STABLE
# ---------------------------------------------------------------------------

from __future__ import annotations

from backend.simulation.patient import (
    Patient,
    PRIORITY_CRITICAL,
    PRIORITY_URGENT,
    PRIORITY_STABLE,
    PRIORITY_UNKNOWN,
)


def analyse_patient(patient: Patient) -> str:
    """
    Return one of PRIORITY_CRITICAL / PRIORITY_URGENT /
    PRIORITY_STABLE / PRIORITY_UNKNOWN.

    Unknown = we have no vitals at all and cannot form an opinion. The
    frontend handles this gracefully.
    """
    v = patient.vitals or {}
    if not v:
        return PRIORITY_UNKNOWN

    critical_count = 0
    urgent_count   = 0

    # ---- Heart rate -----------------------------------------------------
    hr = patient.heart_rate
    if hr is not None:
        if hr > 130 or hr < 40:
            critical_count += 1
        elif hr > 110 or hr < 50:
            urgent_count += 1

    # ---- SpO2 -----------------------------------------------------------
    spo2 = patient.spo2
    if spo2 is not None:
        if spo2 < 85:
            critical_count += 1
        elif spo2 < 91:
            urgent_count += 1
        elif spo2 < 95:
            urgent_count += 1

    # ---- Consciousness --------------------------------------------------
    conscious = patient.conscious
    if conscious is False:
        critical_count += 1

    # ---- Any explicit 'critical' flag from the wearable -----------------
    if v.get('critical') is True:
        critical_count += 1

    # ---- Decision -------------------------------------------------------
    if critical_count >= 1:
        return PRIORITY_CRITICAL
    if urgent_count >= 1:
        return PRIORITY_URGENT
    return PRIORITY_STABLE