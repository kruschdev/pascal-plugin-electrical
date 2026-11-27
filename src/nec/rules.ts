/**
 * Layer 3 — Single-Source Declarative NEC Code Rule Table (`@kruschdev/pascal-plugin-electrical`).
 *
 * Expresses NEC spatial, elevation, working-space, fixture-keepout, opening-keepout, raceway-bend,
 * and wiring-method constraints ONCE as typed `DeclarativeRule[]` data (`INV-MEP-08`) consumed by
 * BOTH placement/routing generators (`autopopulate.ts`, `routing.ts`) AND the live scene auditor
 * (`audit.ts`) so placement and audit thresholds can never drift.
 *
 * Pure framework-free TypeScript (`INV-MEP-01`): zero React, Three.js, `@pascal-app/*`, or `node:*`.
 */

import {
  type DeclarativeRule,
  type DeclarativeRuleByKind,
  type DeclarativeRuleKind,
  type ElevationBandRule,
  type FixtureKeepoutRule,
  type MaterialPolicyRule,
  type OpeningKeepoutRule,
  type ProhibitedZoneRule,
  type RoutingConstraintRule,
  type WorkingSpaceRule,
  effectivePlacementThreshold,
  validateRuleTable,
} from '@kruschdev/pascal-mep-kernel'
import { INCHES_TO_METERS } from './tables'

export type NecRuleId =
  | 'nec-110-26a-working-space'
  | 'nec-110-26e-dedicated-space'
  | 'nec-240-24a-handle-height'
  | 'nec-240-24de-prohibited-panel-zone'
  | 'nec-406-9c-tub-receptacle'
  | 'nec-404-4c-tub-switch'
  | 'nec-410-10d-tub-luminaire'
  | 'nec-210-52c-stove-receptacle'
  | 'nec-406-5e-sink-receptacle'
  | 'nec-410-16c-closet-luminaire'
  | 'nec-210-52a2-opening-keepout'
  | 'nec-358-26-raceway-bends'
  | 'nec-334-12-nmb-policy'

function roundThreshold(v: number): number {
  return Math.round(v * 10000) / 10000
}

const RULE_110_26A_WORKING_SPACE: WorkingSpaceRule = {
  id: 'nec-110-26a-working-space',
  trade: 'electrical',
  codeRef: 'NEC 110.26(A)',
  severity: 'error',
  category: 'working-space',
  title: 'Equipment working space clearance (30"W x 36"D x 78"H)',
  suggestedFix:
    'Relocate equipment or clear obstructions at least 30"W x 36"D x 78"H in front of the panel/transformer.',
  kind: 'working-space',
  params: {
    targetKinds: ['electrical:panel', 'electrical:transformer', 'panel', 'transformer'],
    widthM: 30 * INCHES_TO_METERS,
    depthM: 36 * INCHES_TO_METERS,
    heightM: 78 * INCHES_TO_METERS,
  },
}

const RULE_110_26E_DEDICATED_SPACE: WorkingSpaceRule = {
  id: 'nec-110-26e-dedicated-space',
  trade: 'electrical',
  codeRef: 'NEC 110.26(E)',
  severity: 'error',
  category: 'dedicated-space',
  title: 'Dedicated electrical overhead space (6 ft above equipment)',
  suggestedFix:
    'Relocate panelboard/transformer clear of foreign piping/ducts or add NEC 110.26(E)(1)(a) leak protection above structural ceiling.',
  kind: 'working-space',
  params: {
    targetKinds: ['electrical:panel', 'electrical:transformer', 'panel', 'transformer'],
    widthM: 0.4,
    depthM: 0.14,
    heightM: 0,
    dedicatedOverheadHeightM: 1.829,
  },
}

const RULE_240_24A_HANDLE_HEIGHT: ElevationBandRule = {
  id: 'nec-240-24a-handle-height',
  trade: 'electrical',
  codeRef: 'NEC 240.24(A)',
  severity: 'error',
  category: 'prohibited-location',
  title: 'Overcurrent device max handle height (6\'-7" / 2.007 m)',
  suggestedFix:
    'Lower panelboard center elevation so the highest circuit breaker handle is <= 6\'-7" (2.007 m) AFF.',
  kind: 'elevation-band',
  params: {
    targetKinds: ['electrical:panel', 'panel'],
    maxHandleHeightM: 2.007,
  },
}

