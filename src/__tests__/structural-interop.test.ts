import { describe, expect, test } from 'bun:test'
import { extractBonesFramingContext } from '../nec/framing-interop'
import { extractTradeObstacles } from '../nec/routing'

describe('Priority #1 @kruschdev/pascal-plugin-structural Interop (Electrical)', () => {
  test('prefers structural:assembly over bones:framing and reads 12"/16"/24" OC + shear-wall overrides', () => {
    const nodes = {
      lvl1: { id: 'lvl1', type: 'level' },
      bones1: { id: 'bones1', type: 'bones:framing', parentId: 'lvl1', studSpacingIn: 24 },
      str1: {
        id: 'str1',
        type: 'structural:assembly',
        parentId: 'lvl1',
        studSpacingIn: 12,
        wallOverrides: {
          w_shear: { construction: 'shear-wall', studSpacingIn: 12, isShearWall: true },
          w_cmu: { construction: 'cmu' },
        },
      },
    }
    const ctx = extractBonesFramingContext(nodes, 'lvl1')
    expect(ctx.present).toBe(true)
    expect(ctx.source).toBe('structural')
    expect(ctx.defaultSpacingIn).toBe(12)
    expect(ctx.wallRules.get('w_shear')?.isShearWall).toBe(true)
    expect(ctx.wallRules.get('w_cmu')?.construction).toBe('cmu')
  })

  test('extracts structural:beam and structural:column as Priority #1 trade obstacles', () => {
    const nodes = {
      lvl1: { id: 'lvl1', type: 'level' },
      bm1: {
        id: 'bm1',
        type: 'structural:beam',
        parentId: 'lvl1',
        start: [0, 3],
        end: [6, 3],
        elevationY: 2.4,
        widthIn: 5.25,
        depthIn: 14,
        designation: '(3) 1-3/4"x14" 2.0E LVL',
      },
      col1: {
        id: 'col1',
        type: 'structural:column',
        parentId: 'lvl1',
        position: [0, 0, 3],
        widthIn: 5.5,
        depthIn: 5.5,
        heightM: 2.74,
        designation: '6x6 DF-L #2 Post',
      },
    }
    const obs = extractTradeObstacles(nodes, 'lvl1')
    expect(obs.some((o) => o.nodeId === 'bm1' && o.priorityRank === 1 && o.trade === 'structural')).toBe(true)
    expect(obs.some((o) => o.nodeId === 'col1' && o.priorityRank === 1 && o.trade === 'structural')).toBe(true)
  })

  test('R1-BUG-07: subdivides diagonal structural:beam into tight sub-AABBs instead of room-sized box', () => {
    const nodes = {
      lvl1: { id: 'lvl1', type: 'level' },
      bm_diag: {
        id: 'bm_diag',
        type: 'structural:beam',
        parentId: 'lvl1',
        start: [0, 0],
        end: [6, 6],
        elevationY: 2.5,
        widthIn: 3.5,
        depthIn: 11.875,
        designation: 'Diagonal Hip Beam',
      },
    }
    const obs = extractTradeObstacles(nodes, 'lvl1').filter((o) => o.nodeId === 'bm_diag')
    expect(obs.length).toBeGreaterThanOrEqual(4)
    // Far off-diagonal corner (0, 2.5, 6) should not be blocked by the diagonal beam
    const blocksCorner = obs.some(
      (o) =>
        0 >= o.box.min[0] &&
        0 <= o.box.max[0] &&
        2.5 >= o.box.min[1] &&
        2.5 <= o.box.max[1] &&
        6 >= o.box.min[2] &&
        6 <= o.box.max[2],
    )
    expect(blocksCorner).toBe(false)
  })
})
