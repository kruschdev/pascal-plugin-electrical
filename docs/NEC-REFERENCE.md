# NEC Engineering Reference

All calculations in [`@kruschdev/pascal-plugin-electrical/nec`](../src/nec/index.ts) are deterministic pure TypeScript functions with zero LLM calls.

> **Disclaimer**: This engine is a drafting and engineering aid, not stamped engineering. Always verify calculations, conductor sizing, and local AHJ amendments with a licensed electrical engineer or inspector before construction.

## 1. Service and Feeder Load Calculations (`src/nec/load-calc.ts`)

### Residential Standard Method (`calculateResidentialStandardLoad`)
- **NEC 220.12 / Table 220.42**: General lighting and receptacles at `3 VA/sq ft`, plus `2 x 1,500 VA` small-appliance circuits (`220.52(A)`) and `1 x 1,500 VA` laundry circuit (`220.52(B)`). Applies Table 220.42 demand tiers (`100%` first `3,000 VA`, `35%` from `3,001` to `120,000 VA`, `25%` remainder).
- **NEC 220.53**: Fixed-in-place appliances (`75%` demand when 4 or more appliances are connected).
- **NEC 220.54**: Electric clothes dryer at minimum `5,000 VA` or nameplate rating.
- **NEC Table 220.55**: Electric ranges with Column A (`< 3.5 kW`), Column B (`3.5 kW` to `8.75 kW`), Column C (`8.75 kW` to `12 kW`, `8,000 VA` for 1 range), and Note 1 (`+5%` per kW above `12 kW`).
- **NEC 220.60**: Non-coincident heating vs. cooling loads (larger of HVAC heating or cooling).
- **NEC 220.50 / 430.24**: `+25%` of the largest motor load.
- **NEC 625.41**: EVSE continuous charging load at `125%` (or full nameplate at `100%` service demand as configured).

### Residential Optional Method (`calculateResidentialOptionalLoad`, NEC 220.82)
- Sums general lighting (`3 VA/sq ft`), small appliances, laundry, fixed appliances, range, and dryer: applies `100%` to the first `10,000 VA` and `40%` to the remainder (`220.82(B)`).
- Applies **NEC 220.82(C)** HVAC demand factors (`100%` for A/C and heat pump compressor loads per `220.82(C)(2)`, `65%` for 4+ separately controlled electric space heaters, `40%` for central electric furnace).

### Solar PV 120% Busbar Rule (`NEC 705.12(B)(3)(2)`) and Scene Load Aggregation
$$\text{Max PV Backfeed Breaker} = 1.2 \times I_{\text{bus}} - I_{\text{main}}$$
Flags an error whenever `solarBackfeedAmps` exceeds the permitted busbar backfeed limit. `calculateSceneLoad` aggregates all 25 live equipment kinds (including `usb-duplex`, `weatherproof-gfci`, `floor-box`, `vfd`, `battery-ess`, and `solar-inverter`) and automatically infers `solarBackfeedAmps` from placed `solar-inverter` nodes when the panel's explicit backfeed field is unset.

### Commercial Load Calculations (`calculateCommercialLoad`)
- **NEC Table 220.12**: Lighting VA/sq ft by occupancy (`office`, `retail`, `warehouse`, `restaurant`, `school`, `healthcare`, `industrial`, `garage`) multiplied by `125%` continuous load factor (`NEC 215.2`).
- **NEC 220.14(I) and Table 220.44**: General receptacles at `180 VA` per strap (`100%` first `10,000 VA`, `50%` remainder).
- **NEC 430.24**: Motor loads summed at `100%` plus `25%` of the largest motor.
- **NEC Table 450.3(B)**: Dry-type step-down transformer primary/secondary FLA (`calculateTransformerSizing`) and maximum OCPD sizing (`125%` next standard size up).

## 2. Conductor Ampacity, Conduit Fill, Box Fill and Voltage Drop (`src/nec/sizing.ts`)