const RULE_240_24DE_PROHIBITED_PANEL_ZONE: ProhibitedZoneRule = {
  id: 'nec-240-24de-prohibited-panel-zone',
  trade: 'electrical',
  codeRef: 'NEC 240.24(D)/(E) & 312.2',
  severity: 'error',
  category: 'prohibited-location',
  title: 'Panelboard prohibited in bathrooms, clothes closets, or outdoors (NEMA-1)',
  suggestedFix:
    'Relocate panelboard outside bathrooms/clothes closets to a hallway, utility room, or garage, or upgrade enclosure to NEMA-3R/4X outdoors.',
  kind: 'prohibited-zone',
  params: {
    targetKinds: ['electrical:panel', 'panel'],
    prohibitedRoomCategories: ['bathroom', 'closet'],
    forbiddenNemaOutdoors: ['NEMA-1'],
  },
}

const RULE_406_9C_TUB_RECEPTACLE: FixtureKeepoutRule = {
  id: 'nec-406-9c-tub-receptacle',
  trade: 'electrical',
  codeRef: 'NEC 406.9(C)',
  severity: 'error',
  category: 'prohibited-location',
  title: 'Receptacle prohibited within bathtub/shower restricted zone (3 ft H x 8 ft V)',
  suggestedFix: 'Move receptacle at least 3 ft (0.914 m) horizontally outside the bathtub/shower rim.',
  placementMarginM: 0.011,
  kind: 'fixture-keepout',
  params: {
    targetRoles: ['receptacle'],
    fixtureKinds: ['tub-shower'],
    minHorizontalM: 0.914,
    maxVerticalM: 2.438,
    respectWallSeparation: true,
  },
}

const RULE_404_4C_TUB_SWITCH: FixtureKeepoutRule = {
  id: 'nec-404-4c-tub-switch',
  trade: 'electrical',
  codeRef: 'NEC 404.4(C)',
  severity: 'error',
  category: 'prohibited-location',
  title: 'Wall switch prohibited inside bathtub/shower wet space',
  suggestedFix: 'Relocate wall switch outside the tub/shower enclosure.',
  placementMarginM: 0.1,
  kind: 'fixture-keepout',
  params: {
    targetRoles: ['switch'],
    fixtureKinds: ['tub-shower'],
    minHorizontalM: 0.15,
    respectWallSeparation: true,
  },
}

const RULE_410_10D_TUB_LUMINAIRE: FixtureKeepoutRule = {
  id: 'nec-410-10d-tub-luminaire',
  trade: 'electrical',
  codeRef: 'NEC 410.10(D)',
  severity: 'error',
  category: 'prohibited-location',
  title: 'Luminaire prohibited below 8 ft within bathtub/shower zone',
  suggestedFix: 'Raise luminaire to >= 8 ft (2.438 m) AFF or move >= 3 ft outside the tub/shower rim.',
  placementMarginM: 0.011,
  kind: 'fixture-keepout',
  params: {
    targetRoles: ['luminaire'],
    fixtureKinds: ['tub-shower'],
    minHorizontalM: 0.914,
    maxVerticalM: 2.438,
    respectWallSeparation: true,
  },
}

const RULE_210_52C_STOVE_RECEPTACLE: FixtureKeepoutRule = {
  id: 'nec-210-52c-stove-receptacle',
  trade: 'electrical',
  codeRef: 'NEC 210.52(C) / 110.11',
  severity: 'error',
  category: 'prohibited-location',
  title: 'Receptacle prohibited directly over stove/cooktop surface',
  suggestedFix: 'Shift receptacle laterally onto adjacent countertop wall clear of the cooktop.',
  placementMarginM: 0.07,
  kind: 'fixture-keepout',
  params: {
    targetRoles: ['receptacle'],
    fixtureKinds: ['stove'],
    minHorizontalM: 0.08,
    verticalBandM: [0.75, 1.65],
    respectWallSeparation: true,
  },
}

const RULE_406_5E_SINK_RECEPTACLE: FixtureKeepoutRule = {
  id: 'nec-406-5e-sink-receptacle',
  trade: 'electrical',
  codeRef: 'NEC 406.5(E)',
  severity: 'error',
  category: 'prohibited-location',
  title: 'Receptacle prohibited inside sink basin footprint',
  suggestedFix: 'Move receptacle to the wall beside the sink (>= 44" AFF) with GFCI protection.',
  placementMarginM: 0.25,
  kind: 'fixture-keepout',
  params: {
    targetRoles: ['receptacle'],
    fixtureKinds: ['sink'],
    minHorizontalM: 0.0,
    maxVerticalM: 1.05,
    respectWallSeparation: true,
  },
}

