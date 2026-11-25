/**
 * Pure Zod-only Agent Tool Contracts (`@kruschdev/pascal-plugin-electrical/agent-tools`).
 * Conforms to Pascal DECISIONS.md E-016: zero Three.js, React, viewer, or editor imports.
 */

import type { PluginAgentTools } from '@pascal-app/core/agent-tools'
import { z } from 'zod'

const Vec3 = z.tuple([z.number(), z.number(), z.number()])

export const electricalAgentTools: PluginAgentTools = {
  pluginId: 'krusch:electrical',
  apiVersion: 1,
  version: '0.2.0',
  instructions:
    'Electrical ALWAYS yields to higher-priority trades (1. Structural, 2. Plumbing, 3. HVAC). Never relocate pipes or ducts to make room for electrical runs; use electrical_route_circuit to route around them and electrical_audit_nec to verify NEC 110.26 working/dedicated space, 220 loads, 310.16 ampacity, 314.16 box fill, Ch. 9 conduit fill, 358.26 bend limits, and voltage drop.',
  skills: [
    {
      name: 'nec-trade-priority-electrical',
      summary: 'Residential & Commercial NEC design workflow respecting plumbing and HVAC right-of-way',
      body: [
        '1. Place main/sub panels (`electrical_place_panel`) with clear NEC 110.26(A) working space (30"W x 36"/42"/48"D x 78"H) and clear NEC 110.26(E) overhead space (never directly under plumbing pipes or HVAC ducts).',
        '2. Place receptacles, GFCI/AFCI devices, switches, luminaires, EVSE, motor loads, and junction boxes (`electrical_place_device`) assigned to panel & circuit numbers.',
        '3. Route homeruns & branch conduits (`electrical_route_circuit`) so electrical automatically detours around existing Pascal pipe-segment, duct-segment, hvac-equipment, beam, and column obstacles.',
        '4. Run `electrical_calculate_load` (NEC Art. 220 Residential Standard/Optional or Commercial 1P/3P), `electrical_generate_schedule`, and `electrical_audit_nec` to confirm zero code or trade-clash errors.',
      ].join('\n'),
    },
  ],
  tools: [
    {
      name: 'electrical_place_panel',
      title: 'Place electrical panelboard',
      description:
        'Place a residential (120/240V 1Φ) or commercial (120/208V or 277/480V 3Φ) electrical panelboard on a level with NEC 110.26 working clearance.',
      runsIn: 'operation',
      input: {
        levelId: z.string().optional(),
        name: z.string().default('MDP-1'),
        position: Vec3,
        rotation: z.number().default(0),
        occupancy: z.enum(['residential', 'commercial']).default('residential'),
        voltageSystem: z.enum(['120/240V-1P', '120/208V-3P', '277/480V-3P']).default('120/240V-1P'),
        busRatingAmps: z.number().min(60).max(4000).default(200),
        mainBreakerAmps: z.number().min(60).max(4000).default(200),
        mainType: z.enum(['main-breaker', 'mlo']).default('main-breaker'),
        spaces: z.number().int().min(4).max(84).default(40),
        solarBackfeedAmps: z.number().min(0).max(400).default(0),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'electrical_place_transformer',
      title: 'Place commercial step-down transformer',
      description:
        'Place a commercial dry-type step-down transformer (e.g., 480V 3Φ primary to 120/208V 3Φ secondary) on a level with NEC Table 450.3(B) FLA/OCPD sizing and 110.26 working clearance.',
      runsIn: 'operation',
      input: {
        levelId: z.string().optional(),
        name: z.string().default('TX-1 (75 kVA)'),
        position: Vec3,
        rotation: z.number().default(0),
        kvaRating: z.number().min(15).max(1000).default(75),
        primaryVoltage: z.number().min(120).max(600).default(480),
        secondaryVoltage: z.number().min(120).max(600).default(208),
        fedFromPanelId: z.string().optional(),
        nemaRating: z.enum(['NEMA-1', 'NEMA-2', 'NEMA-3R']).default('NEMA-2'),
        showClearanceZone: z.boolean().default(true),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'electrical_place_device',
      title: 'Place electrical device or junction box',
      description:
        'Place a receptacle, GFCI/AFCI, switch, luminaire, EVSE, dedicated load, motor load, or junction box assigned to a panel and circuit.',
      runsIn: 'operation',
      input: {
        levelId: z.string().optional(),
        name: z.string().default('Receptacle'),
        position: Vec3,
        rotation: z.number().default(0),
        deviceKind: z
          .enum([
            'duplex',
            'gfci',
            'afci',
            'dedicated-240v',
            'evse',
            'switch-1p',
            'switch-3way',
            'luminaire',
            'exit-sign',
            'motor-load',
            'junction-box',
            'solar-inverter',
            'battery-ess',
            'transfer-switch',
            'generator-inlet',
            'rapid-shutdown',
            'spd',
            'vfd',
            'dimmer',
            'usb-duplex',
            'weatherproof-gfci',
            'floor-box',
            'smoke-co',
            'ceiling-fan',
            'under-cabinet-led',
          ])
          .default('duplex'),
        occupancy: z.enum(['residential', 'commercial']).default('residential'),
        panelId: z.string().optional(),
        circuitNumber: z.number().int().min(1).max(84).optional(),
        poles: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
        breakerAmps: z.number().min(15).max(400).default(20),
        loadVa: z.number().min(0).max(200000).default(180),
        continuous: z.boolean().default(false),
        gfciProtected: z.boolean().default(false),
        afciProtected: z.boolean().default(false),
        autoWire: z.boolean().default(true),
        boxType: z
          .enum([
            'single-gang-shallow',
            'single-gang-standard',
            'single-gang-deep',
            'two-gang-standard',
            'two-gang-deep',
            'three-gang-standard',
            '4-sq-1.25',
            '4-sq-1.5',
            '4-sq-2.125',
            '4-11-16-1.5',
            '4-11-16-2.125',
            '4-oct-1.5',
            '4-oct-2.125',
          ])
          .optional(),
        wireGauge: z
          .enum([
            '18', '16', '14', '12', '10', '8', '6', '4', '3', '2', '1',
            '1/0', '2/0', '3/0', '4/0',
            '250kcmil', '300kcmil', '350kcmil', '400kcmil', '500kcmil', '600kcmil', '750kcmil',
          ])
          .optional(),
        conductorCount: z.number().int().min(0).max(40).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'electrical_route_circuit',
      title: 'Route trade-aware electrical circuit',
      description:
        'Route a 3D electrical conduit or cable run from a panel to a device, automatically yielding around Pascal plumbing (pipe-*), HVAC (duct-*, hvac-equipment), and structural (beam, column) obstacles. Auto-sizes wireGauge and tradeSize when omitted.',
      runsIn: 'operation',
      input: {
        panelId: z.string(),
        targetDeviceId: z.string(),
        name: z.string().optional(),
        occupancy: z.enum(['residential', 'commercial']).optional(),
        racewayType: z.enum(['nm-b', 'mc', 'emt', 'pvc-40', 'rmc']).optional(),
        tradeSize: z
          .enum(['1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"', '2"', '2-1/2"', '3"', '4"'])
          .optional(),
        wireGauge: z
          .enum([
            '14', '12', '10', '8', '6', '4', '3', '2', '1',
            '1/0', '2/0', '3/0', '4/0',
            '250kcmil', '300kcmil', '350kcmil', '400kcmil', '500kcmil', '600kcmil', '750kcmil',
          ])
          .optional(),
        preferredChaseY: z.number().min(0.2).max(6).default(2.55),
        clearanceM: z.number().min(0.02).max(0.5).default(0.05),
        wallPlacement: z.enum(['in-wall', 'surface']).default('in-wall'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'electrical_calculate_load',
      title: 'Calculate NEC Article 220 service load',
      description:
        'Run a deterministic Residential (Standard or Optional 220.82) or Commercial (Table 220.12 / 220.44 / 430.24 1Φ or 3Φ) NEC Article 220 service load calculation from the live scene.',
      runsIn: 'operation',
      input: {
        occupancy: z.enum(['residential', 'commercial']).optional(),
        residentialMethod: z.enum(['standard', 'optional']).default('standard'),
        commercialBuildingType: z
          .enum([
            'office',
            'retail',
            'warehouse',
            'restaurant',
            'school',
            'healthcare',
            'industrial',
            'garage',
          ])
          .default('office'),
        voltageSystem: z.enum(['120/240V-1P', '120/208V-3P', '277/480V-3P']).optional(),
        fallbackSquareFootage: z.number().positive().optional(),
        conductorMaterial: z.enum(['cu', 'al']).default('cu'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'electrical_audit_nec',
      title: 'Audit scene for NEC & trade-clash compliance',
      description:
        'Audit all electrical panels, transformers, devices, and runs against NEC 110.26(A)/(E) working & dedicated space, prohibited locations & restricted zones (NEC 240.24(A)/(D)/(E)/(F) panels in bathrooms/closets/stairways or >6\'-7", NEC 312.2 / 450.22 outdoor NEMA rating, NEC 406.9(C) / 404.4(C) / 410.10(D) tub & shower zones, NEC 210.52(C) stove & 406.5(E) sink hazards, NEC 410.16(C) closet lighting, NEC 210.11(C)(1)/(3) dedicated bath/kitchen circuit isolation), plumbing/HVAC/structural trade clashes, 358.26 bend limits, 310.16 ampacity, 240.4(D) small-conductor OCPD caps, Ch. 9 conduit fill, 314.16 box fill, 210.19 voltage drop, GFCI/AFCI, and 705.12 solar busbar limits.',
      runsIn: 'operation',
      input: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'electrical_generate_schedule',
      title: 'Generate panel schedules & material takeoff',
      description:
        'Generate odd/even split-phase (L1/L2) or three-phase (A/B/C) breaker panel schedules, phase balance %, CSV export, and priced electrical bill of materials with labor estimates.',
      runsIn: 'operation',
      rendersView: true,
      input: {
        panelId: z.string().optional(),
        laborRatePerHourUsd: z.number().min(0).max(500).optional(),
        materialMarkupPct: z.number().min(0).max(200).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'electrical_autopopulate_nec',
      title: 'Auto-populate NEC minimum layout, circuits, home runs & daisy-chain wiring',
      description:
        'Analyze Pascal walls, doors, stairs, and room zones to auto-populate NEC minimum receptacles (6ft/12ft wall rule, 4ft kitchen countertops on 2x 20A SAB circuits, bathroom/laundry/garage/outdoor WR GFCIs, front-door & stairway outlets/3-way switches/lights), group into balanced panel circuits (with GFCI outlets or GFCI/AFCI breakers), and route home runs plus outlet-to-outlet daisy-chain branch wiring around plumbing, HVAC, and structural obstacles.',
      runsIn: 'operation',
      input: {
        levelId: z.string().optional(),
        occupancy: z.enum(['residential', 'commercial']).optional(),
        protectionMode: z
          .enum(['hybrid', 'gfci-breakers', 'gfci-receptacles'])
          .default('hybrid'),
        racewayType: z.enum(['nm-b', 'mc', 'emt', 'pvc-40', 'rmc']).optional(),
        preferredChaseY: z.number().min(0.4).max(6).default(2.55),
        includeLighting: z.boolean().default(true),
        includeSmokeAlarms: z.boolean().optional(),
        includeWiring: z.boolean().default(true),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
  ],
}
