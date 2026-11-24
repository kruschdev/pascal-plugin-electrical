/**
 * Pure Agent Operations (`@kruschdev/pascal-plugin-electrical/agent-operations`).
 * Runs identically in Pascal's MCP server, detached scene runtime, or live editor tab
 * in a single undo step (`DECISIONS.md` E-016 & E-018).
 */

import type { AnyNode } from '@pascal-app/core'
import type { AgentContext, AgentOperations, SceneNodes } from '@pascal-app/core/agent-operations'
import { refuse } from '@pascal-app/core/agent-tools'
import { auditSceneElectrical } from './nec/audit'
import {
  planDeviceAutoConnection,
  planNecAutoPopulate,
  type ProtectionMode,
} from './nec/autopopulate'
import { calculateSceneLoad, type SceneNodeLike } from './nec/load-calc'
import {
  buildElectricalTakeoff,
  buildPanelSchedule,
  formatPanelScheduleCsv,
} from './nec/panel-schedule'
import { formatElectricalBomCsv } from './nec/pricing'
import {
  extractRoutingWalls,
  extractTradeObstacles,
  resolveLevelHeightM,
  routeElectricalRun,
  type Vec3,
} from './nec/routing'
import {
  calculateConduitFill,
  calculateTransformerSizing,
  calculateVoltageDrop,
  recommendWireGauge,
} from './nec/sizing'
import {
  type ConduitTradeSize,
  METERS_TO_FEET,
  type OccupancyType,
  type RacewayType,
  type VoltageSystem,
  WIRE_GAUGE_ORDER,
  type WireGauge,
  getVoltageLineToLine,
  getVoltageLineToNeutral,
  isThreePhaseSystem,
} from './nec/tables'