const RULE_410_16C_CLOSET_LUMINAIRE: ElevationBandRule = {
  id: 'nec-410-16c-closet-luminaire',
  trade: 'electrical',
  codeRef: 'NEC 410.16(C)',
  severity: 'error',
  category: 'prohibited-location',
  title: 'Closet luminaire minimum mounting height (2.1 m AFF)',
  suggestedFix: 'Raise closet luminaire to ceiling height (>= 2.1 m) with an enclosed LED fixture.',
  kind: 'elevation-band',
  params: {
    targetKinds: ['luminaire', 'ceiling-fan', 'under-cabinet-led', 'exterior-light'],
    minYM: 2.1,
  },
}

const RULE_210_52A2_OPENING_KEEPOUT: OpeningKeepoutRule = {
  id: 'nec-210-52a2-opening-keepout',
  trade: 'electrical',
  codeRef: 'NEC 210.52(A)(2)(1)',
  severity: 'error',
  category: 'prohibited-location',
  title: 'Wall opening keepout (doors, floor-to-ceiling glazing, window trim clearance)',
  suggestedFix: 'Shift wall device outside door/window openings and trim clearance.',
  kind: 'opening-keepout',
  params: {
    targetRoles: ['receptacle', 'switch', 'device'],
    blockDoors: true,
    blockWindows: true,
    floorToCeilingSillThresholdM: 0.52,
    trimClearanceM: 0.14,
  },
}

const RULE_358_26_RACEWAY_BENDS: RoutingConstraintRule = {
  id: 'nec-358-26-raceway-bends',
  trade: 'electrical',
  codeRef: 'NEC 358.26',
  severity: 'error',
  category: 'raceway-bends',
  title: 'Rigid conduit total bends between pull points <= 360°',
  suggestedFix: 'Split the run with an accessible junction/pull box (electrical:device junction-box).',
  kind: 'routing-constraint',
  params: {
    targetSystems: ['emt', 'pvc-40', 'rmc'],
    maxBendDegrees: 360,
  },
}

const RULE_334_12_NMB_POLICY: MaterialPolicyRule = {
  id: 'nec-334-12-nmb-policy',
  trade: 'electrical',
  codeRef: 'NEC 334.12 / 300.22(C)',
  severity: 'error',
  category: 'wiring-method',
  title: 'NM-B cable prohibited in commercial, plenum, and wet crawlspace locations',
  suggestedFix:
    'Switch racewayType to "emt", "mc", "rmc", or wet-rated "pvc-40" with THWN-2, or reroute through dry cavities.',
  kind: 'material-policy',
  params: {
    targetSystems: ['nm-b'],
    forbiddenInCommercial: true,
    forbiddenInPlenum: true,
    forbiddenInWetCrawlspace: true,
  },
}

/**
 * Authoritative single-source NEC declarative rule table (`INV-MEP-08`).
 * Consumed by both placement/routing generators and post-hoc compliance auditors.
 */
export const NEC_DECLARATIVE_RULES: readonly DeclarativeRule[] = Object.freeze([
  RULE_110_26A_WORKING_SPACE,
  RULE_110_26E_DEDICATED_SPACE,
  RULE_240_24A_HANDLE_HEIGHT,
  RULE_240_24DE_PROHIBITED_PANEL_ZONE,
  RULE_406_9C_TUB_RECEPTACLE,
  RULE_404_4C_TUB_SWITCH,
  RULE_410_10D_TUB_LUMINAIRE,
  RULE_210_52C_STOVE_RECEPTACLE,
  RULE_406_5E_SINK_RECEPTACLE,
  RULE_410_16C_CLOSET_LUMINAIRE,
  RULE_210_52A2_OPENING_KEEPOUT,
  RULE_358_26_RACEWAY_BENDS,
  RULE_334_12_NMB_POLICY,
])

const NEC_RULE_BY_ID: ReadonlyMap<string, DeclarativeRule> = new Map(
  NEC_DECLARATIVE_RULES.map((rule) => [rule.id, rule]),
)

/**
 * Look up a canonical NEC declarative rule by ID, optionally narrowing its `kind`.
 */
