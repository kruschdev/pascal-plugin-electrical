/**
 * Pure Agent Operations (`@kruschdev/pascal-plugin-electrical/agent-operations`).
 * Runs identically in Pascal's MCP server, detached scene runtime, or live editor tab
 * in a single undo step (`DECISIONS.md` E-016 & E-018).
 */

import type { AnyNode } from '@pascal-app/core'
import type { AgentContext, AgentOperations, SceneNodes } from '@pascal-app/core/agent-operations'
import { refuse } from '@pascal-app/core/agent-tools'
import { auditSceneElectrical } from './nec/audit'
import { calculateSceneLoad, type SceneNodeLike } from './nec/load-calc'
import {
  buildElectricalTakeoff,
  buildPanelSchedule,
  formatPanelScheduleCsv,
} from './nec/panel-schedule'
import { extractTradeObstacles, routeElectricalRun, type Vec3 } from './nec/routing'
import { calculateVoltageDrop } from './nec/sizing'
import {
  type ConduitTradeSize,
  type OccupancyType,
  type RacewayType,
  type VoltageSystem,
  type WireGauge,
  getVoltageLineToLine,
  getVoltageLineToNeutral,
  isThreePhaseSystem,
} from './nec/tables'

function asRecord(nodes: SceneNodes): Readonly<Record<string, SceneNodeLike>> {
  return nodes as unknown as Readonly<Record<string, SceneNodeLike>>
}

function resolveLevelId(nodes: SceneNodes, requested: string | undefined, ctx: AgentContext): string | null {
  if (requested && nodes[requested]) return requested
  if (ctx.activeLevelId && nodes[ctx.activeLevelId]) return ctx.activeLevelId
  for (const n of Object.values(nodes)) {
    if ((n as { type?: string }).type === 'level') return (n as { id: string }).id
  }
  return null
}

function deterministicId(prefix: string, nodes: SceneNodes): string {
  let idx = 1
  while (nodes[`${prefix}_${idx}`]) idx += 1
  return `${prefix}_${idx}`
}

