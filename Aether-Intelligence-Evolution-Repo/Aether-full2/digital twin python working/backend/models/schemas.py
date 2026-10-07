# backend/schemas.py
# Pydantic models for AETHER / SKYNET — multi-city world.

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------
class BuildingModel(BaseModel):
    id: str
    type: str
    zone: str
    position: List[float]
    width: float
    depth: float
    height: float
    floors: int
    status: str
    color: str
    rotation: float
    marker: Optional[str] = None
    block: Optional[List[int]] = None
    footprintArea: Optional[float] = None
    volume: Optional[float] = None

    units: Optional[int] = None
    balconies: Optional[bool] = None
    residents: Optional[int] = None
    occupancy: Optional[int] = None
    companyTier: Optional[str] = None
    shops: Optional[int] = None
    hazardLevel: Optional[str] = None
    service: Optional[bool] = None


# ---------------------------------------------------------------------------
# Roads & markings
# ---------------------------------------------------------------------------
class RoadModel(BaseModel):
    id: str
    axis: Literal['x', 'z']
    pos: float
    from_: float = Field(alias='from')
    to: float
    width: float
    lanes: int
    class_: Literal['major', 'minor'] = Field(alias='class')
    oneway: bool = False

    class Config:
        populate_by_name = True


class RoadMarkingModel(BaseModel):
    axis: Literal['x', 'z']
    fixed: float
    start: float
    end: float
    kind: Literal['dash', 'solid'] = 'dash'


class CrosswalkModel(BaseModel):
    id: str
    x: float
    z: float
    orientation: Literal['x', 'z']


# ---------------------------------------------------------------------------
# Intersections
# ---------------------------------------------------------------------------
class LightStateModel(BaseModel):
    state: str          # 'ns' | 'ew' | 'ns-yellow' | 'ew-yellow' | 'all-red'
    timer: float
    cycle: float = 7.0
    yellow: float = 1.2
    allRed: float = 0.4


class TurnPermissionsModel(BaseModel):
    ns: bool = True
    ew: bool = True
    left: bool = True
    right: bool = True
    uturn: bool = False


class IntersectionModel(BaseModel):
    id: str
    gridI: int
    gridJ: int
    x: float
    z: float
    signalized: bool = False
    light: LightStateModel
    turns: TurnPermissionsModel


# ---------------------------------------------------------------------------
# Gateways (city ↔ highway connection points)
# ---------------------------------------------------------------------------
class GatewayModel(BaseModel):
    id: str
    side: Literal['N', 'S', 'E', 'W']
    x: float
    z: float
    connectTo: Optional[str] = None


# ---------------------------------------------------------------------------
# Infrastructure
# ---------------------------------------------------------------------------
class InfrastructureModel(BaseModel):
    id: str
    type: str
    buildingId: str
    position: List[float]
    status: str
    coverage: Optional[float] = None


class StreetlightModel(BaseModel):
    id: str
    x: float
    z: float
    on: bool = True


class TrafficLightModel(BaseModel):
    id: str
    x: float
    z: float
    signalized: bool = False


class TreeModel(BaseModel):
    id: str
    x: float
    z: float
    scale: float


class HydrantModel(BaseModel):
    id: str
    x: float
    z: float


class BusStopModel(BaseModel):
    id: str
    x: float
    z: float


class BenchModel(BaseModel):
    id: str
    x: float
    z: float


# ---------------------------------------------------------------------------
# Zones
# ---------------------------------------------------------------------------
class ZoneRuleModel(BaseModel):
    office: float = 0.0
    commercial: float = 0.0
    apartment: float = 0.0
    residential: float = 0.0
    industrial: float = 0.0


# ---------------------------------------------------------------------------
# City
# ---------------------------------------------------------------------------
class CityMetaModel(BaseModel):
    BLOCK: float
    GRID: int
    ROAD_WIDTH: float
    LANE_COUNT: int
    LANE_WIDTH: float
    HALF: float
    size: float