export function getNecRuleById(id: string): DeclarativeRule | undefined
export function getNecRuleById<K extends DeclarativeRuleKind>(
  id: string,
  kind: K,
): DeclarativeRuleByKind<K> | undefined
export function getNecRuleById<K extends DeclarativeRuleKind>(
  id: string,
  kind?: K,
): DeclarativeRule | DeclarativeRuleByKind<K> | undefined {
  const rule = NEC_RULE_BY_ID.get(id)
  if (!rule) return undefined
  if (kind !== undefined && rule.kind !== kind) return undefined
  return rule as DeclarativeRuleByKind<K>
}

/** Focused rule slices for targeted `evaluatePlacementCandidate` calls without re-scanning unrelated rules. */
export const NEC_PANEL_ZONE_RULES: readonly ProhibitedZoneRule[] = Object.freeze([
  RULE_240_24DE_PROHIBITED_PANEL_ZONE,
])

export const NEC_FIXTURE_KEEPOUT_RULES: readonly FixtureKeepoutRule[] = Object.freeze([
  RULE_406_9C_TUB_RECEPTACLE,
  RULE_404_4C_TUB_SWITCH,
  RULE_410_10D_TUB_LUMINAIRE,
  RULE_210_52C_STOVE_RECEPTACLE,
  RULE_406_5E_SINK_RECEPTACLE,
])

export const NEC_OPENING_KEEPOUT_RULES: readonly OpeningKeepoutRule[] = Object.freeze([
  RULE_210_52A2_OPENING_KEEPOUT,
])

export const NEC_RACEWAY_BEND_RULES: readonly RoutingConstraintRule[] = Object.freeze([
  RULE_358_26_RACEWAY_BENDS,
])

export const NEC_MATERIAL_POLICY_RULES: readonly MaterialPolicyRule[] = Object.freeze([
  RULE_334_12_NMB_POLICY,
])

export const NEC_RULE_TABLE_VALIDATION = validateRuleTable(NEC_DECLARATIVE_RULES)
if (!NEC_RULE_TABLE_VALIDATION.valid) {
  throw new Error(
    `Invalid NEC_DECLARATIVE_RULES table: ${NEC_RULE_TABLE_VALIDATION.errors.join('; ')}`,
  )
}

/**
 * Typed audit & placement thresholds derived strictly from `NEC_DECLARATIVE_RULES`
 * via `effectivePlacementThreshold` (`INV-MEP-08`). Zero duplicated literals.
 */
