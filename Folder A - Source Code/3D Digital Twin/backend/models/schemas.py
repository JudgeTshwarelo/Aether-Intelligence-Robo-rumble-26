from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class BuildingModel(BaseModel):
    id: str
    type: str
    position: List[float]
    width: float
    depth: float
    height: float
    floors: int
    status: str
    color: str
    rotation: float
    marker: Optional[str] = None
    units: Optional[int] = None
    occupancy: Optional[int] = None


class RoadModel(BaseModel):
    axis: Literal['x', 'z']
    pos: float
    from_: float = Field(alias='from')
    to: float

    class Config:
        populate_by_name = True


class IntersectionModel(BaseModel):
    id: str
    gridI: int
    gridJ: int
    x: float
    z: float
    light: Dict[str, Any]


class InfrastructureModel(BaseModel):
    id: str
    type: str
    buildingId: str
    position: List[float]
    status: str


class CityMetaModel(BaseModel):
    BLOCK: float
    GRID: int
    ROAD_WIDTH: float
    HALF: float
    size: float


class CityDataModel(BaseModel):
    meta: CityMetaModel
    buildings: List[BuildingModel]
    roads: List[RoadModel]
    intersections: List[IntersectionModel]
    streetlights: List[Dict[str, Any]]
    trafficLights: List[Dict[str, Any]]
    trees: List[Dict[str, Any]]
    infrastructure: List[InfrastructureModel]


class VehicleModel(BaseModel):
    id: str
    type: str
    fromId: str
    toId: str
    progress: float
    speed: float
    desiredSpeed: float
    position: Dict[str, float]
    heading: float
    destination: str
    status: str
    color: str


class HealthResponse(BaseModel):
    status: str = 'ok'
    name: str = 'AETHER / SKYNET'


class VehicleListResponse(BaseModel):
    vehicles: List[VehicleModel]


class ConnectionEvent(BaseModel):
    type: str
    message: str


class SimulationSnapshot(BaseModel):
    type: str = 'snapshot'
    city: CityDataModel
    vehicles: List[VehicleModel]
    time: float