class CityDataModel(BaseModel):
    id: str
    name: str
    origin: List[float]
    meta: CityMetaModel
    zones: Dict[str, ZoneRuleModel]
    zoneCounts: Dict[str, int]
    typeCounts: Dict[str, int]
    buildings: List[BuildingModel]
    roads: List[RoadModel]
    roadMarkings: List[RoadMarkingModel]
    crosswalks: List[CrosswalkModel]
    intersections: List[IntersectionModel]
    gateways: List[GatewayModel] = []
    streetlights: List[StreetlightModel]
    trafficLights: List[TrafficLightModel]
    trees: List[TreeModel]
    hydrants: List[HydrantModel]
    busStops: List[BusStopModel]
    benches: List[BenchModel]
    infrastructure: List[InfrastructureModel]


# ---------------------------------------------------------------------------
# Highways
# ---------------------------------------------------------------------------
class PylonModel(BaseModel):
    id: str
    x: float
    z: float
    heading: float


class RoadsideTreeModel(BaseModel):
    id: str
    x: float
    z: float
    scale: float


class HighwayPointModel(BaseModel):
    x: float
    z: float


class HighwayModel(BaseModel):
    id: str
    cities: List[str]
    fromGateway: str
    toGateway: str
    a: HighwayPointModel
    b: HighwayPointModel
    length: float
    heading: float
    width: float
    lanes: int
    laneWidth: float
    speedRange: List[float]
    pylons: List[PylonModel] = []
    roadsideTrees: List[RoadsideTreeModel] = []


# ---------------------------------------------------------------------------
# World
# ---------------------------------------------------------------------------
class WorldBoundsModel(BaseModel):
    minX: float
    maxX: float
    minZ: float
    maxZ: float
    centerX: float
    centerZ: float


class WorldMetaModel(BaseModel):
    CITY_SPACING: float
    HIGHWAY_WIDTH: float
    HIGHWAY_LANES: int
    HIGHWAY_LANE_WIDTH: float


class WorldModel(BaseModel):
    type: str = 'world'
    cities: List[CityDataModel]
    highways: List[HighwayModel]
    bounds: WorldBoundsModel
    meta: WorldMetaModel


# ---------------------------------------------------------------------------
# Vehicles
# ---------------------------------------------------------------------------
class VehicleModel(BaseModel):
    id: str
    type: str
    class_: Optional[str] = Field(default=None, alias='class')
    cityId: Optional[str] = None
    fromId: str
    toId: str
    progress: float
    speed: float
    desiredSpeed: float
    position: Dict[str, float]
    heading: float
    destination: str
    destinationNode: Optional[str] = None
    status: str
    color: str
    lane: Optional[int] = 0
    length: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    leaderId: Optional[str] = None
    route: Optional[List[str]] = None
    routeIndex: Optional[int] = None

    class Config:
        populate_by_name = True


# ---------------------------------------------------------------------------
# Pedestrians
# ---------------------------------------------------------------------------
class PedestrianModel(BaseModel):
    id: str
    cityId: Optional[str] = None
    position: Dict[str, float]
    heading: float
    speed: float
    state: str
    target: Optional[str] = None


# ---------------------------------------------------------------------------
# API responses
# ---------------------------------------------------------------------------
class HealthResponse(BaseModel):
    status: str = 'ok'
    name: str = 'AETHER / SKYNET'


class VehicleListResponse(BaseModel):
    vehicles: List[VehicleModel]


class PedestrianListResponse(BaseModel):
    pedestrians: List[PedestrianModel]


class ConnectionEvent(BaseModel):
    type: str
    message: str


class SimulationSnapshot(BaseModel):
    type: str = 'snapshot'
    world: WorldModel
    vehicles: List[VehicleModel]
    pedestrians: List[PedestrianModel]
    time: float


class StatsResponse(BaseModel):
    time: float
    vehicles: Dict[str, Any]
    pedestrians: int