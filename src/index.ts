/**
 * Main browser entry (`@kruschdev/pascal-plugin-electrical`).
 *
 * Exports the full Pascal Plugin API v1 surface:
 * - `electricalPlugin`: Core `Plugin` manifest (`apiVersion: 1`, 4 `electrical:*` node kinds + InspectorExtension)
 * - `electricalHostPanel`: Left-rail `EditorHostPanel`
 * - `electricalScheduleView`: Full-pane `EditorHostView` (Panel Schedule, NEC 220 Load Calc, Audit, Takeoff)
 * - `electricalChatExtension`: `PluginChatExtension` (`/` actions + lazy tool result cards)
 *
 * Separate subpath exports:
 * - `./render` (`electricalRenderPlugin`): Editor-free read-only viewer manifest
 * - `./nec`: Pure deterministic Residential & Commercial NEC + Trade-Priority Routing engine
 * - `./agent-tools`: Pure Zod-only `PluginAgentTools` (`DECISIONS.md` E-016)
 * - `./agent-operations`: Pure `AgentOperations` for MCP / detached runtime / live chat
 */

import type { AnyNodeDefinition, InspectorExtension, Plugin } from '@pascal-app/core'
import type { EditorHostPanel, EditorHostView, PluginChatExtension } from '@pascal-app/editor'
import { electricalConduitRunRenderDefinition } from './nodes/conduit-run'
import { electricalDeviceRenderDefinition } from './nodes/device'
import { electricalPanelRenderDefinition } from './nodes/panel'
import {
  electricalConduitRunParametrics,
  electricalDeviceParametrics,
  electricalPanelParametrics,
  electricalTransformerParametrics,
} from './nodes/parametrics'
import { electricalTransformerRenderDefinition } from './nodes/transformer'
import { ELECTRICAL_PLUGIN_ID, electricalRenderPlugin } from './render'
import { ELECTRICAL_SCHEDULE_VIEW_ID } from './ui/electrical-panel'

export const electricalInspectorExtensions: InspectorExtension[] = [
  {
    id: `${ELECTRICAL_PLUGIN_ID}:nec-diagnostics`,
    pluginId: ELECTRICAL_PLUGIN_ID,
    kinds: [
      'electrical:panel',
      'electrical:device',
      'electrical:conduit-run',
      'electrical:transformer',
    ],
    icon: { kind: 'iconify', name: 'lucide:zap' },
    title: 'NEC Engineering',
    component: () => import('./ui/inspector-card'),
  },
]

export const electricalPanelDefinition = {
  ...electricalPanelRenderDefinition,
  snapProfile: 'item' as const,
  parametrics: electricalPanelParametrics,
}

export const electricalDeviceDefinition = {
  ...electricalDeviceRenderDefinition,
  snapProfile: 'item' as const,
  parametrics: electricalDeviceParametrics,
}

export const electricalConduitRunDefinition = {
  ...electricalConduitRunRenderDefinition,
  snapProfile: 'structural' as const,
  parametrics: electricalConduitRunParametrics,
}

export const electricalTransformerDefinition = {
  ...electricalTransformerRenderDefinition,
  snapProfile: 'item' as const,
  parametrics: electricalTransformerParametrics,
}

export const electricalPlugin: Plugin = {
  ...electricalRenderPlugin,
  nodes: [
    electricalPanelDefinition as unknown as AnyNodeDefinition,
    electricalDeviceDefinition as unknown as AnyNodeDefinition,
    electricalConduitRunDefinition as unknown as AnyNodeDefinition,
    electricalTransformerDefinition as unknown as AnyNodeDefinition,
  ],
  inspectorExtensions: electricalInspectorExtensions,
}

export const electricalHostPanel: EditorHostPanel = {
  id: `${ELECTRICAL_PLUGIN_ID}:panel`,
  pluginId: ELECTRICAL_PLUGIN_ID,
  label: 'Electrical',
  summary: 'Residential & Commercial NEC electrical panels, devices, trade-aware conduit routing, and schedules.',
  description:
    'Author editable residential (120/240V 1Φ) and commercial (120/208V, 277/480V 3Φ) electrical systems with NEC Article 220 load calculations, Table 310.16 ampacity derating, Ch. 9 conduit fill, 314.16 box fill, 110.26 working clearance envelopes, and automatic conduit routing that yields around plumbing, HVAC, and structural obstacles.',
  category: 'MEP & Engineering',
  creator: {
    name: 'Kevin Ruschman (@kruschdev)',
    url: 'https://github.com/kruschdev',
  },
  pluginUrl: 'https://github.com/kruschdev/pascal-plugin-electrical',
  icon: { kind: 'iconify', name: 'lucide:zap' },
  component: () => import('./ui/electrical-panel'),
  defaultInstalled: false,
}

export const electricalScheduleView: EditorHostView = {
  id: ELECTRICAL_SCHEDULE_VIEW_ID,
  pluginId: ELECTRICAL_PLUGIN_ID,
  label: 'Electrical Schedule',
  description: 'Split-phase & 3-phase panelboard schedules, NEC 220 load calculation, code audit, and material takeoff.',
  icon: { kind: 'iconify', name: 'lucide:table' },
  component: () => import('./ui/schedule-view'),
  workspaces: ['edit'],
  defaultPinned: false,
}

export const electricalChatExtension: PluginChatExtension = {
  pluginId: ELECTRICAL_PLUGIN_ID,
  cards: {
    electrical_audit_nec: () => import('./ui/chat-card'),
    electrical_generate_schedule: () => import('./ui/chat-card'),
    electrical_route_circuit: () => import('./ui/chat-card'),
  },
  actions: [
    {
      id: 'nec-audit',
      label: 'NEC & Trade Audit',
      hint: 'Check 110.26 clearance, trade clashes, box/conduit fill & voltage drop',
      prompt: 'Run electrical_audit_nec on this scene and summarize any NEC or plumbing/HVAC clearance issues.',
    },
    {
      id: 'panel-schedule',
      label: 'Panel Schedule & Takeoff',
      hint: 'Generate L1/L2 or 3Φ A/B/C breaker schedule and BOM',
      prompt: 'Run electrical_generate_schedule and open the electrical schedule view.',
    },
    {
      id: 'nec-load-calc',
      label: 'NEC 220 Load Calc',
      hint: 'Calculate Residential or Commercial service load & feeder sizing',
      prompt: 'Run electrical_calculate_load for this building and recommend service and feeder sizes.',
    },
  ],
}

export {
  ELECTRICAL_PLUGIN_ID,
  electricalRenderPlugin,
  ElectricalPanelNode,
  ElectricalDeviceNode,
  DeviceKindEnum,
  ElectricalConduitRunNode,
  ElectricalTransformerNode,
} from './render'
export { ELECTRICAL_SCHEDULE_VIEW_ID } from './ui/electrical-panel'
export * from './nec'