export const NEC_RULE_THRESHOLDS = Object.freeze({
  workingSpace: Object.freeze({
    widthM: RULE_110_26A_WORKING_SPACE.params.widthM,
    depthM: RULE_110_26A_WORKING_SPACE.params.depthM,
    heightM: RULE_110_26A_WORKING_SPACE.params.heightM,
  }),
  dedicatedOverheadHeightM: RULE_110_26E_DEDICATED_SPACE.params.dedicatedOverheadHeightM!,
  panelMaxHandleHeightM: RULE_240_24A_HANDLE_HEIGHT.params.maxHandleHeightM!,
  panelProhibitedCategories: RULE_240_24DE_PROHIBITED_PANEL_ZONE.params.prohibitedRoomCategories,
  panelForbiddenOutdoorNema: RULE_240_24DE_PROHIBITED_PANEL_ZONE.params.forbiddenNemaOutdoors!,
  tubReceptacle: Object.freeze({
    auditMinHorizontalM: RULE_406_9C_TUB_RECEPTACLE.params.minHorizontalM,
    placementMinHorizontalM: roundThreshold(
      effectivePlacementThreshold(
        RULE_406_9C_TUB_RECEPTACLE.params.minHorizontalM,
        RULE_406_9C_TUB_RECEPTACLE.placementMarginM,
        'min',
      ),
    ),
    auditMaxVerticalM: RULE_406_9C_TUB_RECEPTACLE.params.maxVerticalM!,
    placementMaxVerticalM: roundThreshold(
      effectivePlacementThreshold(
        RULE_406_9C_TUB_RECEPTACLE.params.maxVerticalM!,
        RULE_406_9C_TUB_RECEPTACLE.placementMarginM,
        'min',
      ),
    ),
  }),
  tubSwitch: Object.freeze({
    auditMinHorizontalM: RULE_404_4C_TUB_SWITCH.params.minHorizontalM,
    placementMinHorizontalM: roundThreshold(
      effectivePlacementThreshold(
        RULE_404_4C_TUB_SWITCH.params.minHorizontalM,
        RULE_404_4C_TUB_SWITCH.placementMarginM,
        'min',
      ),
    ),
  }),
  tubLuminaire: Object.freeze({
    auditMinHorizontalM: RULE_410_10D_TUB_LUMINAIRE.params.minHorizontalM,
    placementMinHorizontalM: roundThreshold(
      effectivePlacementThreshold(
        RULE_410_10D_TUB_LUMINAIRE.params.minHorizontalM,
        RULE_410_10D_TUB_LUMINAIRE.placementMarginM,
        'min',
      ),
    ),
    auditMaxVerticalM: RULE_410_10D_TUB_LUMINAIRE.params.maxVerticalM!,
    placementMaxVerticalM: roundThreshold(
      effectivePlacementThreshold(
        RULE_410_10D_TUB_LUMINAIRE.params.maxVerticalM!,
        RULE_410_10D_TUB_LUMINAIRE.placementMarginM,
        'min',
      ),
    ),
  }),
  stoveReceptacle: Object.freeze({
    auditMinHorizontalM: RULE_210_52C_STOVE_RECEPTACLE.params.minHorizontalM,
    placementMinHorizontalM: roundThreshold(
      effectivePlacementThreshold(
        RULE_210_52C_STOVE_RECEPTACLE.params.minHorizontalM,
        RULE_210_52C_STOVE_RECEPTACLE.placementMarginM,
        'min',
      ),
    ),
    auditVerticalBandM: RULE_210_52C_STOVE_RECEPTACLE.params.verticalBandM!,
    placementVerticalBandM: Object.freeze([
      roundThreshold(
        effectivePlacementThreshold(
          RULE_210_52C_STOVE_RECEPTACLE.params.verticalBandM![0],
          RULE_210_52C_STOVE_RECEPTACLE.placementMarginM,
          'max',
        ),
      ),
      roundThreshold(
        effectivePlacementThreshold(
          RULE_210_52C_STOVE_RECEPTACLE.params.verticalBandM![1],
          RULE_210_52C_STOVE_RECEPTACLE.placementMarginM,
          'min',
        ),
      ),
    ] as const),
  }),
  sinkReceptacle: Object.freeze({
    auditMinHorizontalM: RULE_406_5E_SINK_RECEPTACLE.params.minHorizontalM,
    placementMinHorizontalM: roundThreshold(
      effectivePlacementThreshold(
        RULE_406_5E_SINK_RECEPTACLE.params.minHorizontalM,
        RULE_406_5E_SINK_RECEPTACLE.placementMarginM,
        'min',
      ),
    ),
    auditMaxVerticalM: RULE_406_5E_SINK_RECEPTACLE.params.maxVerticalM!,
    placementMaxVerticalM: roundThreshold(
      effectivePlacementThreshold(
        RULE_406_5E_SINK_RECEPTACLE.params.maxVerticalM!,
        RULE_406_5E_SINK_RECEPTACLE.placementMarginM,
        'min',
      ),
    ),
  }),
  closetLuminaireMinYM: RULE_410_16C_CLOSET_LUMINAIRE.params.minYM!,
  openingKeepout: Object.freeze({
    blockDoors: RULE_210_52A2_OPENING_KEEPOUT.params.blockDoors,
    blockWindows: RULE_210_52A2_OPENING_KEEPOUT.params.blockWindows,
    floorToCeilingSillThresholdM: RULE_210_52A2_OPENING_KEEPOUT.params.floorToCeilingSillThresholdM!,
    trimClearanceM: RULE_210_52A2_OPENING_KEEPOUT.params.trimClearanceM,
  }),
  racewayMaxBendDegrees: RULE_358_26_RACEWAY_BENDS.params.maxBendDegrees!,
  rigidRacewaySystems: RULE_358_26_RACEWAY_BENDS.params.targetSystems,
  nmbPolicy: Object.freeze({
    targetSystems: RULE_334_12_NMB_POLICY.params.targetSystems,
    forbiddenInCommercial: RULE_334_12_NMB_POLICY.params.forbiddenInCommercial === true,
    forbiddenInPlenum: RULE_334_12_NMB_POLICY.params.forbiddenInPlenum === true,
    forbiddenInWetCrawlspace: RULE_334_12_NMB_POLICY.params.forbiddenInWetCrawlspace === true,
  }),
})
