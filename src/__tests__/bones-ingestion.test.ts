import { describe, expect, test } from 'bun:test'
import type { AnyNode } from '@pascal-app/core'
import { electricalAgentOperations } from '../agent-operations'
import {
  auditSceneElectrical,
  buildElectricalTakeoff,
  buildPanelSchedule,
  calculateSceneLoad,
  extractBonesSchematic,
  planNecAutoPopulate,
  summarizePendingBonesImport,
  type SceneNodeLike,
} from '../nec'

/**
 * Builds a realistic multi-room residential Pascal scene populated with persisted
 * `@pascal-app/plugin-bones` nodes (`bones:framing`, `bones:device`, `bones:service`)
 * plus a plumbing pipe obstacle to verify end-to-end schematic ingestion, 1P/2P circuiting,
 * trade-priority routing, NEC 220 load calculations, panel schedules, BOM takeoff, and idempotency.
 */
function buildBonesResidentialScene(): Record<string, SceneNodeLike> {
  return {
    lvl_1: { id: 'lvl_1', type: 'level', name: 'Level 1', parentId: 'bldg_1', elevation: 0, height: 2.74 },
    // 8m x 6m exterior shell: Living (x=0..4, z=0..6), Kitchen (x=4..8, z=0..3), Bath (x=4..8, z=3..6)
    wall_n: { id: 'wall_n', type: 'wall', parentId: 'lvl_1', start: [0, 0], end: [8, 0], thickness: 0.14, height: 2.74 },
    wall_s: { id: 'wall_s', type: 'wall', parentId: 'lvl_1', start: [8, 6], end: [0, 6], thickness: 0.14, height: 2.74 },
    wall_w: { id: 'wall_w', type: 'wall', parentId: 'lvl_1', start: [0, 6], end: [0, 0], thickness: 0.14, height: 2.74 },
    wall_e: { id: 'wall_e', type: 'wall', parentId: 'lvl_1', start: [8, 0], end: [8, 6], thickness: 0.14, height: 2.74 },
    wall_mid_v: { id: 'wall_mid_v', type: 'wall', parentId: 'lvl_1', start: [4, 0], end: [4, 6], thickness: 0.12, height: 2.74 },
    wall_mid_h: { id: 'wall_mid_h', type: 'wall', parentId: 'lvl_1', start: [4, 3], end: [8, 3], thickness: 0.12, height: 2.74 },

    zone_living: {
      id: 'zone_living',
      type: 'zone',
      parentId: 'lvl_1',
      name: 'Living Room',
      category: 'living',
      polygon: [
        [0, 0],
        [4, 0],
        [4, 6],
        [0, 6],
      ],
    },
    zone_kitchen: {
      id: 'zone_kitchen',
      type: 'zone',
      parentId: 'lvl_1',
      name: 'Kitchen',
      category: 'kitchen',
      polygon: [
        [4, 0],
        [8, 0],
        [8, 3],
        [4, 3],
      ],
    },
    zone_bath: {
      id: 'zone_bath',
      type: 'zone',
      parentId: 'lvl_1',
      name: 'Bathroom',
      category: 'bathroom',
      polygon: [
        [4, 3],
        [8, 3],
        [8, 6],
        [4, 6],
      ],
    },

    // Persisted Bones framing config
    bones_framing: {
      id: 'bonesframing_1',
      type: 'bones:framing',
      parentId: 'lvl_1',
      studSpacingIn: 16,
      framingSystem: 'lumber',
      wallOverrides: { wall_e: 'framed' },
    },

    // Persisted Bones service anchors (panel + water heater + outdoor heat pump)
    bones_svc_panel: {
      id: 'bonesservice_panel_1',
      type: 'bones:service',
      parentId: 'lvl_1',
      serviceType: 'panel',
      wallId: 'wall_w',
      wallT: 0.25,
      heightAff: 1.52,
      position: [0, 0, 0],
    },
    bones_svc_wh: {
      id: 'bonesservice_wh_1',
      type: 'bones:service',
      parentId: 'lvl_1',
      serviceType: 'water-heater',
      wallId: 'wall_n',
      wallT: 0.35,
      heightAff: 1.0,
      position: [0, 0, 0],
    },
    bones_svc_hp: {
      id: 'bonesservice_hp_1',
      type: 'bones:service',
      parentId: 'lvl_1',
      serviceType: 'heat-pump',
      position: [8.45, 0.55, 1.5],
      yawOverride: Math.PI / 2,
    },

    // Persisted Bones electrical devices (including 1 user-dragged outlet where wallT != seedWallT)
    bones_dev_living_1: {
      id: 'bonesdevice_living_1',
      type: 'bones:device',
      parentId: 'lvl_1',
      deviceId: 'recep-wall_n-0-p',
      deviceKind: 'receptacle',
      wallId: 'wall_n',
      wallT: 0.18,
      heightAff: 0.38,
      seedWallId: 'wall_n',
      seedWallT: 0.12, // User dragged from 0.12 -> 0.18!
      seedHeightAff: 0.38,
      position: [0, 0, 0],
    },
    bones_dev_kitchen_ctr_1: {
      id: 'bonesdevice_kit_1',
      type: 'bones:device',
      parentId: 'lvl_1',
      deviceId: 'recep-wall_n-ctr-0-p',
      deviceKind: 'receptacle-gfci',
      wallId: 'wall_n',
      wallT: 0.65,
      heightAff: 1.12,
      seedWallId: 'wall_n',
      seedWallT: 0.65,
      seedHeightAff: 1.12,
      position: [0, 0, 0],
    },
    bones_dev_kitchen_ctr_2: {
      id: 'bonesdevice_kit_2',
      type: 'bones:device',
      parentId: 'lvl_1',
      deviceId: 'recep-wall_n-ctr-1-p',
      deviceKind: 'receptacle-gfci',
      wallId: 'wall_n',
      wallT: 0.85,
      heightAff: 1.12,
      seedWallId: 'wall_n',
      seedWallT: 0.85,
      seedHeightAff: 1.12,
      position: [0, 0, 0],
    },
    bones_dev_bath_basin: {
      id: 'bonesdevice_bath_1',
      type: 'bones:device',
      parentId: 'lvl_1',
      deviceId: 'recep-wall_e-basin-lav1-p',
      deviceKind: 'receptacle-gfci',
      wallId: 'wall_e',
      wallT: 0.72,
      heightAff: 1.12,
      seedWallId: 'wall_e',
      seedWallT: 0.72,
      seedHeightAff: 1.12,
      position: [0, 0, 0],
    },
    bones_dev_outdoor_wr: {
      id: 'bonesdevice_out_1',
      type: 'bones:device',
      parentId: 'lvl_1',
      deviceId: 'recep-wall_s-out-front',
      deviceKind: 'receptacle-wr-gfci',
      wallId: 'wall_s',
      wallT: 0.65,
      heightAff: 0.45,
      seedWallId: 'wall_s',
      seedWallT: 0.65,
      seedHeightAff: 0.45,
      position: [0, 0, 0],
    },
    bones_dev_switch: {
      id: 'bonesdevice_sw_1',
      type: 'bones:device',
      parentId: 'lvl_1',
      deviceId: 'switch-wall_w-door1-p',
      deviceKind: 'switch',
      wallId: 'wall_w',
      wallT: 0.6,
      heightAff: 1.22,
      seedWallId: 'wall_w',
      seedWallT: 0.6,
      seedHeightAff: 1.22,
      position: [0, 0, 0],
    },

    // Higher-priority Plumbing obstacle in ceiling chase to verify electrical routes around it
    pipe_1: {
      id: 'pipe_1',
      type: 'pipe-segment',
      parentId: 'lvl_1',
      name: 'DWV Stack',
      start: [2.0, 2.55, 0.2],
      end: [2.0, 2.55, 5.5],
      diameter: 0.1,
    },
  }
}

