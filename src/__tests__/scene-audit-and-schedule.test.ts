import { describe, expect, test } from 'bun:test'
import { auditSceneElectrical } from '../nec/audit'
import {
  buildElectricalTakeoff,
  buildPanelSchedule,
  findNextFreePanelCircuit,
  formatPanelScheduleCsv,
} from '../nec/panel-schedule'

describe('Live Scene NEC Audit, Panel Schedule & Takeoff', () => {
  test('Detects NEC 110.26(A) working-space obstruction & NEC 110.26(E) overhead plumbing pipe', () => {
    const scene = {
      elecpanel_1: {
        id: 'elecpanel_1',
        type: 'electrical:panel',
        name: 'MDP-1',
        position: [0, 1.52, 0],
        rotation: 0,
        occupancy: 'commercial',
        voltageSystem: '277/480V-3P',
        busRatingAmps: 400,
        mainBreakerAmps: 400,
        condition110_26: 2, // 42" depth required
        width: 0.5,
        depth: 0.14,
        height: 1.2,
      },
      cabinet_1: {
        id: 'cabinet_1',
        type: 'cabinet',
        position: [0, 0, 0.55], // inside 42" (1.067 m) front working space!
        width: 0.6,
        depth: 0.5,
        height: 0.9,
      },
      'pipe-segment_1': {
        id: 'pipe-segment_1',
        type: 'pipe-segment',
        diameter: 3,
        path: [
          [-1, 2.5, 0],
          [1, 2.5, 0],
        ], // passes directly over panel footprint (y = 2.5m inside 6ft above top)!
      },
    }

    const report = auditSceneElectrical(scene)
    expect(report.passed).toBe(false)
    expect(report.findings.some((f) => f.codeRef === 'NEC 110.26(A)')).toBe(true)
    expect(report.findings.some((f) => f.codeRef === 'NEC 110.26(E)')).toBe(true)
  })

  test('Detects commercial NM-B ban, wet-room missing GFCI, box overfill, and conduit clash with pipe', () => {
    const scene = {
      zone_kitchen: {
        id: 'zone_kitchen',
        type: 'zone',
        name: 'Commercial Kitchen',
        category: 'kitchen',
        polygon: [
          [0, 0],
          [6, 0],
          [6, 6],
          [0, 6],
        ],
      },
      elecdev_1: {
        id: 'elecdev_1',
        type: 'electrical:device',
        name: 'Prep Counter Outlet',
        position: [2, 1.1, 2],
        deviceKind: 'duplex',
        occupancy: 'commercial',
        gfciProtected: false, // violates NEC 210.8(B)
        boxType: 'single-gang-shallow', // 14 cu in
        wireGauge: '12',
        conductorCount: 6, // 22.5 cu in > 14 -> violates NEC 314.16
        yokeCount: 1,
        clampCount: 1,
      },
      'pipe-segment_1': {
        id: 'pipe-segment_1',
        type: 'pipe-segment',
        diameter: 4,
        path: [
          [1.0, 2.55, -1],
          [1.0, 2.55, 3],
        ],
      },
      eleccond_1: {
        id: 'eleccond_1',
        type: 'electrical:conduit-run',
        name: 'CKT-1',
        occupancy: 'commercial',
        racewayType: 'nm-b', // violates NEC 334.12
        wireGauge: '12',
        path: [
          [0, 2.55, 1],
          [2, 2.55, 1], // slices right through pipe-segment_1 at x=1!
        ],
        loadAmps: 16,
        voltage: 120,
        phases: 1,
      },
    }

    const report = auditSceneElectrical(scene)
    expect(report.passed).toBe(false)
    expect(report.findings.some((f) => f.codeRef === 'NEC 210.8(B)')).toBe(true)
    expect(report.findings.some((f) => f.codeRef === 'NEC 314.16')).toBe(true)
    expect(report.findings.some((f) => f.codeRef === 'NEC 334.12')).toBe(true)
    expect(report.findings.some((f) => f.category === 'trade-clash')).toBe(true)
  })

  test('Commercial 3-phase panel schedule spans 3-pole motor slots across A/B/C and exports valid CSV + BOM takeoff', () => {
    const panel = {
      id: 'elecpanel_1',
      type: 'electrical:panel',
      name: 'LP-1',
      occupancy: 'commercial',
      voltageSystem: '120/208V-3P',
      busRatingAmps: 225,
      mainBreakerAmps: 200,
      spaces: 12,
    }
    const devices = [
      {
        id: 'elecdev_1',
        type: 'electrical:device',
        name: 'AHU-1 3P Motor',
        panelId: 'elecpanel_1',
        circuitNumber: 1,
        poles: 3,
        breakerAmps: 40,
        loadVa: 9000, // 3000 VA on each of A, B, C
        boxType: '4-sq-2.125',
      },
      {
        id: 'elecdev_2',
        type: 'electrical:device',
        name: 'Office Lighting',
        panelId: 'elecpanel_1',
        circuitNumber: 2,
        poles: 1,
        breakerAmps: 20,
        loadVa: 1800, // Phase A
        boxType: '4-sq-1.5',
      },
    ]
    const runs = [
      {
        id: 'eleccond_1',
        type: 'electrical:conduit-run',
        panelId: 'elecpanel_1',
        circuitNumber: 1,
        racewayType: 'emt',
        tradeSize: '1"',
        wireGauge: '8',
        totalConductorCount: 4,
        path: [
          [0, 1.5, 0],
          [10, 1.5, 0],
        ],
      },
    ]

    const schedule = buildPanelSchedule(panel, devices, runs)
    expect(schedule.rows).toHaveLength(6)
    expect(schedule.rows[0]!.phaseLabel).toBe('A')
    expect(schedule.rows[1]!.phaseLabel).toBe('B')
    expect(schedule.rows[2]!.phaseLabel).toBe('C')
    // 3-pole breaker spans circuits 1, 3, 5
    expect(schedule.rows[0]!.left?.circuitNumber).toBe(1)
    expect(schedule.rows[1]!.left?.isContinuation).toBe(true)
    expect(schedule.rows[2]!.left?.isContinuation).toBe(true)
    expect(schedule.phaseVa.A).toBe(4800)
    expect(schedule.phaseVa.B).toBe(3000)
    expect(schedule.phaseVa.C).toBe(3000)
    expect(schedule.usedSpaces).toBe(4)

    const csv = formatPanelScheduleCsv(schedule)
    expect(csv).toContain('Left Ckt,Left Description')
    expect(csv).toContain('AHU-1 3P Motor')

    const takeoff = buildElectricalTakeoff({
      elecpanel_1: panel,
      elecdev_1: devices[0]!,
      elecdev_2: devices[1]!,
      eleccond_1: runs[0]!,
    })
    expect(takeoff.panelCount).toBe(1)
    expect(takeoff.deviceCount).toBe(2)
    expect(takeoff.conduitByTypeAndSize['1" EMT']?.sticks10Ft).toBeGreaterThan(0)
    expect(takeoff.breakersBySpec['3P-40A']).toBe(1)
  })

  test('BUG-01: 2-pole 208V wye load computes exact VA/V_LL phase amps, skips multi-pole spans, and flags slot collisions', () => {
    const panel = {
      id: 'elecpanel_wye',
      type: 'electrical:panel',
      name: 'LP-WYE',
      occupancy: 'commercial',
      voltageSystem: '120/208V-3P',
      busRatingAmps: 200,
      mainBreakerAmps: 200,
      spaces: 12,
    }
    const twoPole208 = {
      id: 'elecdev_2p',
      type: 'electrical:device',
      name: '208V Water Heater',
      panelId: 'elecpanel_wye',
      circuitNumber: 1, // spans 1 (Phase A) and 3 (Phase B)
      poles: 2,
      breakerAmps: 25,
      loadVa: 4160, // 4160 / 208V = 20.0A on Phase A and 20.0A on Phase B
    }
    const collidingSinglePole = {
      id: 'elecdev_collide',
      type: 'electrical:device',
      name: 'Colliding Outlet',
      panelId: 'elecpanel_wye',
      circuitNumber: 3, // collides with pole 2 of circuit 1!
      poles: 1,
      breakerAmps: 20,
      loadVa: 180,
    }

    expect(findNextFreePanelCircuit(panel, [twoPole208], 1)).toBe(2)
    expect(findNextFreePanelCircuit(panel, [twoPole208, { ...collidingSinglePole, circuitNumber: 2 }], 2)).toBe(4)

    const cleanSched = buildPanelSchedule(panel, [twoPole208])
    expect(cleanSched.phaseAmps.A).toBe(20)
    expect(cleanSched.phaseAmps.B).toBe(20)
    expect(cleanSched.phaseAmps.C).toBe(0)
    expect(cleanSched.slotConflicts).toHaveLength(0)

    const conflictReport = auditSceneElectrical({
      elecpanel_wye: panel,
      elecdev_2p: twoPole208,
      elecdev_collide: collidingSinglePole,
    })
    expect(conflictReport.findings.some((f) => f.codeRef === 'NEC 408.36')).toBe(true)
  })

  test('BUG-03: Flags NEC 240.4(D) when #14 AWG Cu is protected by a 20A breaker despite carrying <= 15A', () => {
    const scene = {
      elecpanel_1: {
        id: 'elecpanel_1',
        type: 'electrical:panel',
        name: 'MDP-1',
        voltageSystem: '120/240V-1P',
        busRatingAmps: 200,
        mainBreakerAmps: 200,
      },
      elecdev_1: {
        id: 'elecdev_1',
        type: 'electrical:device',
        name: 'Hall Outlet',
        panelId: 'elecpanel_1',
        circuitNumber: 1,
        poles: 1,
        breakerAmps: 20, // 20A OCPD > 15A max for #14 Cu!
        loadVa: 1440,
      },
      eleccond_1: {
        id: 'eleccond_1',
        type: 'electrical:conduit-run',
        name: 'CKT-1',
        panelId: 'elecpanel_1',
        targetDeviceId: 'elecdev_1',
        circuitNumber: 1,
        racewayType: 'emt',
        wireGauge: '14',
        loadAmps: 12,
        voltage: 120,
        phases: 1,
        path: [
          [0, 1.5, 0],
          [3, 1.5, 0],
        ],
      },
    }

    const report = auditSceneElectrical(scene)
    expect(report.passed).toBe(false)
    const ocpdFinding = report.findings.find((f) => f.codeRef === 'NEC 240.4(D)')
    expect(ocpdFinding).toBeDefined()
    expect(ocpdFinding?.suggestedFix).toContain('#12')
  })

  test('BUG-04: Local-yaw SAT eliminates 45° rotated panel false positives and audits electrical:transformer 110.26(A)/(E)', () => {
    // 1) 45° rotated panel facing (+X, +Z): cabinet to the side [0.7..1.1] x [-0.4..0.0] is outside 30" local width (lx >= 0.495 > 0.381)
    const rotatedCleanScene = {
      elecpanel_rot: {
        id: 'elecpanel_rot',
        type: 'electrical:panel',
        name: 'LP-45',
        position: [0, 1.52, 0],
        rotation: Math.PI / 4,
        voltageSystem: '120/240V-1P',
        condition110_26: 2,
        width: 0.4,
        depth: 0.14,
        height: 0.9,
      },
      cabinet_side: {
        id: 'cabinet_side',
        type: 'cabinet',
        position: [0.9, 0, -0.2],
        width: 0.4,
        depth: 0.4,
        height: 0.9,
      },
    }
    const cleanRotReport = auditSceneElectrical(rotatedCleanScene)
    expect(cleanRotReport.findings.filter((f) => f.codeRef === 'NEC 110.26(A)')).toHaveLength(0)

    // 2) Floor-mounted 480V transformer obstructed in front AND with overhead plumbing pipe at y = 2.1m (within 6 ft of top 0.95m)
    const txViolationScene = {
      electx_1: {
        id: 'electx_1',
        type: 'electrical:transformer',
        name: 'TX-1',
        position: [2, 0, 2],
        rotation: 0,
        primaryVoltage: 480,
        secondaryVoltage: 208,
        width: 0.76,
        depth: 0.64,
        height: 0.95,
      },
      item_crate: {
        id: 'item_crate',
        type: 'item',
        position: [2, 0, 2.8], // inside 42" front working space!
        width: 0.5,
        depth: 0.5,
        height: 1.0,
      },
      'pipe-segment_tx': {
        id: 'pipe-segment_tx',
        type: 'pipe-segment',
        diameter: 3,
        path: [
          [1, 2.1, 2],
          [3, 2.1, 2],
        ],
      },
    }
    const txReport = auditSceneElectrical(txViolationScene)
    expect(txReport.passed).toBe(false)
    expect(txReport.transformerCount).toBe(1)
    expect(
      txReport.findings.some((f) => f.codeRef === 'NEC 110.26(A)' && f.nodeIds.includes('electx_1')),
    ).toBe(true)
    expect(
      txReport.findings.some((f) => f.codeRef === 'NEC 110.26(E)' && f.nodeIds.includes('electx_1')),
    ).toBe(true)
  })
})