| Calculator | NEC Basis | Key Rules Enforced |
|---|---|---|
| `calculateDeratedAmpacity` | Table 310.16, 310.15(B)(1), 310.15(C)(1), 334.80, 240.4(D) | Copper and Aluminum `60C`/`75C`/`90C` base ratings; ambient temperature correction; rooftop `+33C` adder; bundling derating (`4-6: 80%`, `7-9: 70%`, `10-20: 50%`); NM-B derates from `90C` but caps final allowable ampacity at `60C` (`334.80`); small-conductor OCPD limits (`#14 Cu <= 15A`, `#12 Cu <= 20A`, `#10 Cu <= 30A`, `240.4(D)`) |
| `calculateConduitFill` | Chapter 9 Tables 1, 4, and 5 | `53%` (1 wire), `31%` (2 wires), `40%` (3+ wires), and `60%` nipple exception (`<= 24"`) for `EMT`, `PVC-40`, and `RMC` (`1/2"` through `4"`) |
| `calculateBoxFill` | Table 314.16(A) and 314.16(B) | Counts current-carrying conductors across `#14` through `750kcmil` (`clampToBoxFillGauge`), `2x` allowance per device yoke, `1x` internal clamp allowance (largest wire), `1x` equipment ground allowance (up to 4 EGCs, `+0.25x` per additional EGC per 2020/2023 NEC). Integral-enclosure gear (`usesSeparateRoughInBox`: `evse`, `battery-ess`, `solar-inverter`, `transfer-switch`, `weatherproof-gfci`, `floor-box`, `vfd`, `spd-type2`, `generator-inlet`, `pv-rapid-shutdown`, `motor-3p`) skips gang-box fill and rough-in box BOM counts |
| `calculateVoltageDrop` | Chapter 9 Table 8 / NEC 210.19 & 215.2 | Single-phase (`2 * K * I * L / CM`) and three-phase (`1.732 * K * I * L / CM`) drop using actual 3D routed path length; recommends upsized gauge above `3%` |

## 3. NEC Minimum Auto-Populate (`src/nec/autopopulate.ts`)

`planNecAutoPopulate` inspects Pascal walls, exterior doors, stairways, and room zones to generate a complete code-minimum layout:

| Location / Feature | NEC Citation | Auto-Populated Equipment and Wiring |
|---|---|---|
| Habitable room walls (`Living`, `Bedroom`, `Dining`, `Office`, `Hall`) | `NEC 210.52(A)` | General receptacles spaced so no wall point is `> 6 ft` from an outlet (max `12 ft` spacing), assigned to balanced 15A/20A AFCI circuits (`NEC 210.12(A)`) |
| Kitchen countertops | `NEC 210.52(C)` & `210.11(C)(1)` | Countertop GFCI receptacles (`<= 4 ft` spacing) split across **two dedicated 20A Small-Appliance Branch Circuits (SAB-1 and SAB-2)** |
| Bathrooms | `NEC 210.52(D)` & `210.11(C)(3)` | Dedicated 20A GFCI vanity receptacle on its own isolated bathroom circuit |
| Laundry, Garage, Basement | `NEC 210.52(F)-(G)` & `210.8(A)` | Dedicated 20A GFCI receptacles in laundry and garage zones |
| Exterior / Outdoor / Front Door | `NEC 210.52(E)` & `210.70(A)(2)(b)` | Weather-resistant outdoor GFCI receptacle, front-door interior entry outlet, entry switch, and exterior sconce/light |
| Stairways | `NEC 210.70(A)(2)(c)` | Top and bottom 3-way switches (`switch-3way`), stairway luminaire, and landing receptacle |
| Hardwired Smoke / CO Alarms | `IRC R314.3` / `R314.4` / `R315.3` & `NFPA 72 A.29.9.4` | Hardwired 120V ceiling-mounted `smoke-co` alarms inside every bedroom, outside sleeping areas (hallway/living), and at least 1 per residential story; chained via `14/3` interconnect (`4` conductors incl. red signal wire & ground) on a single **non-GFCI 15A AFCI** circuit shared with the primary hallway or living-area pilot light so a tripped breaker is immediately visible |
| Protection Modes | `NEC 210.8` & `210.12` | Selectable `hybrid` (GFCI receptacles + AFCI breakers), `gfci-breakers` (panel GFCI/AFCI breakers), or `gfci-receptacles` (point-of-use GFCI devices) |
| Framing & Stud-Bay Alignment | `@pascal-app/plugin-bones` & `NEC 210.52` | Reads optional `bones:framing` (`16" OC` / `24" OC`, `wallOverrides` including `cmu` bypass) and `bones:service` (`panel`) nodes to mount `MDP-1` cleanly inside a stud bay and snap every nail-on outlet, GFCI, and switch flush against the side face of a stud, clamped to remaining `NEC 210.52(A)/(C)` spacing slack |
| Branch Circuit Wiring | `NEC 358.26` & Trade Priority | Automatically generates 10-color-coded **Home Runs** (`Panel -> First Device`) and **Outlet-to-Outlet Daisy-Chain Runs** (`Device i -> Device i+1`) that detour around plumbing, HVAC, and structural obstacles |

