import { describe, expect, it } from 'vitest'
import { parseCertList } from './fetch-prices'

describe('parseCertList', () => {
  it('reads the format easiest to paste into a secret', () => {
    const { certs } = parseCertList('PSA 12345678\nBGS 87654321\nCGC 11112222')
    expect(certs).toEqual([
      { cert_number: '12345678', grading_company: 'PSA' },
      { cert_number: '87654321', grading_company: 'BGS' },
      { cert_number: '11112222', grading_company: 'CGC' },
    ])
  })

  it('does not care about order or separator', () => {
    for (const input of ['PSA 12345678', '12345678 PSA', '12345678,PSA', 'psa  12345678']) {
      expect(parseCertList(input).certs, input).toEqual([{ cert_number: '12345678', grading_company: 'PSA' }])
    }
  })

  it('accepts a JSON array too', () => {
    const { certs } = parseCertList('[{"cert_number":"12345678","grading_company":"PSA"}]')
    expect(certs).toEqual([{ cert_number: '12345678', grading_company: 'PSA' }])
  })

  it('accepts JSON wrapped under a certs key', () => {
    expect(parseCertList('{"certs":[{"cert":"999","grader":"SGC"}]}').certs)
      .toEqual([{ cert_number: '999', grading_company: 'SGC' }])
  })

  it('prices each slab once, however often it is listed', () => {
    expect(parseCertList('PSA 12345678\nPSA 12345678').certs).toHaveLength(1)
  })

  it('treats the same number under different graders as different slabs', () => {
    expect(parseCertList('PSA 12345678\nBGS 12345678').certs).toHaveLength(2)
  })

  it('rejects graders the endpoint does not accept, and says which', () => {
    const { certs, rejected } = parseCertList('PSA 111\nACE 222\nTAG 333')
    expect(certs).toEqual([{ cert_number: '111', grading_company: 'PSA' }])
    expect(rejected).toContain('ACE')
    expect(rejected).toContain('TAG')
  })

  it('reads several pairs on one comma-separated line', () => {
    expect(parseCertList('PSA 111, BGS 222, CGC 333').certs).toEqual([
      { cert_number: '111', grading_company: 'PSA' },
      { cert_number: '222', grading_company: 'BGS' },
      { cert_number: '333', grading_company: 'CGC' },
    ])
  })

  it('reads pairs written the other way round', () => {
    expect(parseCertList('111 PSA; 222 BGS').certs).toEqual([
      { cert_number: '111', grading_company: 'PSA' },
      { cert_number: '222', grading_company: 'BGS' },
    ])
  })

  it('reports a cert left without a grader rather than guessing one', () => {
    const { certs, rejected } = parseCertList('PSA 111\n222')
    expect(certs).toHaveLength(1)
    expect(rejected).toContain('222')
  })

  it('skips blanks and comment lines', () => {
    const { certs, rejected } = parseCertList('# my slabs\n\nPSA 111\n\n')
    expect(certs).toHaveLength(1)
    expect(rejected).toEqual([])
  })

  it('handles an empty or malformed value without throwing', () => {
    expect(parseCertList('')).toEqual({ certs: [], rejected: [] })
    expect(parseCertList('   ')).toEqual({ certs: [], rejected: [] })
    expect(parseCertList('[not json').certs).toEqual([])
    expect(parseCertList('[not json').rejected[0]).toMatch(/not valid JSON/)
  })

  it('keeps hyphenated cert numbers intact', () => {
    expect(parseCertList('CGC 1234-5678-90').certs)
      .toEqual([{ cert_number: '1234-5678-90', grading_company: 'CGC' }])
  })
})
