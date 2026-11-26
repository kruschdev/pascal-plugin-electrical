/**
 * Auto-derived Pascal Inspector Parametrics for all 4 `electrical:*` node kinds.
 */

import type { ParametricDescriptor } from '@pascal-app/core'
import { ElectricalConduitRunNode } from './conduit-run'
import { DeviceKindEnum, ElectricalDeviceNode } from './device'
import type { ElectricalPanelNode } from './panel'
import type { ElectricalTransformerNode } from './transformer'

export const electricalPanelParametrics: ParametricDescriptor<ElectricalPanelNode> = {
  groups: [
    {
      label: 'Service & Phase',
      fields: [
        {
          key: 'occupancy',
          kind: 'enum',
          options: ['residential', 'commercial'],
          display: 'segmented',
        },
        {
          key: 'voltageSystem',
          kind: 'enum',
          options: ['120/240V-1P', '120/208V-3P', '277/480V-3P'],
          display: 'segmented',
        },
        {
          key: 'mainType',
          kind: 'enum',
          options: ['main-breaker', 'mlo'],
          display: 'segmented',
        },
      ],
    },
    {
      label: 'Ratings',
      fields: [
        { key: 'busRatingAmps', kind: 'number', unit: 'A', min: 60, max: 4000, step: 5 },
        { key: 'mainBreakerAmps', kind: 'number', unit: 'A', min: 60, max: 4000, step: 5 },
        { key: 'spaces', kind: 'number', min: 4, max: 84, step: 2 },
        { key: 'solarBackfeedAmps', kind: 'number', unit: 'A', min: 0, max: 400, step: 5 },
      ],
    },
    {
      label: 'NEC 110.26 Clearance & Busbar Preview',
      fields: [
        { key: 'coverRemoved', kind: 'boolean', label: 'Expose Interior Busbars' },
        { key: 'showClearanceZone', kind: 'boolean' },
        { key: 'condition110_26', kind: 'number', label: 'NEC 110.26 Condition', min: 1, max: 3, step: 1 },
        { key: 'nemaRating', kind: 'enum', options: ['NEMA-1', 'NEMA-3R', 'NEMA-4X'] },
      ],
    },
  ],
}

export const electricalDeviceParametrics: ParametricDescriptor<ElectricalDeviceNode> = {
  groups: [
    {
      label: 'Device & Circuit',
      fields: [
        {
          key: 'deviceKind',
          kind: 'enum',
          options: [...DeviceKindEnum.options],
        },
        {
          key: 'occupancy',
          kind: 'enum',
          options: ['residential', 'commercial'],
          display: 'segmented',
        },
        { key: 'circuitNumber', kind: 'number', min: 1, max: 84, step: 1 },
        { key: 'poles', kind: 'number', min: 1, max: 3, step: 1 },
        { key: 'breakerAmps', kind: 'number', unit: 'A', min: 15, max: 400, step: 5 },
        { key: 'loadVa', kind: 'number', unit: 'VA', min: 0, max: 200000, step: 60 },
        { key: 'continuous', kind: 'boolean' },
        { key: 'isMotor', kind: 'boolean', label: 'Motor Load (NEC 430)' },
        { key: 'gfciProtected', kind: 'boolean' },
        { key: 'afciProtected', kind: 'boolean' },
      ],
    },
    {
      label: 'NEC 314.16 Box Fill',
      fields: [
        {
          key: 'boxType',
          kind: 'enum',
          options: [
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
          ],
        },
        { key: 'wireGauge', kind: 'enum', options: [...ElectricalDeviceNode.shape.wireGauge.unwrap().options] },
        { key: 'conductorCount', kind: 'number', min: 0, max: 40, step: 1 },
        { key: 'yokeCount', kind: 'number', min: 0, max: 4, step: 1 },
        { key: 'clampCount', kind: 'number', min: 0, max: 6, step: 1 },
      ],
    },
  ],
}

export const electricalConduitRunParametrics: ParametricDescriptor<ElectricalConduitRunNode> = {
  groups: [
    {
      label: 'Raceway & Conductors',
      fields: [
        {
          key: 'occupancy',
          kind: 'enum',
          options: ['residential', 'commercial'],
          display: 'segmented',
        },
        {
          key: 'racewayType',
          kind: 'enum',
          options: ['nm-b', 'mc', 'emt', 'pvc-40', 'rmc'],
          display: 'segmented',
        },
        {
          key: 'tradeSize',
          kind: 'enum',
          options: ['1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"', '2"', '2-1/2"', '3"', '4"'],
        },
        {
          key: 'conductorMaterial',
          kind: 'enum',
          options: ['cu', 'al'],
          display: 'segmented',
        },
        {
          key: 'insulationRating',
          kind: 'enum',
          options: ['60C', '75C', '90C'],
          display: 'segmented',
        },
        {
          key: 'wireGauge',
          kind: 'enum',
          options: [...ElectricalConduitRunNode.shape.wireGauge.unwrap().options],
        },
        { key: 'currentCarryingCount', kind: 'number', min: 1, max: 60, step: 1 },
        { key: 'totalConductorCount', kind: 'number', min: 2, max: 80, step: 1 },
      ],
    },
    {
      label: 'Circuit & Environment',
      fields: [
        { key: 'circuitNumber', kind: 'number', min: 1, max: 84, step: 1 },
        { key: 'loadAmps', kind: 'number', unit: 'A', min: 0, max: 2000, step: 1 },
        { key: 'voltage', kind: 'number', unit: 'V', min: 12, max: 600, step: 1 },
        { key: 'phases', kind: 'number', min: 1, max: 3, step: 2 },
        { key: 'ambientTempC', kind: 'number', unit: '°C', min: -20, max: 80, step: 5 },
        { key: 'rooftopExposed', kind: 'boolean' },
        { key: 'inPlenum', kind: 'boolean' },
        { key: 'continuous', kind: 'boolean' },
      ],
    },
  ],
}

export const electricalTransformerParametrics: ParametricDescriptor<ElectricalTransformerNode> = {
  groups: [
    {
      label: 'Transformer Ratings',
      fields: [
        { key: 'kvaRating', kind: 'number', unit: 'kVA', min: 15, max: 1000, step: 15 },
        { key: 'primaryVoltage', kind: 'number', unit: 'V', min: 120, max: 600, step: 1 },
        { key: 'secondaryVoltage', kind: 'number', unit: 'V', min: 120, max: 600, step: 1 },
        { key: 'impedancePct', kind: 'number', unit: '%', min: 1, max: 10, step: 0.5 },
        { key: 'nemaRating', kind: 'enum', options: ['NEMA-1', 'NEMA-2', 'NEMA-3R'] },
        { key: 'showClearanceZone', kind: 'boolean' },
      ],
    },
  ],
}