function largerWireGauge(a: WireGauge, b: WireGauge): WireGauge {
  return WIRE_GAUGE_ORDER.indexOf(a) >= WIRE_GAUGE_ORDER.indexOf(b) ? a : b
}

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

  electrical_place_transformer: (
    nodes: SceneNodes,
    input: {
      levelId?: string
      name?: string
      position: [number, number, number]
      rotation?: number
      kvaRating?: number
      primaryVoltage?: number
      secondaryVoltage?: number
      fedFromPanelId?: string
      nemaRating?: 'NEMA-1' | 'NEMA-2' | 'NEMA-3R'
      showClearanceZone?: boolean
    },
    context: AgentContext,
  ) => {
    const parentId = resolveLevelId(nodes, input.levelId, context)
    if (input.fedFromPanelId && !nodes[input.fedFromPanelId]) {
      refuse('panel_not_found', `Electrical panel "${input.fedFromPanelId}" does not exist in the scene.`)
    }
    const id = deterministicId('electx', nodes)
    const kvaRating = input.kvaRating ?? 75
    const primaryVoltage = input.primaryVoltage ?? 480
    const secondaryVoltage = input.secondaryVoltage ?? 208
    const sizing = calculateTransformerSizing(kvaRating, primaryVoltage, secondaryVoltage)
    const name = input.name ?? `TX-1 (${kvaRating} kVA)`

    const node = {
      object: 'node',
      id,
      type: 'electrical:transformer',
      name,
      parentId,
      visible: true,
      metadata: {},
      position: input.position,
      rotation: input.rotation ?? 0,
      kvaRating,
      primaryVoltage,
      secondaryVoltage,
      fedFromPanelId: input.fedFromPanelId,
      impedancePct: 4.5,
      nemaRating: input.nemaRating ?? 'NEMA-2',
      showClearanceZone: input.showClearanceZone ?? true,
      width: 0.76,
      depth: 0.64,
      height: 0.95,
    } as unknown as AnyNode

    return {
      result: {
        transformerId: id,
        name,
        levelId: parentId,
        ...sizing,
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
      autoWire?: boolean
      boxType?: string
      wireGauge?: string
      conductorCount?: number
    },
    context: AgentContext,
  ) => {
    const record = asRecord(nodes)
    const parentId = resolveLevelId(nodes, input.levelId, context)
    if (input.panelId && !nodes[input.panelId]) {
      refuse('panel_not_found', `Electrical panel "${input.panelId}" does not exist in the scene.`)
    }
    const id = deterministicId('elecdev', nodes)
    const deviceKind = input.deviceKind ?? 'duplex'
    const occupancy: OccupancyType = input.occupancy ?? 'residential'
    const name = input.name ?? deviceKind
    const initialBreakerAmps = input.breakerAmps ?? 20
    const poles: 1 | 2 | 3 = input.poles ?? 1
    const loadVa = input.loadVa ?? 180
    const continuous = input.continuous ?? false
    const nominalVoltage = poles === 1 ? 120 : 240
    const actualLoadAmps =
      poles === 3 ? loadVa / (nominalVoltage * Math.sqrt(3)) : loadVa / nominalVoltage
    const autoWireGauge: WireGauge = recommendWireGauge({
      material: 'cu',
      insulationRating: '90C',
      racewayType: occupancy === 'commercial' ? 'emt' : 'nm-b',
      ambientTempC: 30,
      currentCarryingCount: poles === 3 ? 3 : 2,
      loadAmps: Math.max(1, Math.round(Math.max(initialBreakerAmps * 0.8, actualLoadAmps) * 100) / 100),
      continuousLoad: continuous,
      breakerAmps: initialBreakerAmps,
    })
    const autoBoxType = (
      deviceKind === 'junction-box'
        ? '4-sq-2.125'
        : initialBreakerAmps >= 40
          ? '4-11-16-2.125'
          : initialBreakerAmps >= 30
            ? '4-sq-2.125'
            : deviceKind === 'gfci'
              ? 'single-gang-deep'
              : 'single-gang-standard'
    ) as import('./nec/tables').BoxType
    const initialConductorCount =
      input.conductorCount ?? (poles === 3 ? 3 : initialBreakerAmps >= 30 ? 3 : 4)

    const shouldAutoWire = input.autoWire !== false
    const autoConn = shouldAutoWire
      ? planDeviceAutoConnection(
          record,
          {
            id,
            name,
            position: input.position,
            rotation: input.rotation ?? 0,
            deviceKind,
            occupancy,
            panelId: input.panelId,
            circuitNumber: input.circuitNumber,
            poles,
            breakerAmps: initialBreakerAmps,
            loadVa,
            continuous,
            gfciProtected: input.gfciProtected ?? deviceKind === 'gfci',
            afciProtected: input.afciProtected ?? deviceKind === 'afci',
            boxType: (input.boxType ?? autoBoxType) as import('./nec/tables').BoxType,
            wireGauge: (input.wireGauge ?? autoWireGauge) as WireGauge,
            conductorCount: initialConductorCount,
          },
          { levelId: parentId },
        )
      : null

    const finalPanelId = autoConn?.panelId ?? input.panelId
    const finalCircuitNumber = autoConn?.circuitNumber ?? input.circuitNumber ?? 1
    const finalBreakerAmps = autoConn?.breakerAmps ?? initialBreakerAmps
    const finalWireGauge = (input.wireGauge ?? autoConn?.wireGauge ?? autoWireGauge) as WireGauge
    const finalBoxType = input.boxType ?? autoConn?.boxType ?? autoBoxType
    const finalConductorCount = input.conductorCount ?? autoConn?.conductorCount ?? initialConductorCount
    const finalGfciProtected = autoConn ? autoConn.gfciProtected : (input.gfciProtected ?? deviceKind === 'gfci')
    const finalAfciProtected = autoConn ? autoConn.afciProtected : (input.afciProtected ?? deviceKind === 'afci')

    const node = {
      object: 'node',
      id,
      type: 'electrical:device',
      name,
      parentId,
      visible: true,
      metadata: {
        ...(autoConn?.roomName ? { roomName: autoConn.roomName } : {}),
      },
      position: input.position,
      rotation: input.rotation ?? 0,
      deviceKind,
      occupancy,
      panelId: finalPanelId,
      circuitNumber: finalCircuitNumber,
      poles,
      breakerAmps: finalBreakerAmps,
      loadVa,
      continuous,
      isMotor: deviceKind === 'motor-load',
      gfciProtected: finalGfciProtected,
      afciProtected: finalAfciProtected,
      boxType: finalBoxType,
      wireGauge: finalWireGauge,
      conductorCount: finalConductorCount,
      clampCount: 1,
      yokeCount: deviceKind === 'junction-box' ? 0 : 1,
    } as unknown as AnyNode

    const creates: Array<{ node: AnyNode; parentId?: string }> = [
      { node, parentId: parentId ?? undefined },
    ]
    let createdRunId: string | null = null
    if (autoConn?.run) {
      createdRunId = deterministicId('eleccond', nodes)
      const r = autoConn.run
      const runNode = {
        object: 'node',
        id: createdRunId,
        type: 'electrical:conduit-run',
        name: r.name,
        parentId,
        visible: true,
        metadata: {
          runKind: r.runKind,
          fromNodeId: r.fromNodeId,
          avoidedObstaclesCount: r.avoidedObstaclesCount,
        },
        path: r.path,
        occupancy: r.occupancy,
        racewayType: r.racewayType,
        tradeSize: r.tradeSize,
        conductorMaterial: 'cu',
        insulationRating: '90C',
        wireGauge: r.wireGauge,
        currentCarryingCount: r.currentCarryingCount,
        totalConductorCount: r.totalConductorCount,
        ambientTempC: 30,
        rooftopExposed: false,
        inPlenum: false,
        panelId: r.panelId,
        targetDeviceId: id,
        circuitNumber: r.circuitNumber,
        loadAmps: r.loadAmps,
        continuous: r.continuous,
        voltage: r.voltage,
        phases: r.phases,
      } as unknown as AnyNode
      creates.push({ node: runNode, parentId: parentId ?? undefined })
    }

    const updates = autoConn?.anchorDevicePatch
      ? [
          {
            id: autoConn.anchorDevicePatch.id,
            data: autoConn.anchorDevicePatch.patch as unknown as Partial<AnyNode>,
          },
        ]
      : undefined

    return {
      result: {
        deviceId: id,
        deviceKind,
        panelId: finalPanelId ?? null,
        circuitNumber: finalCircuitNumber,
        levelId: parentId,
        connectionMode: autoConn?.mode ?? 'none',
        conduitRunId: createdRunId,
        connectedFromNodeId: autoConn?.connectedFromNodeId ?? null,
        connectedFromName: autoConn?.connectedFromName ?? null,
        roomName: autoConn?.roomName ?? null,
      },
      changes: {
        create: creates,
        ...(updates ? { update: updates } : {}),
      },
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
      wallPlacement?: 'in-wall' | 'surface'
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
    const walls = extractRoutingWalls(record, parentId)
    const levelHeight = resolveLevelHeightM(record, parentId)
    const defaultChaseY = Math.round(Math.min(2.55, levelHeight - 0.06) * 1000) / 1000
    const route = routeElectricalRun(startPt, endPt, obstacles, {
      preferredChaseY: input.preferredChaseY ?? defaultChaseY,
      clearanceM: input.clearanceM ?? 0.05,
      walls,
      wallPlacement: input.wallPlacement ?? 'in-wall',
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
    const breakerAmps = typeof device.breakerAmps === 'number' ? device.breakerAmps : 20
    const continuousLoad = device.continuous === true
    const ccc = poles === 3 ? 3 : 2
    const totalConductors = poles === 3 ? 4 : 3

    let wireGauge: WireGauge
    if (input.wireGauge) {
      wireGauge = input.wireGauge
    } else {
      const ampGauge = recommendWireGauge({
        material: 'cu',
        insulationRating: '90C',
        racewayType,
        ambientTempC: 30,
        currentCarryingCount: ccc,
        loadAmps: Math.max(1, loadAmps),
        continuousLoad,
        breakerAmps,
      })
      const vdCheck = calculateVoltageDrop({
        wireGauge: ampGauge,
        material: 'cu',
        loadAmps: Math.max(1, loadAmps),
        oneWayLengthFt: route.routedLengthFt,
        voltage,
        phases,
        maxDropPct: 3.0,
      })
      wireGauge = largerWireGauge(ampGauge, vdCheck.recommendedGauge)
    }

    let tradeSize: ConduitTradeSize = input.tradeSize ?? '3/4"'
    if (
      !input.tradeSize &&
      (racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc')
    ) {
      const lengthIn = route.routedLengthM * METERS_TO_FEET * 12
      const fill = calculateConduitFill({
        conduitType: racewayType,
        tradeSize: '3/4"',
        conductors: [{ gauge: wireGauge, count: totalConductors }],
        lengthInches: lengthIn > 0 ? lengthIn : undefined,
      })
      if (!fill.compliant) {
        tradeSize = fill.recommendedTradeSize
      }
    }

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
      tradeSize,
      conductorMaterial: 'cu',
      insulationRating: '90C',
      wireGauge,
      currentCarryingCount: ccc,
      totalConductorCount: totalConductors,
      ambientTempC: 30,
      rooftopExposed: false,
      inPlenum: false,
      panelId: panel.id,
      targetDeviceId: device.id,
      circuitNumber: ckt,
      loadAmps: Math.max(1, loadAmps),
      continuous: continuousLoad,
      voltage,
      phases,
    } as unknown as AnyNode

    return {
      result: {
        conduitRunId: id,
        name: runName,
        wireGauge,
        tradeSize,
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

  electrical_generate_schedule: (
    nodes: SceneNodes,
    input: {
      panelId?: string
      laborRatePerHourUsd?: number
      materialMarkupPct?: number
    },
  ) => {
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
    const takeoff = buildElectricalTakeoff(record, {
      laborRatePerHourUsd: input.laborRatePerHourUsd,
      materialMarkupPct: input.materialMarkupPct,
    })
    return {
      result: {
        panelCount: schedules.length,
        schedules,
        takeoff,
        takeoffCsv: formatElectricalBomCsv(takeoff.pricing),
      },
    }
  },

  electrical_autopopulate_nec: (
    nodes: SceneNodes,
    input: {
      levelId?: string
      occupancy?: OccupancyType
      protectionMode?: ProtectionMode
      racewayType?: RacewayType
      preferredChaseY?: number
      includeLighting?: boolean
      includeWiring?: boolean
    },
    context: AgentContext,
  ) => {
    const parentId = resolveLevelId(nodes, input.levelId, context)
    const plan = planNecAutoPopulate(asRecord(nodes), {
      levelId: parentId,
      occupancy: input.occupancy,
      protectionMode: input.protectionMode ?? 'hybrid',
      racewayType: input.racewayType,
      preferredChaseY: input.preferredChaseY ?? 2.55,
      includeLighting: input.includeLighting ?? true,
      includeWiring: input.includeWiring ?? true,
    })

    const creates: Array<{ node: AnyNode; parentId?: string }> = []
    const virtualMap: Record<string, AnyNode> = { ...nodes }
    const idRemap = new Map<string, string>()

    const nextId = (prefix: string): string => {
      let idx = 1
      while (virtualMap[`${prefix}_${idx}`]) idx += 1
      const id = `${prefix}_${idx}`
      virtualMap[id] = { id } as unknown as AnyNode
      return id
    }

    let realPanelId = plan.panelId
    if (plan.createdPanel) {
      realPanelId = nextId('elecpanel')
      idRemap.set(plan.createdPanel.id, realPanelId)
      const pNode = {
        object: 'node',
        id: realPanelId,
        type: 'electrical:panel',
        name: plan.createdPanel.name,
        parentId,
        visible: true,
        metadata: { autoPopulated: true },
        position: plan.createdPanel.position,
        rotation: plan.createdPanel.rotation,
        occupancy: plan.createdPanel.occupancy,
        voltageSystem: plan.createdPanel.voltageSystem,
        busRatingAmps: plan.createdPanel.busRatingAmps,
        mainBreakerAmps: plan.createdPanel.mainBreakerAmps,
        mainType: 'main-breaker',
        spaces: plan.createdPanel.spaces,
        nemaRating: 'NEMA-1',
        condition110_26: 2,
        solarBackfeedAmps: 0,
        showClearanceZone: true,
        coverRemoved: false,
        width: plan.createdPanel.occupancy === 'commercial' ? 0.51 : 0.38,
        depth: 0.14,
        height: plan.createdPanel.occupancy === 'commercial' ? 1.2 : 0.92,
      } as unknown as AnyNode
      creates.push({ node: pNode, parentId: parentId ?? undefined })
    }

    for (const dev of plan.devices) {
      const realDevId = nextId('elecdev')
      idRemap.set(dev.tempId, realDevId)
      const dNode = {
        object: 'node',
        id: realDevId,
        type: 'electrical:device',
        name: dev.name,
        parentId,
        visible: true,
        metadata: {
          autoPopulated: true,
          necRef: dev.necRef,
          circuitGroup: dev.circuitGroup,
          isExterior: dev.isExterior === true,
        },
        position: dev.position,
        rotation: dev.rotation,
        deviceKind: dev.deviceKind,
        occupancy: dev.occupancy,
        panelId: realPanelId,
        circuitNumber: dev.circuitNumber,
        poles: dev.poles,
        breakerAmps: dev.breakerAmps,
        loadVa: dev.loadVa,
        continuous: dev.continuous,
        isMotor: false,
        gfciProtected: dev.gfciProtected,
        afciProtected: dev.afciProtected,
        boxType: dev.boxType,
        wireGauge: dev.wireGauge,
        conductorCount: dev.conductorCount,
        clampCount: 1,
        yokeCount: dev.deviceKind === 'luminaire' ? 0 : 1,
      } as unknown as AnyNode
      creates.push({ node: dNode, parentId: parentId ?? undefined })
    }

    for (const run of plan.runs) {
      const realRunId = nextId('eleccond')
      const resolvedTargetId = idRemap.get(run.targetDeviceId) ?? run.targetDeviceId
      const resolvedFromId = idRemap.get(run.fromNodeId) ?? run.fromNodeId
      const rNode = {
        object: 'node',
        id: realRunId,
        type: 'electrical:conduit-run',
        name: run.name,
        parentId,
        visible: true,
        metadata: {
          autoPopulated: true,
          runKind: run.runKind,
          fromNodeId: resolvedFromId,
          avoidedObstaclesCount: run.avoidedObstaclesCount,
        },
        path: run.path,
        occupancy: run.occupancy,
        racewayType: run.racewayType,
        tradeSize: run.tradeSize,
        conductorMaterial: 'cu',
        insulationRating: '90C',
        wireGauge: run.wireGauge,
        currentCarryingCount: run.currentCarryingCount,
        totalConductorCount: run.totalConductorCount,
        ambientTempC: 30,
        rooftopExposed: false,
        inPlenum: false,
        panelId: realPanelId,
        targetDeviceId: resolvedTargetId,
        circuitNumber: run.circuitNumber,
        loadAmps: run.loadAmps,
        continuous: run.continuous,
        voltage: run.voltage,
        phases: run.phases,
      } as unknown as AnyNode
      creates.push({ node: rNode, parentId: parentId ?? undefined })
    }

    return {
      result: {
        panelId: realPanelId,
        levelId: parentId,
        protectionMode: input.protectionMode ?? 'hybrid',
        ...plan.summary,
        circuits: plan.circuitSummary,
      },
      changes: creates.length > 0 ? { create: creates } : undefined,
    }
  },
} satisfies AgentOperations
