/**
 * Plugin-local Zustand store (`krusch:electrical`).
 * Never extends or mutates Pascal's `useScene`, `useEditor`, or `useViewer` stores.
 */

import { create } from 'zustand'
import type { CommercialOccupancy, OccupancyType } from '../nec/tables'

export type ScheduleTab = 'schedule' | 'load-calc' | 'audit' | 'takeoff'

type ElectricalUiState = {
  occupancy: OccupancyType
  residentialMethod: 'standard' | 'optional'
  commercialBuildingType: CommercialOccupancy
  activeTab: ScheduleTab
  selectedPanelId: string | null
  setOccupancy: (occupancy: OccupancyType) => void
  setResidentialMethod: (method: 'standard' | 'optional') => void
  setCommercialBuildingType: (buildingType: CommercialOccupancy) => void
  setActiveTab: (tab: ScheduleTab) => void
  setSelectedPanelId: (panelId: string | null) => void
}

export const useElectricalUi = create<ElectricalUiState>((set) => ({
  occupancy: 'residential',
  residentialMethod: 'standard',
  commercialBuildingType: 'office',
  activeTab: 'schedule',
  selectedPanelId: null,
  setOccupancy: (occupancy) => set({ occupancy }),
  setResidentialMethod: (residentialMethod) => set({ residentialMethod }),
  setCommercialBuildingType: (commercialBuildingType) => set({ commercialBuildingType }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setSelectedPanelId: (selectedPanelId) => set({ selectedPanelId }),
}))