## 4. Live Prohibited-Location and Code Compliance Auditor (`src/nec/audit.ts`)

`auditSceneElectrical` runs continuously in the Inspector card and Left-Rail Panel to catch non-code placements immediately. All room, wet-fixture, stairway, dedicated-circuit, and trade-obstacle checks are strictly scoped to each node's owning level (`resolveNodeLevelId` / `belongsToLevel`), and both `gfci` and `weatherproof-gfci` satisfy wet-zone GFCI requirements:

| NEC Reference | Category | Condition Flagged |
|---|---|---|
| `NEC 110.26(A)` | `working-space` | Cabinet, furniture, column, or equipment intruding into the `30"W x 36"/42"/48"D x 78"H` front working space of a panel or transformer (local-yaw 2D SAT) |
| `NEC 110.26(E)` | `dedicated-space` | Foreign plumbing pipe or HVAC duct passing directly above a panelboard or transformer footprint (`6 ft` overhead zone) |
| `NEC 240.24(A)` | `prohibited-location` | Highest panel breaker handle exceeds `6'-7"` (`2.007 m`) AFF |
| `NEC 240.24(D)` | `prohibited-location` | Panelboard placed inside a clothes closet or wardrobe |
| `NEC 240.24(E)` | `prohibited-location` | Panelboard placed inside a bathroom, restroom, or showering zone |
| `NEC 240.24(F)` | `prohibited-location` | Panelboard mounted over stairway steps |
| `NEC 312.2` / `450.22` | `prohibited-location` | Indoor `NEMA-1` panel or indoor `NEMA-1`/`NEMA-2` transformer placed in an outdoor or wet zone |
| `NEC 406.9(C)` | `prohibited-location` | Receptacle inside the `3 ft` horizontal by `8 ft` vertical bathtub or shower zone |
| `NEC 404.4(C)` | `prohibited-location` | Wall switch installed inside a bathtub or shower enclosure (`<= 0.15 m`) |
| `NEC 410.10(D)` | `prohibited-location` | Luminaire mounted below `8 ft` (`2.438 m`) inside the `3 ft` bathtub or shower zone |
| `NEC 210.52(C)` / `110.11` | `prohibited-location` | Receptacle placed directly over a stove, range, or cooktop |
| `NEC 406.5(E)` | `prohibited-location` | Receptacle placed inside a sink or lavatory basin footprint |
| `NEC 410.16(C)` | `prohibited-location` | Closet luminaire mounted below `2.1 m` in clothes storage clearance |
| `NEC 210.11(C)(1)` / `(3)` | `prohibited-location` | Dedicated 20A bathroom or kitchen small-appliance circuit mixed with bedroom, living room, or hallway outlets |
| `NEC 210.8(A)/(B)` & `210.12(A)` | `gfci-afci` | Missing GFCI in wet/damp zones or missing AFCI in residential habitable zones |
| `NEC 334.12` / `300.22(C)` | `wiring-method` | NM-B (Romex) cable used in commercial construction or air-handling plenums |
| `NEC 358.26` | `raceway-bends` | Conduit run exceeds `360` total degrees of bends between pull points |
| `NEC 408.36` / `408.54` / `408.30` | `panel-load` | Breaker slot collisions, multi-pole panel space overflow, bus overload (`> 100%`), `> 80%` continuous load warning, or `> 20%` phase imbalance |
| `NFPA 72 29.9.4(5)` / `A.29.9.4` & `IRC R314` / `R315` | `life-safety` | Smoke/CO alarm on a GFCI circuit (error), dedicated smoke-only circuit without a frequently-used pilot lighting load (warning), smoke/CO alarms split across multiple circuits breaking `14/3` interconnect (warning), or bedrooms / sleeping areas missing hardwired Smoke/CO alarms (warning) |
| `TRADE-PRIORITY` | `trade-clash` | Electrical run intersects a Pascal plumbing pipe, HVAC duct, HVAC equipment, beam, or column |