describe('Bones Schematic Ingestion (`bones:framing`, `bones:device`, `bones:service`)', () => {
  test('extractBonesSchematic parses framing, all 4 bones:device kinds, userMoved overrides, face hints, and services', () => {
    const scene = buildBonesResidentialScene()
    const snap = extractBonesSchematic(scene, 'lvl_1')

    expect(snap.framing.present).toBe(true)
    expect(snap.framing.defaultSpacingIn).toBe(16)
    expect(snap.framing.servicePanel?.nodeId).toBe('bonesservice_panel_1')
    expect(snap.hasElectricalSchematic).toBe(true)
    expect(snap.devices.length).toBe(6)
    expect(snap.services.length).toBe(3)
    expect(snap.userMovedDeviceCount).toBe(1)

    const moved = snap.devices.find((d) => d.nodeId === 'bonesdevice_living_1')!
    expect(moved.userMoved).toBe(true)
    expect(moved.faceSideHint).toBe(1)

    const ctr = snap.devices.find((d) => d.nodeId === 'bonesdevice_kit_1')!
    expect(ctr.isCountertop).toBe(true)
    expect(ctr.userMoved).toBe(false)

    const basin = snap.devices.find((d) => d.nodeId === 'bonesdevice_bath_1')!
    expect(basin.isBasin).toBe(true)

    const wr = snap.devices.find((d) => d.nodeId === 'bonesdevice_out_1')!
    expect(wr.isOutdoor).toBe(true)
    expect(wr.deviceKind).toBe('receptacle-wr-gfci')
  })

  test('bonesMode: "import-only" converts Bones devices + 240V services into balanced 1P/2P circuits, NEC 220 load, panel schedule, BOM, and passes NEC audit', () => {
    const scene = buildBonesResidentialScene()
    const outcome = electricalAgentOperations.electrical_autopopulate_nec(
      scene as unknown as Record<string, AnyNode>,
      { levelId: 'lvl_1', occupancy: 'residential', protectionMode: 'hybrid', bonesMode: 'import-only' },
      { activeLevelId: 'lvl_1' },
    )

    expect(outcome.result.bonesDevicesImported).toBe(6)
    expect(outcome.result.bonesServicesImported).toBe(2)
    expect(outcome.result.bonesUserMovedPreserved).toBe(1)
    expect(outcome.result.devicesPlanned).toBe(8) // 6 bones:device + water-heater + heat-pump
    expect(outcome.result.panelCreated).toBe(true)

    // Materialize created nodes into scene graph
    const nextScene: Record<string, SceneNodeLike> = { ...scene }
    for (const item of outcome.changes?.create ?? []) {
      nextScene[item.node.id] = item.node as unknown as SceneNodeLike
    }

    const devices = Object.values(nextScene).filter((n) => n.type === 'electrical:device')
    const panels = Object.values(nextScene).filter((n) => n.type === 'electrical:panel')
    const runs = Object.values(nextScene).filter((n) => n.type === 'electrical:conduit-run')
    expect(panels.length).toBe(1)
    expect(devices.length).toBe(8)
    expect(runs.length).toBeGreaterThanOrEqual(7)

    // Verify user-moved outlet preserved its exact wallT=0.18 (x = 0.18 * 8 = 1.44m)
    const livingOutlet = devices.find(
      (d) => (d.metadata as Record<string, unknown> | undefined)?.bonesSourceId === 'bonesdevice_living_1',
    )!
    expect(livingOutlet).toBeDefined()
    expect((livingOutlet.metadata as Record<string, unknown>).bonesUserMoved).toBe(true)
    expect(Math.abs((livingOutlet.position as number[])[0]! - 1.44)).toBeLessThan(0.02)

    // Verify outdoor WR GFCI landed on the exterior face (z > 6.0 for south wall) with weatherproof-gfci kind
    const wrOutlet = devices.find(
      (d) => (d.metadata as Record<string, unknown> | undefined)?.bonesSourceId === 'bonesdevice_out_1',
    )!
    expect(wrOutlet.deviceKind).toBe('weatherproof-gfci')
    expect((wrOutlet.position as number[])[2]!).toBeGreaterThan(6.0)

    // Verify 2-pole 240V 30A #10 Cu circuits for Water Heater and Heat Pump
    const wh = devices.find(
      (d) => (d.metadata as Record<string, unknown> | undefined)?.bonesServiceType === 'water-heater',
    )!
    const hp = devices.find(
      (d) => (d.metadata as Record<string, unknown> | undefined)?.bonesServiceType === 'heat-pump',
    )!
    expect(wh.poles).toBe(2)
    expect(wh.breakerAmps).toBe(30)
    expect(wh.wireGauge).toBe('10')
    expect(hp.poles).toBe(2)
    expect(hp.breakerAmps).toBe(30)
    expect(hp.wireGauge).toBe('10')

    // Verify Panel Schedule has zero slot conflicts and includes 2P breakers
    const schedule = buildPanelSchedule(panels[0]!, devices, runs)
    expect(schedule.slotConflicts.length).toBe(0)
    expect(schedule.overflowCircuits.length).toBe(0)
    const twoPoleEntries = schedule.rows
      .flatMap((r) => [r.left, r.right])
      .filter((e) => e && !e.isContinuation && e.poles === 2)
    expect(twoPoleEntries.length).toBe(2)

    // Verify NEC 220 Optional Load Calc includes both Water Heater and 100% Heat Pump
    const loadCalc = calculateSceneLoad(nextScene, { occupancy: 'residential', residentialMethod: 'optional' })
    expect(loadCalc.occupancy).toBe('residential')
    if (loadCalc.occupancy === 'residential') {
      expect(loadCalc.applianceDetails.some((a) => /water heater/i.test(a.name))).toBe(true)
      expect(loadCalc.applianceDetails.some((a) => /heat pump/i.test(a.name))).toBe(true)
    }

    // Verify Priced BOM Takeoff produces positive material + labor totals
    const takeoff = buildElectricalTakeoff(nextScene)
    expect(takeoff.pricing.estimatedTotalUsd).toBeGreaterThan(0)

    // Verify full NEC Audit passes with 0 errors AND 0 false NEC 210.12(A) AFCI warnings on 240V water heater
    const audit = auditSceneElectrical(nextScene)
    expect(audit.errorCount).toBe(0)
    expect(audit.warningCount).toBe(0)

    // Verify idempotency: running import-only a second time creates 0 duplicate devices
    const secondRun = electricalAgentOperations.electrical_autopopulate_nec(
      nextScene as unknown as Record<string, AnyNode>,
      { levelId: 'lvl_1', occupancy: 'residential', protectionMode: 'hybrid', bonesMode: 'import-only' },
      { activeLevelId: 'lvl_1' },
    )
    expect(secondRun.result.bonesDevicesImported).toBe(0)
    expect(secondRun.result.bonesServicesImported).toBe(0)
    expect(secondRun.result.devicesPlanned).toBe(0)
    expect(secondRun.changes).toBeUndefined()
  })

  test('bonesMode: "auto" imports Bones schematic AND fills missing NEC items (luminaires, Smoke/CO) without duplicating Bones outlets', () => {
    const scene = buildBonesResidentialScene()
    const plan = planNecAutoPopulate(scene, {
      levelId: 'lvl_1',
      occupancy: 'residential',
      bonesMode: 'auto',
    })

    expect(plan.summary.bonesDevicesImported).toBe(6)
    expect(plan.summary.bonesServicesImported).toBe(2)
    expect(plan.summary.devicesPlanned).toBeGreaterThan(8) // Added luminaires / smoke-co / gap outlets
    expect(plan.devices.some((d) => d.deviceKind === 'luminaire')).toBe(true)
    expect(plan.devices.some((d) => d.deviceKind === 'smoke-co')).toBe(true)

    // Kitchen counter Bones GFCI #1 (x=5.2) should NOT have a duplicate outlet stacked within 0.45m
    const kitBones = plan.devices.find((d) => d.bonesSourceId === 'bonesdevice_kit_1')!
    const stackedDuplicates = plan.devices.filter(
      (d) =>
        d.tempId !== kitBones.tempId &&
        Math.hypot(
          d.position[0] - kitBones.position[0],
          d.position[1] - kitBones.position[1],
          d.position[2] - kitBones.position[2],
        ) < 0.45,
    )
    expect(stackedDuplicates.length).toBe(0)
  })

  test('bonesMode: "ignore" skips Bones device/service import while electric-meter service still anchors MDP-1 back-to-back', () => {
    const scene = buildBonesResidentialScene()
    // Replace panel service with electric-meter on east wall to test back-to-back NEC 230.70(A)(1) fallback
    delete scene.bones_svc_panel
    scene.bones_svc_meter = {
      id: 'bonesservice_meter_1',
      type: 'bones:service',
      parentId: 'lvl_1',
      serviceType: 'electric-meter',
      wallId: 'wall_n',
      wallT: 0.25,
      heightAff: 1.45,
      position: [0, 0, 0],
    }

    const plan = planNecAutoPopulate(scene, {
      levelId: 'lvl_1',
      occupancy: 'residential',
      bonesMode: 'ignore',
    })

    expect(plan.summary.bonesDevicesImported).toBe(0)
    expect(plan.summary.bonesServicesImported).toBe(0)
    expect(plan.createdPanel).not.toBeNull()
    // Back-to-back on north wall near wallT=0.25 (x ~ 2.0m, inside Living Room z > 0)
    expect(Math.abs(plan.createdPanel!.position[0] - 2.0)).toBeLessThan(0.5)
    expect(plan.createdPanel!.position[2]).toBeGreaterThan(0)
  })

  test('Audit-Fix Regressions (BUG-01..04, DX-01, CON-01): pilot switch dedupe, WR GFCI in gfci-breakers mode, shared-wall kitchen counter preservation, 208V label, and pending UI summary', () => {
    // BUG-02: Bones switch inside pilotLightZone joins Smoke/CO & Lighting and suppresses duplicate room switch
    const scene = buildBonesResidentialScene()
    const autoPlan = planNecAutoPopulate(scene, {
      levelId: 'lvl_1',
      occupancy: 'residential',
      protectionMode: 'gfci-breakers',
      bonesMode: 'auto',
    })
    const livingSwitches = autoPlan.devices.filter(
      (d) => d.deviceKind === 'switch-1p' && /living room/i.test(d.name),
    )
    expect(livingSwitches.length).toBe(1)
    expect(livingSwitches[0]!.bonesSourceId).toBe('bonesdevice_sw_1')
    expect(livingSwitches[0]!.circuitGroup).toBe('Smoke/CO & Lighting')

    // BUG-03: Outdoor WR GFCI preserves weatherproof-gfci even under gfci-breakers protectionMode
    const wr = autoPlan.devices.find((d) => d.bonesSourceId === 'bonesdevice_out_1')!
    expect(wr.deviceKind).toBe('weatherproof-gfci')
    expect(wr.gfciProtected).toBe(true)

    // BUG-04: Bones countertop GFCI on shared partition wall retains Kitchen SAB-1/2 + GFCI even if wall face touches adjacent room
    const sharedScene: Record<string, SceneNodeLike> = {
      lvl_1: { id: 'lvl_1', type: 'level', parentId: 'bldg_1', height: 2.74 },
      wall_part: { id: 'wall_part', type: 'wall', parentId: 'lvl_1', start: [4, 0], end: [4, 4], thickness: 0.12, height: 2.74 },
      zone_dining: { id: 'zone_dining', type: 'zone', parentId: 'lvl_1', name: 'Dining', category: 'dining', polygon: [[0, 0], [4.15, 0], [4.15, 4], [0, 4]] },
      zone_kit: { id: 'zone_kit', type: 'zone', parentId: 'lvl_1', name: 'Kitchen', category: 'kitchen', polygon: [[4.15, 0], [8, 0], [8, 4], [4.15, 4]] },
      bones_ctr: {
        id: 'b_ctr_shared',
        type: 'bones:device',
        parentId: 'lvl_1',
        deviceId: 'recep-wall_part-ctr-0-m', // faces +X into Kitchen (wall_part dir=(0,1), nx=-1, so -m -> +X!)
        deviceKind: 'receptacle-gfci',
        wallId: 'wall_part',
        wallT: 0.5,
        heightAff: 1.12,
        position: [0, 0, 0],
      },
    }
    const sharedPlan = planNecAutoPopulate(sharedScene, {
      levelId: 'lvl_1',
      occupancy: 'residential',
      bonesMode: 'import-only',
    })
    const ctrDev = sharedPlan.devices.find((d) => d.bonesSourceId === 'b_ctr_shared')!
    expect(ctrDev.circuitGroup).toMatch(/^Kitchen SAB-/)
    expect(ctrDev.gfciProtected).toBe(true)
    expect(ctrDev.breakerAmps).toBe(20)

    // CON-01: Commercial 120/208V-3P panel uses dynamic 208V label (not hardcoded 240V)
    const commPlan = planNecAutoPopulate(scene, {
      levelId: 'lvl_1',
      occupancy: 'commercial',
      bonesMode: 'import-only',
    })
    expect(commPlan.circuitSummary.some((c) => c.groupName === 'Water Heater (208V 30A)')).toBe(true)
    expect(commPlan.circuitSummary.some((c) => c.groupName === 'Heat Pump HVAC (208V 30A)')).toBe(true)

    // DX-01: Pending Bones import UI summary formats services-only, mixed, and post-import states cleanly
    const snap = extractBonesSchematic(scene, 'lvl_1')
    const beforeSummary = summarizePendingBonesImport(snap, [])
    expect(beforeSummary.totalImportable).toBe(8)
    expect(beforeSummary.pendingDevices).toBe(6)
    expect(beforeSummary.pendingServices).toBe(2)
    expect(beforeSummary.pendingUserMoved).toBe(1)
    expect(beforeSummary.label).toBe('Import & Wire Bones Schematic (6 dev, 2 svc, 1 moved)')

    const importedOutcome = electricalAgentOperations.electrical_autopopulate_nec(
      scene as unknown as Record<string, AnyNode>,
      { levelId: 'lvl_1', occupancy: 'residential', bonesMode: 'import-only' },
      { activeLevelId: 'lvl_1' },
    )
    const createdDevices = (importedOutcome.changes?.create ?? [])
      .map((c) => c.node as unknown as SceneNodeLike)
      .filter((n) => n.type === 'electrical:device')
    const afterSummary = summarizePendingBonesImport(snap, createdDevices)
    expect(afterSummary.pendingDevices).toBe(0)
    expect(afterSummary.pendingServices).toBe(0)
    expect(afterSummary.label).toBe('Bones Schematic Imported (8/8)')

    // Services-only scene never shows "(0 dev)"
    const svcOnlySnap = extractBonesSchematic(
      {
        lvl_1: scene.lvl_1!,
        bones_svc_wh: scene.bones_svc_wh!,
        bones_svc_hp: scene.bones_svc_hp!,
      },
      'lvl_1',
    )
    const svcOnlySummary = summarizePendingBonesImport(svcOnlySnap, [])
    expect(svcOnlySummary.label).toBe('Import & Wire Bones Schematic (2 svc)')
  })
})
