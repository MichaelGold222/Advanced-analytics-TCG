import { describe, expect, it } from 'vitest'
import { parsePastedSales } from './pastesales'

const NOW = new Date('2026-09-21T00:00:00Z')
const parse = (t: string) => parsePastedSales(t, NOW)

describe('a sales table pasted off a screen', () => {
  it('reads a tab-separated paste, which is what a table copy gives', () => {
    const r = parse('Sep 19, 2026\t$525.00\teBay\nSep 18, 2026\t$568.00\tFanatics')
    expect(r.accepted).toBe(2)
    expect(r.points.map((p) => [p.date, p.price])).toEqual([
      ['2026-09-18', 568], ['2026-09-19', 525],
    ])
  })

  it('reads the date orders these sources actually use', () => {
    const r = parse([
      '2026-09-14  $462',
      '9/16/2026   $525',
      '9/18/26     $568',
      'Sep 19, 2026  $525.50',
      '20 Sep 2026  $530',
    ].join('\n'))
    expect(r.rejected).toBe(0)
    expect(r.points.map((p) => p.date)).toEqual([
      '2026-09-14', '2026-09-16', '2026-09-18', '2026-09-19', '2026-09-20',
    ])
  })

  it('takes the currency figure over a grade sitting beside it', () => {
    // "PSA 10" must not be read as a $10 sale.
    const r = parse('2026-09-19  PSA 10  $525.00  cert 77865285')
    expect(r.points[0].price).toBe(525)
  })

  it('handles thousands separators and a bare number with no symbol', () => {
    expect(parse('2026-09-19  1,250.00').points[0].price).toBe(1250)
    expect(parse('2026-09-19  $21,600').points[0].price).toBe(21600)
  })

  it('marks them as the owner’s own records, not fetched sales', () => {
    // They build the band, but the app did not observe them and must not
    // claim it did.
    expect(parse('2026-09-19  $525').points[0].source).toBe('user')
  })

  it('sorts oldest first however they were pasted', () => {
    const r = parse('2026-09-19 $525\n2026-01-02 $300\n2026-05-05 $400')
    expect(r.points.map((p) => p.date)).toEqual(['2026-01-02', '2026-05-05', '2026-09-19'])
  })
})

describe('what it refuses, and says it refused', () => {
  it('keeps a header row out without silently dropping it', () => {
    const r = parse('Date\tPrice\tVenue\n2026-09-19\t$525')
    expect(r.accepted).toBe(1)
    expect(r.lines.find((l) => l.line.startsWith('Date'))!.problem).toBe('no date on this line')
  })

  it('rejects a date with no price beside it', () => {
    expect(parse('2026-09-19  sold').lines[0].problem).toBe('no price on this line')
  })

  it('rejects a future date rather than letting it into the band', () => {
    const r = parse('2027-01-01  $999')
    expect(r.accepted).toBe(0)
    expect(r.lines[0].problem).toMatch(/in the future/)
  })

  it('drops a repeated line but reports it as a duplicate', () => {
    const r = parse('2026-09-19 $525\n2026-09-19 $525')
    expect(r.accepted).toBe(1)
    expect(r.lines[1].problem).toMatch(/same date and price/)
  })

  it('keeps two sales on one day at different prices', () => {
    expect(parse('2026-09-16 $525\n2026-09-16 $462').accepted).toBe(2)
  })

  it('ignores blank lines instead of reporting them', () => {
    const r = parse('\n\n2026-09-19 $525\n\n')
    expect(r.lines).toHaveLength(1)
  })

  it('reports every line, so nothing vanishes unexplained', () => {
    const r = parse('rubbish\n2026-09-19 $525\nmore rubbish')
    expect(r.lines).toHaveLength(3)
    expect(r.accepted).toBe(1)
    expect(r.rejected).toBe(2)
  })

  it('finds nothing in an empty paste without complaining', () => {
    const r = parse('   \n  ')
    expect(r.points).toHaveLength(0)
    expect(r.lines).toHaveLength(0)
  })

  it('rejects an impossible date rather than rolling it over', () => {
    expect(parse('13/45/2026  $525').lines[0].problem).toBeTruthy()
  })
})