export const electricalAgentOperations = {
  electrical_place_panel: (
    nodes: SceneNodes,
    input: {
      levelId?: string
      name?: string
      position: [number, number, number]
      rotation?: number
      occupancy?: OccupancyType
      voltageSystem?: VoltageSystem
      busRatingAmps?: number
      mainBreakerAmps?: number
      mainType?: 'main-breaker' | 'mlo'
      spaces?: number
      solarBackfeedAmps?: number
    },
    context: AgentContext,
  ) => {
    const parentId = resolveLevelId(nodes, input.levelId, context)
    const id = deterministicId('elecpanel', nodes)
    const occupancy: OccupancyType = input.occupancy ?? 'residential'
    const voltageSystem: VoltageSystem =
      input.voltageSystem ?? (occupancy === 'commercial' ? '120/208V-3P' : '120/240V-1P')
    const busRatingAmps = input.busRatingAmps ?? 200
    const mainBreakerAmps = input.mainBreakerAmps ?? busRatingAmps

    const node = {
      object: 'node',
      id,
      type: 'electrical:panel',
      name: input.name ?? 'MDP-1',
      parentId,
      visible: true,
      metadata: {},
      position: input.position,
      rotation: input.rotation ?? 0,
      occupancy,
      voltageSystem,
      busRatingAmps,
      mainBreakerAmps,
      mainType: input.mainType ?? 'main-breaker',
      spaces: input.spaces ?? (occupancy === 'commercial' ? 42 : 40),
      nemaRating: 'NEMA-1',
      condition110_26: 2,
      solarBackfeedAmps: input.solarBackfeedAmps ?? 0,
      showClearanceZone: true,
      width: occupancy === 'commercial' ? 0.51 : 0.38,
      depth: 0.14,
      height: occupancy === 'commercial' ? 1.2 : 0.92,
    } as unknown as AnyNode

    return {
      result: {
        panelId: id,
        name: input.name ?? 'MDP-1',
        occupancy,
        voltageSystem,
        busRatingAmps,
        levelId: parentId,
      },
      changes: { create: [{ node, parentId: parentId ?? undefined }] },
    }
  },

  electrical_place_device: (
    nodes: SceneNodes,
    input: {
      levelId?: string
      name?: string
      position: [number, number, number]
      rotation?: number
      deviceKind?: string
      occupancy?: OccupancyType
      panelId?: string
      circuitNumber?: number
      poles?: 1 | 2 | 3
      breakerAmps?: number
      loadVa?: number
      continuous?: boolean
      gfciProtected?: boolean
      afciProtected?: boolean
      boxType?: string
      wireGauge?: string
      conductorCount?: number
    },
    context: AgentContext,
  ) => {
    const parentId = resolveLevelId(nodes, input.levelId, context)
    if (input.panelId && !nodes[input.panelId]) {
      refuse('panel_not_found', `Electrical panel "${input.panelId}" does not exist in the scene.`)
    }
    const id = deterministicId('elecdev', nodes)
    const deviceKind = input.deviceKind ?? 'duplex'
    const node = {
      object: 'node',
      id,
      type: 'electrical:device',
      name: input.name ?? deviceKind,
      parentId,
      visible: true,
      metadata: {},
      position: input.position,
      rotation: input.rotation ?? 0,
      deviceKind,
      occupancy: input.occupancy ?? 'residential',
      panelId: input.panelId,
      circuitNumber: input.circuitNumber ?? 1,
      poles: input.poles ?? 1,
      breakerAmps: input.breakerAmps ?? 20,
      loadVa: input.loadVa ?? 180,
      continuous: input.continuous ?? false,
      isMotor: deviceKind === 'motor-load',
      gfciProtected: input.gfciProtected ?? deviceKind === 'gfci',
      afciProtected: input.afciProtected ?? deviceKind === 'afci',
      boxType: input.boxType ?? (deviceKind === 'junction-box' ? '4-sq-2.125' : 'single-gang-standard'),
      wireGauge: input.wireGauge ?? '12',
      conductorCount: input.conductorCount ?? 4,
      clampCount: 1,
      yokeCount: deviceKind === 'junction-box' ? 0 : 1,
    } as unknown as AnyNode

    return {
      result: {
        deviceId: id,
        deviceKind,
        panelId: input.panelId ?? null,
        circuitNumber: input.circuitNumber ?? 1,
        levelId: parentId,
      },
      changes: { create: [{ node, parentId: parentId ?? undefined }] },
    }
  },

  electrical_route_circuit: (
    nodes: SceneNodes,
    input: {
      panelId: string
      targetDeviceId: string
      name?: string
      occupancy?: OccupancyType
      racewayType?: RacewayType
      tradeSize?: ConduitTradeSize
      wireGauge?: WireGauge
      preferredChaseY?: number
      clearanceM?: number
    },
    context: AgentContext,
  ) => {
    const record = asRecord(nodes)
    const panel = record[input.panelId]
    if (!panel || panel.type !== 'electrical:panel') {
      refuse('panel_not_found', `Electrical panel "${input.panelId}" was not found.`)
    }
    const device = record[input.targetDeviceId]
    if (!device || device.type !== 'electrical:device') {
      refuse('device_not_found', `Electrical device "${input.targetDeviceId}" was not found.`)
    }

    const panelPos = (panel.position as Vec3) ?? [0, 1.52, 0]
    const panelHeight = typeof panel.height === 'number' ? panel.height : 0.92
    const startPt: Vec3 = [panelPos[0], panelPos[1] + panelHeight / 2, panelPos[2]]
    const endPt: Vec3 = (device.position as Vec3) ?? [2, 0.38, 0]

    const parentId =
      (typeof panel.parentId === 'string' ? panel.parentId : null) ??
      resolveLevelId(nodes, undefined, context)
    const obstacles = extractTradeObstacles(record, parentId)
    const route = routeElectricalRun(startPt, endPt, obstacles, {
      preferredChaseY: input.preferredChaseY ?? 2.55,
      clearanceM: input.clearanceM ?? 0.05,
    })

    const occupancy: OccupancyType =
      input.occupancy ?? (panel.occupancy === 'commercial' ? 'commercial' : 'residential')
    const racewayType: RacewayType =
      input.racewayType ?? (occupancy === 'commercial' ? 'emt' : 'nm-b')
    const voltageSystem: VoltageSystem =
      panel.voltageSystem === '120/208V-3P' || panel.voltageSystem === '277/480V-3P'
        ? panel.voltageSystem
        : '120/240V-1P'
    const poles: 1 | 2 | 3 = device.poles === 3 ? 3 : device.poles === 2 ? 2 : 1
    const phases: 1 | 3 = poles === 3 && isThreePhaseSystem(voltageSystem) ? 3 : 1
    const voltage =
      poles === 1 ? getVoltageLineToNeutral(voltageSystem) : getVoltageLineToLine(voltageSystem)
    const loadVa = typeof device.loadVa === 'number' ? device.loadVa : 180
    const loadAmps =
      Math.round(
        (phases === 3 ? loadVa / (voltage * Math.sqrt(3)) : loadVa / voltage) * 100,
      ) / 100
    const wireGauge: WireGauge =
      input.wireGauge ??
      (typeof device.wireGauge === 'string' && device.wireGauge !== '18' && device.wireGauge !== '16'
        ? (device.wireGauge as WireGauge)
        : '12')

    const vd = calculateVoltageDrop({
      wireGauge,
      loadAmps: Math.max(1, loadAmps),
      oneWayLengthFt: route.routedLengthFt,
      voltage,
      phases,
    })

    const id = deterministicId('eleccond', nodes)
    const ckt = typeof device.circuitNumber === 'number' ? device.circuitNumber : 1
    const runName = input.name ?? `CKT-${ckt} (${device.name ?? device.id})`

    const node = {
      object: 'node',
      id,
      type: 'electrical:conduit-run',
      name: runName,
      parentId,
      visible: true,
      metadata: {
        avoidedObstacles: route.avoidedObstacles,
        totalBendDegrees: route.totalBendDegrees,
      },
      path: route.path,
      occupancy,
      racewayType,
      tradeSize: input.tradeSize ?? '3/4"',
      conductorMaterial: 'cu',
      insulationRating: '90C',
      wireGauge,
      currentCarryingCount: poles === 3 ? 3 : 2,
      totalConductorCount: poles === 3 ? 4 : 3,
      ambientTempC: 30,
      rooftopExposed: false,
      inPlenum: false,
      panelId: panel.id,
      targetDeviceId: device.id,
      circuitNumber: ckt,
      loadAmps: Math.max(1, loadAmps),
      continuous: device.continuous === true,
      voltage,
      phases,
    } as unknown as AnyNode

    return {
      result: {
        conduitRunId: id,
        name: runName,
        routedLengthM: route.routedLengthM,
        routedLengthFt: route.routedLengthFt,
        detourAddedM: route.detourAddedM,
        totalBendDegrees: route.totalBendDegrees,
        exceedsMaxBends: route.exceedsMaxBends,
        recommendedPullBoxAt: route.recommendedPullBoxAt,
        avoidedObstacles: route.avoidedObstacles,
        remainingClashes: route.remainingClashes,
        voltageDropPct: vd.voltageDropPct,
        voltageDropCompliant: vd.compliant,
      },
      changes: { create: [{ node, parentId: parentId ?? undefined }] },
    }
  },

  electrical_calculate_load: (
    nodes: SceneNodes,
    input: {
      occupancy?: OccupancyType
      residentialMethod?: 'standard' | 'optional'
      commercialBuildingType?:
        | 'office'
        | 'retail'
        | 'warehouse'
        | 'restaurant'
        | 'school'
        | 'healthcare'
        | 'industrial'
        | 'garage'
      voltageSystem?: VoltageSystem
      fallbackSquareFootage?: number
      conductorMaterial?: 'cu' | 'al'
    },
  ) => {
    const calc = calculateSceneLoad(asRecord(nodes), input)
    return { result: calc as unknown as Record<string, unknown> }
  },

  electrical_audit_nec: (nodes: SceneNodes) => {
    const report = auditSceneElectrical(asRecord(nodes))
    return { result: report as unknown as Record<string, unknown> }
  },

  electrical_generate_schedule: (nodes: SceneNodes, input: { panelId?: string }) => {
    const record = asRecord(nodes)
    const all = Object.values(record)
    const panels = all.filter(
      (n) => n.type === 'electrical:panel' && (!input.panelId || n.id === input.panelId),
    )
    if (input.panelId && panels.length === 0) {
      refuse('panel_not_found', `Electrical panel "${input.panelId}" was not found.`)
    }
    const devices = all.filter((n) => n.type === 'electrical:device')
    const runs = all.filter((n) => n.type === 'electrical:conduit-run')
    const schedules = panels.map((p) => {
      const s = buildPanelSchedule(p, devices, runs)
      return { ...s, csv: formatPanelScheduleCsv(s) }
    })
    const takeoff = buildElectricalTakeoff(record)
    return {
      result: {
        panelCount: schedules.length,
        schedules,
        takeoff,
      },
    }
  },
} satisfies AgentOperations
