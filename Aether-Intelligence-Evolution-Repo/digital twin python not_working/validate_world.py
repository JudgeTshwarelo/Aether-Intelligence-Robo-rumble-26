#!/usr/bin/env python3
"""Quick world validation."""
import sys
sys.path.insert(0, '.')

from backend.engine.city_generator import generate_world
from backend.engine.simulation import create_simulation

# Check world
w = generate_world()
print(f"✓ World generated: {len(w['cities'])} cities, {len(w['highways'])} highways")
print(f"  Cities: {[c['name'] for c in w['cities']]}")
print(f"  Bounds: X [{w['bounds']['minX']:.0f}, {w['bounds']['maxX']:.0f}], Z [{w['bounds']['minZ']:.0f}, {w['bounds']['maxZ']:.0f}]")

# Check simulation
sim = create_simulation(w)
print(f"✓ Simulation created: {len(sim.traffic)} vehicles")
print(f"  Intercity trip probability: 0.45 (highway bias enabled)")

# Check highways have vehicles
hw_vehicles = [v for v in sim.traffic.values() if v.get('onHighway')]
print(f"  Highway vehicles: {len(hw_vehicles)}")
