/**
 * Read-only viewer entry (`@kruschdev/pascal-plugin-electrical/render`).
 * Same plugin ID, contract version, schemas, defaults, 3D geometry, and 2D floorplan symbols
 * as `electricalPlugin`, with ZERO imports from `@pascal-app/editor` or `next`.
 */

import type { AnyNodeDefinition, Plugin } from '@pascal-app/core'
import { electricalConduitRunRenderDefinition } from './nodes/conduit-run'
import { electricalDeviceRenderDefinition } from './nodes/device'
import { electricalPanelRenderDefinition } from './nodes/panel'
import { electricalTransformerRenderDefinition } from './nodes/transformer'

export const ELECTRICAL_PLUGIN_ID = 'krusch:electrical' as const
export const ELECTRICAL_SCHEDULE_VIEW_ID = 'krusch:electrical:schedule' as const

export const electricalRenderPlugin: Plugin = {
  id: ELECTRICAL_PLUGIN_ID,
  apiVersion: 1,
  nodes: [
    electricalPanelRenderDefinition as unknown as AnyNodeDefinition,
    electricalDeviceRenderDefinition as unknown as AnyNodeDefinition,
    electricalConduitRunRenderDefinition as unknown as AnyNodeDefinition,
    electricalTransformerRenderDefinition as unknown as AnyNodeDefinition,
  ],
}

export {
  ElectricalPanelNode,
  electricalPanelRenderDefinition,
  buildElectricalPanelGeometry,
  buildElectricalPanelFloorplan,
  getElectricalPanelPorts,
} from './nodes/panel'

export {
  ElectricalDeviceNode,
  DeviceKindEnum,
  electricalDeviceRenderDefinition,
  buildElectricalDeviceGeometry,
  buildElectricalDeviceFloorplan,
  getElectricalDevicePorts,
} from './nodes/device'

export {
  ElectricalConduitRunNode,
  electricalConduitRunRenderDefinition,
  buildElectricalConduitRunGeometry,
  buildElectricalConduitRunFloorplan,
  getElectricalConduitRunPorts,
} from './nodes/conduit-run'

export {
  ElectricalTransformerNode,
  electricalTransformerRenderDefinition,
  buildElectricalTransformerGeometry,
  buildElectricalTransformerFloorplan,
  getElectricalTransformerPorts,
} from './nodes/transformer'
